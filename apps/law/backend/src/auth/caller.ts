/**
 * Caller extraction — the transport half of authentication.
 *
 * T02 INTERIM SEAM: identity comes from the `x-lawfirm-user-id` header,
 * which is only acceptable because this backend is not deployed anywhere
 * yet. T04 replaces this function's body with JWT verification (bcrypt
 * login issues the token); the signature and every call site stay
 * unchanged — that is the point of the seam.
 */

import type { HandlerContext } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";

export function callerFromRequest(ctx: HandlerContext): CallerPrincipal | undefined {
  const id = ctx.requestHeader.get("x-lawfirm-user-id");
  if (!id) {
    return undefined;
  }
  const kind = ctx.requestHeader.get("x-lawfirm-user-kind");
  return {
    id,
    kind: kind === "operator" || kind === "system" ? kind : "user",
  };
}
