/**
 * Session kit tests (T04b D4). The fake server is Connect's in-memory
 * router transport running the REAL AuthService descriptor, so the kit is
 * exercised through the same client machinery production uses. Tabs are
 * simulated with memoryCoordinationHub — one hub = one browser, each
 * attach() = one tab sharing the lock and the broadcast bus.
 *
 * The invariant that matters most here: refresh rotations are one-time-use
 * with revoke-all-on-reuse server-side, so the kit must NEVER let two
 * concurrent callers (same tab or sibling tabs) issue overlapping Refresh
 * calls — the fake server counts them and the tests assert serialization.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../gen/stigmer/identity/auth/v1/auth_pb.js";
import { UserSchema, type User } from "../../gen/stigmer/identity/user/v1/user_pb.js";
import { createSessionKit, type SessionKit } from "../session.js";
import { memoryCoordinationHub, type MemoryCoordinationHub } from "../tab-coordination.js";

const NO_SESSION = "No active session — sign in";
const THEFT_NOTICE = "Your session was ended for security reasons. Sign in again.";
const UNIFORM_LOGIN_FAILURE = "Email or password is incorrect";

const EXPIRES_IN_SECONDS = 3600;

interface FakeAuthServer {
  transport: Transport;
  refreshCalls: number;
  refreshInFlight: number;
  /** Next refresh outcomes; empty = succeed with a fresh token. */
  refreshFailure?: { code: Code; message: string };
  loginFailure?: { code: Code; message: string };
}

function fakeAuthServer(): FakeAuthServer {
  const user: User = create(UserSchema, {
    metadata: { id: "usr_1" },
    spec: { email: "asha@acme.example", name: "Asha" },
  });
  let tokenCounter = 0;

  const server: FakeAuthServer = {
    transport: undefined as unknown as Transport,
    refreshCalls: 0,
    refreshInFlight: 0,
  };

  server.transport = createRouterTransport(({ service }) => {
    service(AuthService, {
      login() {
        if (server.loginFailure) {
          throw new ConnectError(server.loginFailure.message, server.loginFailure.code);
        }
        tokenCounter += 1;
        return { accessToken: `tok_${tokenCounter}`, expiresInSeconds: EXPIRES_IN_SECONDS, user };
      },
      async refresh() {
        server.refreshCalls += 1;
        server.refreshInFlight += 1;
        try {
          // Yield so a concurrency bug would actually overlap here.
          await Promise.resolve();
          if (server.refreshInFlight > 1) {
            // What the real store's reuse detection would do — and what
            // the kit must make impossible.
            throw new ConnectError(THEFT_NOTICE, Code.Unauthenticated);
          }
          if (server.refreshFailure) {
            throw new ConnectError(server.refreshFailure.message, server.refreshFailure.code);
          }
          tokenCounter += 1;
          return { accessToken: `tok_${tokenCounter}`, expiresInSeconds: EXPIRES_IN_SECONDS };
        } finally {
          server.refreshInFlight -= 1;
        }
      },
      logout() {
        return {};
      },
      whoAmI(_req, ctx) {
        if (!ctx.requestHeader.get("authorization")?.startsWith("Bearer tok_")) {
          throw new ConnectError("Authentication required", Code.Unauthenticated);
        }
        return user;
      },
    });
  });
  return server;
}

