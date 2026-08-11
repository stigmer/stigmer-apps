/**
 * Set-diff tuple reconciliation: make the engine's tuples equal an
 * app-computed desired set. The desired set is a pure projection of the
 * app's own rows, so the engine is always a REBUILDABLE INDEX of the
 * database, never a second source of truth — the design that makes
 * running two stores survivable (project DD-003 D1/D1a; the
 * stigmer-cloud VisibilityTupleReconciler is the parent pattern).
 *
 * Callers run this on boot and on a schedule; between runs the app
 * keeps tuples current synchronously in its write pipeline. Reconcile
 * heals whatever those in-request writes missed (crash windows, failed
 * engine calls) in both directions — missing grants appear, stale
 * grants disappear.
 */

import type { AuthorizationEngine } from "./engine.js";
import { tupleId, type TupleKey } from "./tuples.js";

export interface ReconcileResult {
  readonly written: number;
  readonly deleted: number;
}

export async function reconcileTuples(
  engine: AuthorizationEngine,
  desired: readonly TupleKey[],
): Promise<ReconcileResult> {
  const actual = await engine.readAll();

  const desiredById = new Map(desired.map((t) => [tupleId(t), t]));
  const actualIds = new Set(actual.map(tupleId));

  const writes = [...desiredById.entries()]
    .filter(([id]) => !actualIds.has(id))
    .map(([, t]) => t);
  const deletes = actual.filter((t) => !desiredById.has(tupleId(t)));

  await engine.write({ writes, deletes });
  return { written: writes.length, deleted: deletes.length };
}
