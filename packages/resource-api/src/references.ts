/**
 * Reference validation: verifies that id fields on a resource's spec point
 * at existing resources before persist. Port of the Go edition's
 * ValidateReferencesStep (backend/libs/go/grpc/request/pipeline/steps/
 * validate_references.go), forced by the first multi-resource consumer
 * (T03: five of six law resources carry a case/task/user reference).
 *
 * Recorded divergence from the Go parent: references are declared
 * explicitly per resource (an extractor per field) instead of discovered
 * by walking the spec for ApiResourceReference messages — the consuming
 * products here use plain string id fields, so there is no reference
 * message type to discover.
 *
 * Error code follows the parent: FAILED_PRECONDITION, not NOT_FOUND (that
 * is reserved for the *target* of an operation) and not INVALID_ARGUMENT
 * (the request is well-formed; the system's state doesn't support it).
 * Empty extractions skip — optional references validate only when set.
 */

import type { ResourceMessage } from "./envelope.js";
import { failedPrecondition } from "./errors.js";
import type { PipelineStep } from "./pipeline.js";
import type { WriteContext } from "./resource.js";
import type { ResourceStore } from "./store/store.js";

export interface ResourceReference<R extends ResourceMessage> {
  /** Kind of the referenced resource as registered with the store, e.g. "Case". */
  readonly kind: string;
  /** Human label for the error message, e.g. "case" or "assignee". */
  readonly label: string;
  /** Extracts the referenced id; empty/undefined means "not set", which skips. */
  readonly get: (resource: R) => string | undefined;
}

/**
 * A beforePersist step for create and update chains: runs after
 * build-new-state, so it validates exactly what would be persisted.
 */
export function referencesExistStep<R extends ResourceMessage>(
  store: ResourceStore,
  references: readonly ResourceReference<R>[],
): PipelineStep<WriteContext<R>> {
  return {
    name: "check-references",
    async execute(ctx) {
      const missing: string[] = [];
      for (const reference of references) {
        const id = reference.get(ctx.newState as R);
        if (!id) continue;
        if (!(await store.getById(reference.kind, id))) {
          missing.push(`${reference.label} '${id}'`);
        }
      }
      if (missing.length > 0) {
        // All misses reported in one round trip (the Go parent collects
        // too): a client fixing references should not play whack-a-mole.
        throw failedPrecondition(`Referenced ${missing.join(", ")} not found`);
      }
    },
  };
}
