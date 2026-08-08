/**
 * Caller resolution for both transport entrances — the replacement for
 * the T02 `x-dev-caller-*` shim, same dual shape: Connect handlers and
 * the plain-HTTP byte routes resolve callers through ONE chain, so "one
 * policy, N enforcement points" keeps a single authentication story too.
 *
 * Tested invariant (DD-005): nothing here can produce the system
 * principal. Bearer tokens verify to user-kind, the operator key to
 * operator-kind; `kind: "system"` exists only in-process.
 */

import type { IncomingMessage } from "node:http";
import type { HandlerContext } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";
import { composeAuthenticators, type Authenticator } from "./authenticator.js";

export interface CallerResolver {
  /** For `defineResource`'s `caller` seam (Connect handlers). */
  fromConnect(ctx: HandlerContext): Promise<CallerPrincipal | undefined>;
  /** For plain-HTTP routes (byte streams live beside Connect). */
  fromHttp(req: IncomingMessage): Promise<CallerPrincipal | undefined>;
}

export function createCallerResolver(
  authenticators: readonly Authenticator[],
): CallerResolver {
  const authenticate = composeAuthenticators(authenticators);

  const fromHeader = async (header: string | null | undefined) => {
    const credential = bearerCredential(header);
    return credential ? authenticate(credential) : undefined;
  };

  return {
    fromConnect: (ctx) => fromHeader(ctx.requestHeader.get("authorization")),
    fromHttp: (req) => {
      const value = req.headers.authorization;
      return fromHeader(Array.isArray(value) ? value[0] : value);
    },
  };
}

/**
 * RFC 6750 bearer extraction: scheme is case-insensitive; anything not
 * bearer-shaped is "no credential", never an error — the authorize step
 * owns the client-facing UNAUTHENTICATED answer.
 */
function bearerCredential(header: string | null | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}
