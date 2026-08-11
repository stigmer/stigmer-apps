/**
 * In-product account administration (FR-AUTH-002 as amended by project
 * DD-003 D4): the managing partner onboards members, hands out one-time
 * activation codes, and never needs the operator key; members set and
 * change their OWN passwords. Full production path — Connect client →
 * real HTTP server → pipeline → real Postgres + OpenFGA — in contract
 * order: onboarding → the code lifecycle → self-service password change
 * → the denials → the lockout guards.
 *
 * The deny matrix's per-row proof lives in
 * domain/authz/__tests__/policy.test.ts; this suite re-proves the new
 * administration boundaries end to end, wire-level.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { startTestAuthz, type TestAuthz } from "./test-authz.js";
import { testMigrationSources } from "./test-migrations.js";
import { createTestPool } from "./test-pool.js";

async function expectCode(promise: Promise<unknown>, code: Code, pattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, `expected ${Code[code]}, got ${Code[cerr.code]}: ${cerr.message}`).toBe(
      code,
    );
    if (pattern) expect(cerr.message).toMatch(pattern);
  }
}

describe("account administration by the managing partner", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let auth: TestAuth;
  let authz: TestAuthz;

  let users: Client<typeof UserService>;
  let firmMembers: Client<typeof FirmMemberService>;
  let authClient: Client<typeof AuthService>;

  const mp = { email: "meera@firm.example", userId: "", memberId: "" };
  const partner = { email: "priya@firm.example", userId: "", memberId: "" };
  // Onboarded IN-PRODUCT by the managing partner during the arc.
  const recruit = { email: "arjun@firm.example", userId: "", memberId: "", password: "" };

  function asToken(accessToken: string) {
    return { headers: { authorization: `Bearer ${accessToken}` } };
  }

  /** Login capturing the refresh cookie the way a browser would. */
  async function login(email: string, password: string) {
    let setCookie = "";
    const res = await authClient.login(
      { email, password },
      { onHeader: (h) => (setCookie = h.get("set-cookie") ?? "") },
    );
    const refreshCookie = /(stigmer_refresh=[^;]+)/.exec(setCookie)?.[1] ?? "";
    return { res, refreshCookie };
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
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    const transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });
    users = createClient(UserService, transport);
    firmMembers = createClient(FirmMemberService, transport);
    authClient = createClient(AuthService, transport);

    // Bootstrap ONLY the first administrator through the operator path —
    // exactly the runbook: everything after this is in-product.
    for (const [person, role] of [
      [mp, FirmRole.MANAGING_PARTNER],
      [partner, FirmRole.PARTNER],
    ] as const) {
      const user = await users.create(
        create(UserSchema, { spec: { email: person.email } }),
        auth.asOperator(),
      );
      person.userId = user.metadata?.id ?? "";
      const member = await firmMembers.create(
        create(FirmMemberSchema, { spec: { userId: person.userId, role } }),
        auth.asOperator(),
      );
      person.memberId = member.metadata?.id ?? "";
    }
    await auth.mint(mp.userId, partner.userId);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  /* ---------------- onboarding, without the operator key ------------- */

  it("the managing partner onboards a member end to end: account, role, code, first sign-in", async () => {
    const user = await users.create(
      create(UserSchema, { spec: { email: recruit.email, name: "Arjun Rao" } }),
      auth.as(mp.userId),
    );
    recruit.userId = user.metadata?.id ?? "";

    const member = await firmMembers.create(
      create(FirmMemberSchema, {
        spec: { userId: recruit.userId, role: FirmRole.ASSOCIATE },
      }),
      auth.as(mp.userId),
    );
    recruit.memberId = member.metadata?.id ?? "";

    const issued = await users.issueActivationCode(
      { email: recruit.email },
      auth.as(mp.userId),
    );
    expect(issued.code).toMatch(/^act_/);
    expect(issued.expiresInSeconds).toBe(3 * 24 * 60 * 60);

    // The recruit sets their OWN password — nobody else ever knows it.
    recruit.password = "arjuns-own-sensible-passphrase";
    await authClient.redeemActivationCode({
      code: issued.code,
      newPassword: recruit.password,
    });

    const { res } = await login(recruit.email, recruit.password);
    expect(res.user?.spec?.email).toBe(recruit.email);
    // The session is genuinely firm staff: the roster answers.
    const roster = await firmMembers.list({}, asToken(res.accessToken));
    expect(roster.items.map((m) => m.spec?.userId)).toContain(recruit.userId);
  });

  it("onboarding is resumable by natural key: re-creating the same email answers ALREADY_EXISTS naming it", async () => {
    await expectCode(
      users.create(
        create(UserSchema, { spec: { email: recruit.email } }),
        auth.as(mp.userId),
      ),
      Code.AlreadyExists,
      /arjun@firm\.example/,
    );
    // ...and the managing partner can fetch the existing account to continue.
    const existing = await users.get({ email: recruit.email }, auth.as(mp.userId));
    expect(existing.metadata?.id).toBe(recruit.userId);
  });

  /* --------------------- the code lifecycle -------------------------- */

  it("a code is strictly one-time, and reissuing replaces the previous code", async () => {
    const first = await users.issueActivationCode({ email: recruit.email }, auth.as(mp.userId));
    const second = await users.issueActivationCode({ email: recruit.email }, auth.as(mp.userId));

    // The replaced code answers the UNIFORM failure...
    await expectCode(
      authClient.redeemActivationCode({ code: first.code, newPassword: "whatever-else-8" }),
      Code.Unauthenticated,
      /not valid or has expired/,
    );
    // ...the live one works exactly once...
    recruit.password = "arjuns-second-passphrase";
    await authClient.redeemActivationCode({ code: second.code, newPassword: recruit.password });
    await expectCode(
      authClient.redeemActivationCode({ code: second.code, newPassword: "third-try-8chars" }),
      Code.Unauthenticated,
      /not valid or has expired/,
    );
    // ...and garbage answers indistinguishably from both.
    await expectCode(
      authClient.redeemActivationCode({ code: "act_nonsense", newPassword: "whatever-else-8" }),
      Code.Unauthenticated,
      /not valid or has expired/,
    );
  });

  it("redeeming a reset code revokes every session the old password earned", async () => {
    const session = await login(recruit.email, recruit.password);

    const reset = await users.issueActivationCode({ email: recruit.email }, auth.as(mp.userId));
    recruit.password = "arjuns-post-reset-passphrase";
    await authClient.redeemActivationCode({ code: reset.code, newPassword: recruit.password });

    await expectCode(
      authClient.refresh({}, { headers: { cookie: session.refreshCookie } }),
      Code.Unauthenticated,
    );
    const again = await login(recruit.email, recruit.password);
    expect(again.res.accessToken).not.toBe("");
  });

  /* -------------------- self-service password change ----------------- */

  it("a member changes their own password with proof of possession; sessions reset", async () => {
    const session = await login(recruit.email, recruit.password);

    await expectCode(
      authClient.changePassword(
        { currentPassword: "not-the-password", newPassword: "does-not-matter-8" },
        asToken(session.res.accessToken),
      ),
      Code.PermissionDenied,
      /current password is incorrect/,
    );

    const newPassword = "arjuns-self-chosen-passphrase";
    await authClient.changePassword(
      { currentPassword: recruit.password, newPassword },
      asToken(session.res.accessToken),
    );

    // The old password and the old session are both dead; the new works.
    await expectCode(
      authClient.login({ email: recruit.email, password: recruit.password }),
      Code.Unauthenticated,
    );
    await expectCode(
      authClient.refresh({}, { headers: { cookie: session.refreshCookie } }),
      Code.Unauthenticated,
    );
    recruit.password = newPassword;
    const fresh = await login(recruit.email, recruit.password);
    expect(fresh.res.accessToken).not.toBe("");
  });

  /* ---------------------------- denials ------------------------------ */

  it("nobody below managing partner administers accounts — wire-level", async () => {
    await expectCode(
      users.create(
        create(UserSchema, { spec: { email: "intruder@firm.example" } }),
        auth.as(partner.userId),
      ),
      Code.PermissionDenied,
      /operator or the managing partner/,
    );
    await expectCode(
      users.issueActivationCode({ email: recruit.email }, auth.as(partner.userId)),
      Code.PermissionDenied,
      /operator or the managing partner/,
    );
  });

  it("even the managing partner cannot set someone's password directly", async () => {
    await expectCode(
      users.setPassword(
        { email: recruit.email, password: "a-silent-takeover" },
        auth.as(mp.userId),
      ),
      Code.PermissionDenied,
      /activation code/,
    );
  });

  /* ----------------------- the lockout guards ------------------------ */

  it("nobody deactivates their own account", async () => {
    const profile = await firmMembers.get({ userId: mp.userId }, auth.as(mp.userId));
    profile.spec!.active = false;
    await expectCode(
      firmMembers.update(profile, auth.as(mp.userId)),
      Code.PermissionDenied,
      /your own account/,
    );
  });

  it("the last active managing partner can be neither demoted nor deactivated — even by the operator", async () => {
    const profile = await firmMembers.get({ userId: mp.userId }, auth.as(mp.userId));
    profile.spec!.role = FirmRole.PARTNER;
    await expectCode(
      firmMembers.update(profile, auth.asOperator()),
      Code.FailedPrecondition,
      /at least one active managing partner/,
    );
  });

  it("with a second managing partner in place, the first may step down", async () => {
    const promoted = await firmMembers.get({ userId: recruit.userId }, auth.as(mp.userId));
    promoted.spec!.role = FirmRole.MANAGING_PARTNER;
    await firmMembers.update(promoted, auth.as(mp.userId));

    const original = await firmMembers.get({ userId: mp.userId }, auth.as(mp.userId));
    original.spec!.role = FirmRole.PARTNER;
    const demoted = await firmMembers.update(original, auth.as(mp.userId));
    expect(demoted.spec?.role).toBe(FirmRole.PARTNER);

    // The demotion took effect in the SAME request's tuple sync: the
    // now-mere-partner is refused administration on their next call.
    await expectCode(
      users.issueActivationCode({ email: recruit.email }, auth.as(mp.userId)),
      Code.PermissionDenied,
      /operator or the managing partner/,
    );
  });
});
