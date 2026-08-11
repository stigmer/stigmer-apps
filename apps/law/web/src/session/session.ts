/**
 * The session kit (T04b D4; DD-005 D5): access token in MEMORY only —
 * never storage script can read — with the refresh token riding the
 * httpOnly cookie the browser manages. One seam, getAccessToken(), feeds
 * every authenticated call (the Connect interceptor and the document
 * byte-route client), so token freshness has exactly one owner.
 *
 * Refresh discipline: rotations are serialized across tabs through
 * TabCoordination (see tab-coordination.ts for why that is a hard
 * requirement, not an optimization), and every outcome is broadcast so
 * sibling tabs converge — fresh tokens are adopted, sign-outs land every
 * tab on the login screen with the same message.
 */

import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { AuthService } from "../gen/stigmer/identity/auth/v1/auth_pb.js";
import type { User } from "../gen/stigmer/identity/user/v1/user_pb.js";
import type { SessionBroadcast, TabCoordination } from "./tab-coordination.js";

export type SessionState =
  /** Boot in progress — the router shows a neutral loading state. */
  | { readonly status: "starting" }
  | { readonly status: "signed-in"; readonly user: User }
  /**
   * notice, when present, is the server's own sentence about why the
   * session ended ("Your session was ended for security reasons. Sign in
   * again.") — shown verbatim on the login screen; errors are UX.
   */
  | { readonly status: "signed-out"; readonly notice?: string };

/**
 * The auth service's "there is no session to refresh" answer
 * (packages/identity/src/auth-service.ts) — the one refresh failure that
 * is a normal state (first visit, cookie expired out), not news worth a
 * notice on the login screen.
 */
const NO_SESSION_MESSAGE = "No active session — sign in";

/** Refresh this many ms before nominal expiry — clock skew headroom. */
const EXPIRY_SKEW_MS = 30_000;

export interface SessionKitDeps {
  /**
   * Transport WITHOUT the bearer interceptor: the kit manages its own
   * headers, and the interceptor calls back into the kit — wiring the
   * auth surface through it would recurse.
   */
  readonly authTransport: Transport;
  readonly coordination: TabCoordination;
  /** Injectable clock for expiry tests. */
  readonly now?: () => number;
}

export interface SessionKit {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** Resume the session from the refresh cookie, if one exists. */
  bootstrap(): Promise<void>;
  /** Login errors bubble to the form and are shown verbatim. */
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** A currently-valid access token, refreshing (under the lock) if needed. */
  getAccessToken(): Promise<string>;
  /** The server rejected the token (e.g. key rotation): drop it so the next getAccessToken refreshes. */
  invalidateAccessToken(): void;
  /**
   * Redeem a one-time activation code and set the account's password
   * (DD-003 D4) — anonymous, like signIn; the person signs in normally
   * afterwards. Errors bubble verbatim to the form.
   */
  redeemActivationCode(code: string, newPassword: string): Promise<void>;
  /**
   * Change the signed-in person's password. The server revokes every
   * session on success, so the kit immediately signs back in with the
   * new password — the user never notices the reset underneath.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

interface HeldToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

export function createSessionKit(deps: SessionKitDeps): SessionKit {
  const now = deps.now ?? Date.now;
  const client: Client<typeof AuthService> = createClient(AuthService, deps.authTransport);

  let token: HeldToken | undefined;
  let state: SessionState = { status: "starting" };
  const listeners = new Set<() => void>();

  function setState(next: SessionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function isFresh(held: HeldToken | undefined): held is HeldToken {
    return held !== undefined && now() < held.expiresAtMs - EXPIRY_SKEW_MS;
  }

  function adoptToken(value: string, expiresAtMs: number, broadcastIt: boolean): void {
    token = { value, expiresAtMs };
    if (broadcastIt) {
      deps.coordination.broadcast({ type: "token", accessToken: value, expiresAtMs });
    }
  }

  /** Ends the session in THIS tab and (optionally) tells the others. */
  function endSession(notice: string | undefined, broadcastIt: boolean): void {
    token = undefined;
    setState({ status: "signed-out", notice });
    if (broadcastIt) {
      deps.coordination.broadcast({ type: "signed-out", notice });
    }
  }

