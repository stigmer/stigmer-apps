/**
 * The periodic tuple reconcile (DD-003 D1a) — the drift backstop behind
 * same-request tuple sync. Same-request sync can miss exactly one way
 * (a contained engine failure or a crash between persist and the sync
 * step); this loop heals both directions within one interval, and the
 * boot-time reconcile (main.ts) covers everything older. The
 * reminder-sweep loop shape: survive failures, retry next tick, never
 * hold a closing process open.
 *
 * Multi-replica safe by convergence: reconcile writes the SAME desired
 * set from the same rows, and the engine's writes are idempotent — two
 * replicas racing produce the fixed point, not a conflict.
 */

import type { ResourceStore } from "@stigmer/resource-api";
import { reconcileTuples, type AuthorizationEngine } from "@stigmer/authorization";
import { projectAuthorizationTuples } from "./tuples.js";

export async function reconcileAuthzOnce(
  store: ResourceStore,
  engine: AuthorizationEngine,
): Promise<void> {
  const result = await reconcileTuples(engine, await projectAuthorizationTuples(store));
  if (result.written > 0 || result.deleted > 0) {
    // Non-zero outside boot means same-request sync missed something —
    // worth a trace even though the system self-healed.
    console.warn(
      `authz tuple reconcile healed drift: +${result.written} -${result.deleted}`,
    );
  }
}

export function startAuthzReconcileLoop(
  store: ResourceStore,
  engine: AuthorizationEngine,
  intervalMs: number,
): () => void {
  const tick = () =>
    reconcileAuthzOnce(store, engine).catch((err) => {
      console.error("authz tuple reconcile failed (retrying next tick):", err);
    });
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never hold the process open just to reconcile
  return () => clearInterval(timer);
}
