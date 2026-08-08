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

import type { IncomingMessage } from "node:http";
import type { HandlerContext } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";

export function callerFromRequest(ctx: HandlerContext): CallerPrincipal | undefined {
  return fromHeaderValues(
    ctx.requestHeader.get("x-dev-caller-id"),
    ctx.requestHeader.get("x-dev-caller-kind"),
  );
}

/**
 * The same identity seam for the plain-HTTP file routes (upload/download
 * carry bytes, so they live beside Connect — T03 D6). One header
 * convention, two transports; T04's JWT replaces both bodies together.
 */
export function callerFromHttpRequest(req: IncomingMessage): CallerPrincipal | undefined {
  const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return fromHeaderValues(
    single(req.headers["x-dev-caller-id"]) ?? null,
    single(req.headers["x-dev-caller-kind"]) ?? null,
  );
}

function fromHeaderValues(
  id: string | null,
  kind: string | null,
): CallerPrincipal | undefined {
  if (!id) {
    return undefined;
  }
  return {
    id,
    kind: kind === "operator" || kind === "system" ? kind : "user",
  };
}
