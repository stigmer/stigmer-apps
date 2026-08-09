/**
 * The two Connect transports (T04b D2/D4). Same-origin base URL — the
 * backend serves this app (D1), so there is no cross-origin story, no
 * CORS, and the refresh cookie's SameSite=Strict is satisfied by
 * construction.
 *
 * authTransport: bare, for the session kit only (it sets its own headers;
 * the bearer interceptor calls back into the kit, so routing the auth
 * surface through it would recurse).
 *
 * apiTransport: every resource call rides it — the interceptor attaches
 * the current access token and, when the server still answers
 * UNAUTHENTICATED (key rotation, revocation racing a fresh-looking
 * token), forces one refresh and retries once. A second failure bubbles:
 * by then the session kit has already ended the session and routed every
 * tab to login.
 */

import { Code, ConnectError, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type { SessionKit } from "../session/session.js";

export type TokenSource = Pick<SessionKit, "getAccessToken" | "invalidateAccessToken">;

export function createAuthTransport(baseUrl: string): Transport {
  return createConnectTransport({ baseUrl });
}

/** Exported for unit tests (composed over an in-memory router transport). */
export function createBearerInterceptor(session: TokenSource): Interceptor {
  return (next) => async (req) => {
    req.header.set("authorization", `Bearer ${await session.getAccessToken()}`);
    try {
      return await next(req);
    } catch (err) {
      if (ConnectError.from(err).code !== Code.Unauthenticated) {
        throw err;
      }
      session.invalidateAccessToken();
      req.header.set("authorization", `Bearer ${await session.getAccessToken()}`);
      return await next(req);
    }
  };
}

export function createApiTransport(baseUrl: string, session: TokenSource): Transport {
  return createConnectTransport({ baseUrl, interceptors: [createBearerInterceptor(session)] });
}
