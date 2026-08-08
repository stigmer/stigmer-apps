/**
 * Envelope stamping: the system-managed parts of a resource (identity,
 * audit, version) are always written here and never trusted from input —
 * whatever a client sends in `metadata` or `status` is discarded or
 * recomputed (the parents' clear-status / preserve-immutable pattern).
 */

import { clone, create, type DescField, type DescMessage } from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ResourceMessage } from "./envelope.js";
import { ActorSchema, ResourceMetadataSchema } from "./envelope.js";
import { generateResourceId } from "./id.js";
import { internal } from "./errors.js";
import type { CallerPrincipal } from "./principal.js";

export interface EnvelopeIdentity {
  readonly apiVersion: string;
  readonly kind: string;
  readonly idPrefix: string;
}

/**
 * Builds the persisted state for a create: clone of the input with
 * identity fields set, a fresh id, version 1, both audit pairs stamped to
 * the caller, and any client-sent status cleared (status is
 * system-managed).
 */
export function buildCreateState<R extends ResourceMessage>(
  schema: DescMessage,
  identity: EnvelopeIdentity,
  input: R,
  caller: CallerPrincipal,
  now: Date,
): R {
  const state = clone(schema, input as never) as R;
  state.apiVersion = identity.apiVersion;
  state.kind = identity.kind;
  clearStatus(schema, state);

  const actor = create(ActorSchema, { id: caller.id });
  const at = timestampFromDate(now);
  state.metadata = create(ResourceMetadataSchema, {
    id: generateResourceId(identity.idPrefix),
    version: 1n,
    createdAt: at,
    createdBy: actor,
    updatedAt: at,
    updatedBy: actor,
  });
  return state;
}

/**
 * Builds the persisted state for an update: full spec replacement from the
 * input (client sends complete desired state — the parents' merge
 * strategy), identity and create-audit preserved from the existing row,
 * version incremented, stored status carried over from existing so a
 * client update can never clobber system-managed state.
 *
 * No optimistic concurrency: the products' contracts don't require it
 * (last write wins), and neither parent implements it. The version counter
 * makes adding a compare-and-swap here a local change later.
 */
export function buildUpdateState<R extends ResourceMessage>(
  schema: DescMessage,
  identity: EnvelopeIdentity,
  input: R,
  existing: R,
  caller: CallerPrincipal,
  now: Date,
): R {
  const existingMeta = existing.metadata;
  if (!existingMeta) {
    throw internal(`Stored ${identity.kind} is missing metadata (data corruption?)`);
  }

  const state = clone(schema, input as never) as R;
  state.apiVersion = identity.apiVersion;
  state.kind = identity.kind;
  copyStatus(schema, existing, state);

  state.metadata = create(ResourceMetadataSchema, {
    id: existingMeta.id,
    version: existingMeta.version + 1n,
    createdAt: existingMeta.createdAt,
    createdBy: existingMeta.createdBy,
    updatedAt: timestampFromDate(now),
    updatedBy: create(ActorSchema, { id: caller.id }),
  });
  return state;
}

/**
 * Update stamping for custom operations that legitimately mutate stored
 * status (e.g. an updateStatus operation): audit/version handling of an
 * update, but the (already mutated) status of `state` is kept as-is.
 */
export function stampCustomMutation<R extends ResourceMessage>(
  identity: EnvelopeIdentity,
  state: R,
  caller: CallerPrincipal,
  now: Date,
): R {
  const meta = state.metadata;
  if (!meta) {
    throw internal(`${identity.kind} is missing metadata (data corruption?)`);
  }
  state.metadata = create(ResourceMetadataSchema, {
    id: meta.id,
    version: meta.version + 1n,
    createdAt: meta.createdAt,
    createdBy: meta.createdBy,
    updatedAt: timestampFromDate(now),
    updatedBy: create(ActorSchema, { id: caller.id }),
  });
  return state;
}

function statusField(schema: DescMessage): DescField | undefined {
  return schema.fields.find((f) => f.localName === "status");
}

function clearStatus(schema: DescMessage, state: ResourceMessage): void {
  const field = statusField(schema);
  if (field) {
    reflect(schema, state as never).clear(field);
  }
}

function copyStatus(schema: DescMessage, from: ResourceMessage, to: ResourceMessage): void {
  const field = statusField(schema);
  if (!field) return;
  const source = reflect(schema, from as never);
  const target = reflect(schema, to as never);
  if (source.isSet(field)) {
    target.set(field, source.get(field));
  } else {
    target.clear(field);
  }
}
