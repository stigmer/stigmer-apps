/**
 * @stigmer/authorization — shared FGA authorization machinery for
 * Stigmer vertical apps.
 *
 * Owns the engine seam: an OpenFGA-backed AuthorizationEngine (check /
 * list-objects / idempotent tuple writes), the store+model bootstrap,
 * and the set-diff tuple reconciler. Deliberately NOT a policy layer —
 * each app's policy module decides which relationship question an
 * operation asks (DD-A5); this package only answers it. Models are
 * app-owned DSL; nothing in here knows any vertical's vocabulary.
 *
 * The test harness (an OpenFGA testcontainer) lives under
 * `@stigmer/authorization/testing`.
 */

export type { TupleKey } from "./tuples.js";
export { idOf, ref, tupleId } from "./tuples.js";

export type { AuthorizationEngine } from "./engine.js";
export { createOpenFgaEngine } from "./engine.js";

export type {
  BootstrapOptions,
  BootstrappedAuthorization,
  OpenFgaConnection,
} from "./bootstrap.js";
export { bootstrapAuthorization } from "./bootstrap.js";

export type { ReconcileResult } from "./reconcile.js";
export { reconcileTuples } from "./reconcile.js";
