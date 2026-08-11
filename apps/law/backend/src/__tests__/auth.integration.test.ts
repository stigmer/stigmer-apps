/**
 * Authentication acceptance tests (T04a, DD-005; auth shape locked by T01
 * owner decision 1: email/password, bcrypt + JWT, access ~1h, refresh
 * 7-day rolling, accounts operator-created, reset is an operator action).
 * Full production path: Connect client → real HTTP server → AuthService +
 * resource pipelines → real Postgres. Cookies are captured from response
 * headers exactly as a browser would receive them.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { AuthService, UserSchema, UserService } from "@stigmer/identity";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "@stigmer/identity/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { createTestPool } from "./test-pool.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { startTestAuthz, type TestAuthz } from "./test-authz.js";
import { testMigrationSources } from "./test-migrations.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

let auth: TestAuth;
let authz: TestAuthz;

async function expectCode(promise: Promise<unknown>, code: Code, pattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, `expected ${Code[code]}, got ${Code[cerr.code]}: ${cerr.message}`).toBe(code);
    if (pattern) expect(cerr.message).toMatch(pattern);
  }
}

/** Captures the message without failing — for exact-equality comparisons. */
async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return expect.fail("expected a failure");
  } catch (err) {
    return ConnectError.from(err).rawMessage;
  }
}

