/**
 * The step/pipeline core: an ordered chain of named steps sharing a typed
 * context, halting on the first failure. Ported from the parents
 * (Go `PipelineStep[T]` / Java `RequestPipelineStepV2`) with two TypeScript
 * adaptations: failures are thrown (ConnectError for anything
 * client-reachable), and the context is a typed object per operation, not
 * a stringly-keyed map.
 */

import { ConnectError } from "@connectrpc/connect";
import { internal } from "./errors.js";

/**
 * Traits drive the ordering invariant below. Steps that load the target
 * resource declare "existence-check"; steps that consult the authorization
 * policy declare "authorization".
 */
export type StepTrait = "existence-check" | "authorization";

export interface PipelineStep<C> {
  readonly name: string;
  readonly traits?: readonly StepTrait[];
  execute(ctx: C): Promise<void> | void;
}

export class Pipeline<C> {
  readonly #name: string;
  readonly #steps: readonly PipelineStep<C>[];

  constructor(name: string, steps: readonly PipelineStep<C>[]) {
    assertExistenceBeforeAuthorization(name, steps);
    this.#name = name;
    this.#steps = steps;
  }

  async execute(ctx: C): Promise<void> {
    for (const step of this.#steps) {
      try {
        await step.execute(ctx);
      } catch (err) {
        if (err instanceof ConnectError) {
          // Typed errors pass through with code and message intact — the
          // step already said everything the client should hear. The
          // pipeline/step context goes to the log, never the wire (the
          // Java edition strips its "step X failed" prefix the same way).
          console.error(`pipeline ${this.#name}: step ${step.name} failed:`, err.message);
          throw err;
        }
        // Anything untyped is a bug, not a client condition: INTERNAL,
        // never UNKNOWN (the Go edition shipped that lesson after a bare
        // error surfaced as UNKNOWN across every create path).
        console.error(`pipeline ${this.#name}: step ${step.name} threw untyped error:`, err);
        throw internal(`Internal error in ${this.#name}`, err);
      }
    }
  }
}

/**
 * Port of the Java `PipelineOrderingInvariant`, machine-enforced at
 * construction: when a chain contains both an existence-check step and an
 * authorization step, the existence check must come first, so a missing
 * resource answers NOT_FOUND rather than PERMISSION_DENIED — a nonexistent
 * resource has no grants to check (stigmer/stigmer#224). Under a
 * permissive policy the ordering barely matters; it is encoded now so the
 * day a grant-based policy lands, no chain needs auditing.
 */
function assertExistenceBeforeAuthorization<C>(
  name: string,
  steps: readonly PipelineStep<C>[],
): void {
  const firstExistence = steps.findIndex((s) => s.traits?.includes("existence-check"));
  const firstAuthorization = steps.findIndex((s) => s.traits?.includes("authorization"));
  if (firstExistence !== -1 && firstAuthorization !== -1 && firstAuthorization < firstExistence) {
    throw new Error(
      `Pipeline '${name}' places authorization ('${steps[firstAuthorization]?.name}') before ` +
        `the existence check ('${steps[firstExistence]?.name}'). Load must precede authorize ` +
        `so missing resources answer NOT_FOUND, not PERMISSION_DENIED.`,
    );
  }
}