  async function hydrateUser(accessToken: string): Promise<User> {
    return client.whoAmI({}, { headers: { authorization: `Bearer ${accessToken}` } });
  }

  deps.coordination.subscribe((message: SessionBroadcast) => {
    if (message.type === "token") {
      adoptToken(message.accessToken, message.expiresAtMs, false);
      // A sibling tab signed in (or refreshed while we thought we were
      // out) — hydrate this tab too instead of stranding it on /login.
      if (state.status !== "signed-in") {
        void hydrateUser(message.accessToken)
          .then((user) => setState({ status: "signed-in", user }))
          .catch(() => undefined);
      }
      return;
    }
    endSession(message.notice, false);
  });

  async function getAccessToken(): Promise<string> {
    if (isFresh(token)) return token.value;
    return deps.coordination.withRefreshLock(async () => {
      // A sibling tab may have refreshed while we queued; its broadcast
      // usually lands before our turn. When it hasn't yet, refreshing
      // again is still safe — rotations are serialized, so we present
      // the NEW cookie, not a consumed one. Costs one extra rotation,
      // never a false theft alarm.
      if (isFresh(token)) return token.value;
      let refreshed;
      try {
        refreshed = await client.refresh({});
      } catch (err) {
        const cerr = ConnectError.from(err);
        if (cerr.code === Code.Unauthenticated) {
          // The session is over (no cookie / expired / theft response).
          // Suppress the no-session sentence — a first visit is not news
          // — but surface everything else verbatim in every tab.
          const notice = cerr.rawMessage === NO_SESSION_MESSAGE ? undefined : cerr.rawMessage;
          endSession(notice, true);
        }
        throw err;
      }
      adoptToken(refreshed.accessToken, now() + Number(refreshed.expiresInSeconds) * 1000, true);
      return refreshed.accessToken;
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async bootstrap(): Promise<void> {
      try {
        const accessToken = await getAccessToken();
        const user = await hydrateUser(accessToken);
        setState({ status: "signed-in", user });
      } catch {
        // getAccessToken already ended the session (with any notice) on
        // auth failures; anything else — the server unreachable — lands
        // on login with a sentence that says what to do.
        if (state.status === "starting") {
          setState({
            status: "signed-out",
            notice: "Could not reach the server. Check your connection and sign in.",
          });
        }
      }
    },

    async signIn(email: string, password: string): Promise<void> {
      const res = await client.login({ email, password });
      adoptToken(res.accessToken, now() + Number(res.expiresInSeconds) * 1000, true);
      if (!res.user) {
        // Contract guarantee (LoginResponse carries the user); if it ever
        // breaks, fail loudly rather than render a half-session.
        throw new ConnectError("Login response carried no user", Code.Internal);
      }
      setState({ status: "signed-in", user: res.user });
    },

    async signOut(): Promise<void> {
      try {
        // Logout consumes the refresh token server-side (the post-logout
        // replay tripwire, DD-005 D6) and clears the cookie.
        await client.logout({});
      } catch {
        // Unreachable server must not trap the user in a session: end it
        // locally; the cookie dies by Max-Age at the latest.
      }
      endSession(undefined, true);
    },

    getAccessToken,

    invalidateAccessToken(): void {
      token = undefined;
    },

    async redeemActivationCode(code: string, newPassword: string): Promise<void> {
      await client.redeemActivationCode({ code, newPassword });
    },

    async changePassword(currentPassword: string, newPassword: string): Promise<void> {
      if (state.status !== "signed-in") {
        throw new ConnectError("Sign in first", Code.Unauthenticated);
      }
      const email = state.user.spec?.email ?? "";
      await client.changePassword(
        { currentPassword, newPassword },
        { headers: { authorization: `Bearer ${await getAccessToken()}` } },
      );
      // The server revoked every session (including this one's refresh
      // cookie); re-establish seamlessly with the credential we were
      // just handed. The held access token would still verify for ≤1h,
      // but a fresh full session is the honest state.
      token = undefined;
      const res = await client.login({ email, password: newPassword });
      adoptToken(res.accessToken, now() + Number(res.expiresInSeconds) * 1000, true);
      if (res.user) {
        setState({ status: "signed-in", user: res.user });
      }
    },
  };
}