describe("Authentication (T04a / DD-005)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let transport: Transport;
  let authClient: Client<typeof AuthService>;
  let users: Client<typeof UserService>;
  let cases: Client<typeof CaseService>;
  let firmMembers: Client<typeof FirmMemberService>;

  const PASSWORD = "a sensible passphrase";

  /** Creates a user + password + firm profile through the real operator
   * path — since the rebuild, a User without a FirmMember is refused by
   * the fail-closed policy on every resource RPC, so a login fixture
   * must be genuine staff to prove anything about its token. */
  async function provision(email: string, password = PASSWORD): Promise<string> {
    const created = await users.create(
      create(UserSchema, { spec: { email } }),
      auth.asOperator(),
    );
    await users.setPassword({ email, password }, auth.asOperator());
    await firmMembers.create(
      create(FirmMemberSchema, {
        spec: { userId: created.metadata?.id ?? "", role: FirmRole.ASSOCIATE },
      }),
      auth.asOperator(),
    );
    return created.metadata?.id as string;
  }

  /** Login capturing the refresh cookie the way a browser would. */
  async function login(email: string, password = PASSWORD) {
    let setCookie = "";
    const res = await authClient.login(
      { email, password },
      { onHeader: (h) => (setCookie = h.get("set-cookie") ?? "") },
    );
    const refreshCookie = /(stigmer_refresh=[^;]+)/.exec(setCookie)?.[1] ?? "";
    return { res, setCookie, refreshCookie };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    auth = await createTestAuth();
    authz = await startTestAuthz();

    server = createBackendServer({
      store: createResourceStore(pool),
      auth: auth.kit,
      authz: await authz.newEngine(),
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
      objectStore: memoryObjectStore(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    transport = createConnectTransport({ baseUrl: `http://localhost:${port}`, httpVersion: "1.1" });
    authClient = createClient(AuthService, transport);
    users = createClient(UserService, transport);
    cases = createClient(CaseService, transport);
    firmMembers = createClient(FirmMemberService, transport);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  describe("login", () => {
    it("verifies the password, returns the user, and sets the httpOnly refresh cookie", async () => {
      await provision("clerk@firm.example");
      const { res, setCookie, refreshCookie } = await login("clerk@firm.example");

      expect(res.accessToken).not.toBe("");
      expect(res.expiresInSeconds).toBe(3600); // T01: access ~1h
      expect(res.user?.spec?.email).toBe("clerk@firm.example");

      // D5: httpOnly, SameSite=Strict, path-scoped to the auth service —
      // page script can't read it, other routes never receive it.
      expect(refreshCookie).toMatch(/^stigmer_refresh=rft_/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/stigmer.identity.auth.v1.AuthService/");

      // The access token authorizes real resource RPCs.
      const page = await cases.list({}, { headers: { authorization: `Bearer ${res.accessToken}` } });
      expect(page.totalCount).toBe(0n);
    });

    it("is case-insensitive on email (the natural key is stored lowercase)", async () => {
      await provision("cased@firm.example");
      const { res } = await login("CASED@Firm.Example");
      expect(res.user?.spec?.email).toBe("cased@firm.example");
    });

    it("answers wrong-password, unknown-email, and no-password-set with ONE uniform message", async () => {
      await provision("victim@firm.example");
      // A user that exists but has never had a password set.
      await users.create(
        create(UserSchema, { spec: { email: "passwordless@firm.example" } }),
        auth.asOperator(),
      );

      const wrongPassword = await failureMessage(
        authClient.login({ email: "victim@firm.example", password: "not it" }),
      );
      const unknownEmail = await failureMessage(
        authClient.login({ email: "ghost@firm.example", password: "whatever" }),
      );
      const noPassword = await failureMessage(
        authClient.login({ email: "passwordless@firm.example", password: "whatever" }),
      );

      // DD-005's recorded exception to errors-name-the-value: identical
      // answers teach an attacker nothing about which half failed.
      expect(wrongPassword).toBe("Email or password is incorrect");
      expect(unknownEmail).toBe(wrongPassword);
      expect(noPassword).toBe(wrongPassword);
    });

    it("rate-limits repeated failures with a clerk-readable answer, and success clears the budget", async () => {
      await provision("limited@firm.example");

      for (let i = 0; i < 5; i++) {
        await expectCode(
          authClient.login({ email: "limited@firm.example", password: "wrong" }),
          Code.Unauthenticated,
        );
      }
      // The 6th attempt is refused BEFORE the password is even checked —
      // the right password is now also denied (fail-closed).
      await expectCode(
        authClient.login({ email: "limited@firm.example", password: PASSWORD }),
        Code.ResourceExhausted,
        /Too many sign-in attempts.*minute/,
      );
      // Un-limited accounts are unaffected (per-email budget).
      await provision("unlimited@firm.example");
      expect((await login("unlimited@firm.example")).res.accessToken).not.toBe("");
    });
  });

  describe("access tokens", () => {
    it("an expired access token answers UNAUTHENTICATED on protected RPCs", async () => {
      const expired = await auth.expiredToken("user_whoever");
      await expectCode(
        cases.list({}, { headers: { authorization: `Bearer ${expired}` } }),
        Code.Unauthenticated,
      );
    });
  });

  describe("refresh (D6: rotation + reuse detection)", () => {
    it("rotates: the new cookie works, and a fresh access token is minted", async () => {
      await provision("rotator@firm.example");
      const first = await login("rotator@firm.example");

      let rotatedSetCookie = "";
      const refreshed = await authClient.refresh(
        {},
        {
          headers: { cookie: first.refreshCookie },
          onHeader: (h) => (rotatedSetCookie = h.get("set-cookie") ?? ""),
        },
      );
      expect(refreshed.accessToken).not.toBe("");
      const rotatedCookie = /(stigmer_refresh=[^;]+)/.exec(rotatedSetCookie)?.[1] ?? "";
      expect(rotatedCookie).toMatch(/^stigmer_refresh=rft_/);
      expect(rotatedCookie).not.toBe(first.refreshCookie);
    });

    it("a replayed refresh token ends EVERY session of the affected user", async () => {
      await provision("stolen@firm.example");
      const session = await login("stolen@firm.example");

      // Legitimate rotation...
      let rotatedSetCookie = "";
      await authClient.refresh(
        {},
        {
          headers: { cookie: session.refreshCookie },
          onHeader: (h) => (rotatedSetCookie = h.get("set-cookie") ?? ""),
        },
      );
      const rotatedCookie = /(stigmer_refresh=[^;]+)/.exec(rotatedSetCookie)?.[1] ?? "";

      // ...then the ORIGINAL token arrives again: theft evidence.
      await expectCode(
        authClient.refresh({}, { headers: { cookie: session.refreshCookie } }),
        Code.Unauthenticated,
        /ended for security reasons/,
      );
      // The atomic response also killed the legitimate successor.
      await expectCode(
        authClient.refresh({}, { headers: { cookie: rotatedCookie } }),
        Code.Unauthenticated,
        /expired/,
      );
    });

    it("without a session cookie, refresh asks for a sign-in", async () => {
      await expectCode(authClient.refresh({}), Code.Unauthenticated, /sign in/i);
    });
  });

  describe("logout", () => {
    it("ends the session, clears the cookie, and is idempotent", async () => {
      await provision("leaver@firm.example");
      const session = await login("leaver@firm.example");

      let clearedCookie = "";
      await authClient.logout(
        {},
        {
          headers: { cookie: session.refreshCookie },
          onHeader: (h) => (clearedCookie = h.get("set-cookie") ?? ""),
        },
      );
      expect(clearedCookie).toContain("stigmer_refresh=;");
      expect(clearedCookie).toContain("Max-Age=0");

      await expectCode(
        authClient.refresh({}, { headers: { cookie: session.refreshCookie } }),
        Code.Unauthenticated,
      );
      // Logging out again (no session) still succeeds.
      await authClient.logout({});
    });
  });

  describe("whoAmI", () => {
    it("returns the caller's own record from a login-minted token", async () => {
      await provision("me@firm.example");
      const { res } = await login("me@firm.example");

      const me = await authClient.whoAmI(
        {},
        { headers: { authorization: `Bearer ${res.accessToken}` } },
      );
      expect(me.spec?.email).toBe("me@firm.example");
    });

    it("requires authentication, and the operator key has no user profile", async () => {
      await expectCode(authClient.whoAmI({}), Code.Unauthenticated);
      await expectCode(authClient.whoAmI({}, auth.asOperator()), Code.NotFound, /operator/);
    });
  });

  describe("profile correction (T05: User.Update) meets login", () => {
    it("login follows an operator email correction immediately — credentials key on the user id, not the email", async () => {
      const userId = await provision("mistyped@firm.example");

      await users.update(
        create(UserSchema, {
          metadata: { id: userId },
          spec: { email: "corrected@firm.example" },
        }),
        auth.asOperator(),
      );

      // The new email signs in with the UNCHANGED password; the old email
      // answers the uniform login failure (it is now simply no account).
      const session = await login("corrected@firm.example");
      expect(session.res.accessToken).toBeTruthy();
      await expectCode(
        authClient.login({ email: "mistyped@firm.example", password: PASSWORD }),
        Code.Unauthenticated,
      );
    });
  });

  describe("offboarding (D9: SetPassword revokes sessions)", () => {
    it("a password reset kills the user's refresh sessions; the ≤1h access tail is the accepted remainder", async () => {
      await provision("departing@firm.example");
      const session = await login("departing@firm.example");

      await users.setPassword(
        { email: "departing@firm.example", password: "rotated by the operator" },
        auth.asOperator(),
      );

      // The refresh session is dead — no new tokens, ever.
      await expectCode(
        authClient.refresh({}, { headers: { cookie: session.refreshCookie } }),
        Code.Unauthenticated,
      );
      // The outstanding ACCESS token still works until it expires (≤1h) —
      // asserting the accepted remainder keeps the decision visible.
      const page = await cases.list(
        {},
        { headers: { authorization: `Bearer ${session.res.accessToken}` } },
      );
      expect(page.totalCount).toBe(0n);
    });
  });
});
