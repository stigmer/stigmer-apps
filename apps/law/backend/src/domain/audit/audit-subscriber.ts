/**
 * The audit subscriber (FR-AUDIT-001, Gate-1 Q8): diffs every event on
 * the record-bearing kinds into a system-written AuditEntry — who, when,
 * created-or-updated, field-level delta.
 *
 * RECORDED LIMITATION (owner-signed with the contract): the publisher is
 * best-effort — a crash between persist and publish loses the event and
 * hence the entry. Accepted while production holds only fictional data
 * (real data is gated behind T07); the durable dispatcher is the
 * publisher's own named revisit point.
 *
 * What is audited: spec fields, plus the deliberate status transitions
 * (lifecycle, state, outcomeKind — the human acts). The stored-derived
 * next_hearing_date is EXCLUDED (system bookkeeping, not history), and
 * Case events whose actor is the system principal (the Q6 refresh) are
 * skipped entirely — an empty delta writes nothing.
 *
 * Idempotent by the entry's natural key `{kind}:{id}:v{version}`:
 * duplicate delivery answers ALREADY_EXISTS and is dropped here.
 */

import { create, toJson } from "@bufbuild/protobuf";
import type { DescMessage } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  CallerPrincipal,
  InProcessEventDispatcher,
  ResourceEvent,
} from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import {
  AuditEntrySchema,
  ChangeType,
  FieldChangeSchema,
  type AuditEntry,
  type FieldChange,
} from "../../gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { CaseSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { DeadlineSchema } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { FeeArrangementSchema } from "../../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import { HearingSchema } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { LedgerEntrySchema } from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";

/** The record-bearing kinds and how each reaches its case. */
const AUDITED: Readonly<
  Record<string, { schema: DescMessage; caseId: (json: AuditedJson, id: string) => string }>
> = {
  Case: { schema: CaseSchema, caseId: (_json, id) => id },
  Hearing: { schema: HearingSchema, caseId: (json) => json.spec?.caseId ?? "" },
  Deadline: { schema: DeadlineSchema, caseId: (json) => json.spec?.caseId ?? "" },
  FeeArrangement: { schema: FeeArrangementSchema, caseId: (json) => json.spec?.caseId ?? "" },
  LedgerEntry: { schema: LedgerEntrySchema, caseId: (json) => json.spec?.caseId ?? "" },
};

/** The audited status transitions; everything else in status is derived
 * or system bookkeeping. */
const AUDITED_STATUS_FIELDS = new Set(["lifecycle", "state", "outcomeKind"]);

interface AuditedJson {
  spec?: Record<string, unknown> & { caseId?: string };
  status?: Record<string, unknown>;
}

export function registerAuditSubscriber(
  dispatcher: InProcessEventDispatcher,
  createEntry: (input: AuditEntry, caller: CallerPrincipal) => Promise<AuditEntry>,
): void {
  dispatcher.subscribe("*", async (event) => {
    const audited = AUDITED[event.kind];
    if (!audited) return;
    // The Q6 refresh: a system write to Case is bookkeeping, not history.
    if (event.kind === "Case" && event.actor.kind === "system") return;

    const entry = buildEntry(event, audited);
    if (!entry) return;

    try {
      await createEntry(entry, SYSTEM_PRINCIPAL);
    } catch (err) {
      if (ConnectError.from(err).code === Code.AlreadyExists) {
        return; // duplicate delivery — one entry per version, by design
      }
      throw err; // dispatcher contains and logs; the audited write stands
    }
  });
}

function buildEntry(
  event: ResourceEvent,
  audited: (typeof AUDITED)[string],
): AuditEntry | undefined {
  const id = event.resource.metadata?.id ?? "";
  const version = event.resource.metadata?.version ?? 0n;
  const json = toJson(audited.schema, event.resource as never) as AuditedJson;

  let changeType: ChangeType;
  let changes: FieldChange[] = [];
  if (event.type === "created") {
    changeType = ChangeType.CREATED;
  } else {
    changeType = ChangeType.UPDATED;
    const previous = event.previous
      ? (toJson(audited.schema, event.previous as never) as AuditedJson)
      : undefined;
    changes = [
      ...diffFlat("spec", previous?.spec, json.spec, () => true),
      ...diffFlat("status", previous?.status, json.status, (field) =>
        AUDITED_STATUS_FIELDS.has(field),
      ),
    ];
    if (changes.length === 0) {
      return undefined; // nothing history-worthy changed
    }
  }

  return create(AuditEntrySchema, {
    spec: {
      subjectKind: event.kind,
      subjectId: id,
      caseId: audited.caseId(json, id),
      changeType,
      actorId: event.actor.id,
      actorKind: event.actor.kind,
      changes,
      dedupKey: `${event.kind}:${id}:v${version}`,
    },
  });
}

/**
 * Field-level delta over proto3 JSON: scalars compare directly;
 * structured values (party arrays, forum blocks) compare and render as
 * their JSON text — the history shows what a human would want quoted
 * back, not a patch format.
 */
function diffFlat(
  root: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  include: (field: string) => boolean,
): FieldChange[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!include(field)) continue;
    const oldValue = renderValue(before?.[field]);
    const newValue = renderValue(after?.[field]);
    if (oldValue !== newValue) {
      changes.push(
        create(FieldChangeSchema, { fieldPath: `${root}.${field}`, oldValue, newValue }),
      );
    }
  }
  return changes;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
