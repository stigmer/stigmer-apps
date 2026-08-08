/**
 * Caller extraction — the transport half of authentication.
 *
 * T02 INTERIM SEAM: identity comes from the `x-dev-caller-id` header. The
 * `x-dev-` prefix is deliberate — this is a development shim, not
 * production auth, and the name makes that impossible to miss (and trivial
 * to grep for when it is deleted). Acceptable only because this backend is
 * not deployed anywhere yet; the caller *kind* (user/operator/system) is
 * client-asserted here, so the policy module's privilege branches are only
 * as strong as this seam until real auth lands. T04 replaces this
 * function's body with JWT verification (bcrypt login issues the token);
 * the signature and every call site stay unchanged — that is the point of
 * the seam.
 */

import type { HandlerContext } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";

export function callerFromRequest(ctx: HandlerContext): CallerPrincipal | undefined {
  const id = ctx.requestHeader.get("x-dev-caller-id");
  if (!id) {
    return undefined;
  }
  const kind = ctx.requestHeader.get("x-dev-caller-kind");
  return {
    id,
    kind: kind === "operator" || kind === "system" ? kind : "user",
  };
}