describe("session kit (T04b D4 / DD-005 D5)", () => {
  let server: FakeAuthServer;
  let hub: MemoryCoordinationHub;
  let nowMs: number;

  beforeEach(() => {
    server = fakeAuthServer();
    hub = memoryCoordinationHub();
    nowMs = 1_000_000_000;
  });

  function newTab(): SessionKit {
    return createSessionKit({
      authTransport: server.transport,
      coordination: hub.attach(),
      now: () => nowMs,
    });
  }

  it("bootstrap without a session lands signed-out with NO notice (a first visit is not news)", async () => {
    server.refreshFailure = { code: Code.Unauthenticated, message: NO_SESSION };
    const kit = newTab();
    await kit.bootstrap();
    expect(kit.getState()).toEqual({ status: "signed-out", notice: undefined });
  });

  it("bootstrap resumes a session from the cookie: refresh, then WhoAmI", async () => {
    const kit = newTab();
    await kit.bootstrap();
    const state = kit.getState();
    expect(state.status).toBe("signed-in");
    if (state.status === "signed-in") {
      expect(state.user.spec?.email).toBe("asha@acme.example");
    }
    expect(server.refreshCalls).toBe(1);
  });

  it("signIn stores the token in memory and signs the tab in; login failures bubble verbatim", async () => {
    const kit = newTab();
    server.loginFailure = { code: Code.Unauthenticated, message: UNIFORM_LOGIN_FAILURE };
    await expect(kit.signIn("asha@acme.example", "wrong")).rejects.toThrow(UNIFORM_LOGIN_FAILURE);
    expect(kit.getState().status).toBe("starting");

    server.loginFailure = undefined;
    await kit.signIn("asha@acme.example", "right");
    expect(kit.getState().status).toBe("signed-in");
    await expect(kit.getAccessToken()).resolves.toMatch(/^tok_/);
    expect(server.refreshCalls).toBe(0);
  });

  it("getAccessToken serves the cached token while fresh and refreshes once past expiry", async () => {
    const kit = newTab();
    await kit.signIn("asha@acme.example", "right");
    await kit.getAccessToken();
    expect(server.refreshCalls).toBe(0);

    nowMs += EXPIRES_IN_SECONDS * 1000 + 1;
    const token = await kit.getAccessToken();
    expect(server.refreshCalls).toBe(1);
    await expect(kit.getAccessToken()).resolves.toBe(token);
    expect(server.refreshCalls).toBe(1);
  });

  it("concurrent expiry in ONE tab issues exactly one refresh", async () => {
    const kit = newTab();
    await kit.signIn("asha@acme.example", "right");
    nowMs += EXPIRES_IN_SECONDS * 1000 + 1;

    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => kit.getAccessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(server.refreshCalls).toBe(1);
  });

  it("concurrent expiry across TWO tabs never overlaps refreshes (the theft-alarm scenario)", async () => {
    const tabA = newTab();
    const tabB = newTab();
    await tabA.signIn("asha@acme.example", "right");
    // Tab B adopted the broadcast token; both now expire together.
    nowMs += EXPIRES_IN_SECONDS * 1000 + 1;

    const [a, b] = await Promise.all([tabA.getAccessToken(), tabB.getAccessToken()]);
    // The fake server throws the theft notice on overlap — reaching here
    // means serialization held; the broadcast re-check means one refresh.
    expect(a).toBe(b);
    expect(server.refreshCalls).toBe(1);
  });

  it("a sibling tab's sign-in signs this tab in too (broadcast adoption + hydration)", async () => {
    const tabA = newTab();
    const tabB = newTab();
    server.refreshFailure = { code: Code.Unauthenticated, message: NO_SESSION };
    await tabB.bootstrap();
    expect(tabB.getState().status).toBe("signed-out");
    server.refreshFailure = undefined;
    const refreshCallsAfterBoot = server.refreshCalls;

    await tabA.signIn("asha@acme.example", "right");
    // Hydration (WhoAmI) is async — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tabB.getState().status).toBe("signed-in");
    // Adoption, not rotation: the broadcast token means no new refresh.
    expect(server.refreshCalls).toBe(refreshCallsAfterBoot);
  });

  it("the theft response ends the session in EVERY tab, notice shown verbatim", async () => {
    const tabA = newTab();
    const tabB = newTab();
    await tabA.signIn("asha@acme.example", "right");
    nowMs += EXPIRES_IN_SECONDS * 1000 + 1;
    server.refreshFailure = { code: Code.Unauthenticated, message: THEFT_NOTICE };

    await expect(tabA.getAccessToken()).rejects.toThrow(THEFT_NOTICE);
    expect(tabA.getState()).toEqual({ status: "signed-out", notice: THEFT_NOTICE });
    expect(tabB.getState()).toEqual({ status: "signed-out", notice: THEFT_NOTICE });
  });

  it("signOut ends the session everywhere without a notice", async () => {
    const tabA = newTab();
    const tabB = newTab();
    await tabA.signIn("asha@acme.example", "right");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await tabA.signOut();
    expect(tabA.getState()).toEqual({ status: "signed-out", notice: undefined });
    expect(tabB.getState()).toEqual({ status: "signed-out", notice: undefined });
  });

  it("a transient refresh failure does NOT end the session", async () => {
    const kit = newTab();
    await kit.signIn("asha@acme.example", "right");
    nowMs += EXPIRES_IN_SECONDS * 1000 + 1;
    server.refreshFailure = { code: Code.Unavailable, message: "connection lost" };

    await expect(kit.getAccessToken()).rejects.toThrow("connection lost");
    expect(kit.getState().status).toBe("signed-in");

    server.refreshFailure = undefined;
    await expect(kit.getAccessToken()).resolves.toMatch(/^tok_/);
  });

  it("bootstrap against an unreachable server says what to do", async () => {
    server.refreshFailure = { code: Code.Unavailable, message: "connection lost" };
    const kit = newTab();
    await kit.bootstrap();
    const state = kit.getState();
    expect(state.status).toBe("signed-out");
    if (state.status === "signed-out") {
      expect(state.notice).toMatch(/check your connection/i);
    }
  });
});
