/**
 * User acceptance tests, derived from the MVP scope contract
 * (design-decisions/001-mvp-scope-contract.md, amended by T03 D7). Every
 * test names its FR. Full production path: Connect client → real HTTP
 * server → pipeline → real Postgres (Testcontainers), with the users
 * migration applied by the commons runner.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import {
  UserSchema,
  UserService,
  verifyPassword,
  type CredentialStore,
} from "@stigmer/identity";
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { memoryObjectStore } from "./memory-object-store.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

// Accounts are operator-provisioned (FR-ADMIN-001); the operator identity
// is the per-deployment opk_ key (DD-005 D7), a real credential here too.
let auth: TestAuth;
let authz: TestAuthz;
const asOperator = () => auth.asOperator();
// A REAL firm member (user + FirmMember profile, seeded in beforeAll):
// since the rebuild's fail-closed policy, a bare token with no firm
// profile is refused with "No active firm membership" before any
// operator-only branch can speak — the suite tests the branch, so the
// caller must be genuine staff.
let staffUserId = "";
const asLawyer = () => auth.as(staffUserId);

function userInput(overrides: Partial<{ email: string; name: string; phone: string }> = {}) {
  return create(UserSchema, {
    spec: {
      email: overrides.email ?? "asha@example.com",
      name: overrides.name,
      phone: overrides.phone,
    },
  });
}

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

describe("User resource", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let credentials: CredentialStore;
  let server: http.Server;
  let client: Client<typeof UserService>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    auth = await createTestAuth();
    await auth.mint("lawyer-one");
    authz = await startTestAuthz();

    credentials = createPgCredentialStore(pool);
    server = createBackendServer({
      store: createResourceStore(pool),
      auth: auth.kit,
      authz: await authz.newEngine(),
      credentials,
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
      objectStore: memoryObjectStore(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const transport = createConnectTransport({
      baseUrl: `http://localhost:${port}`,
      httpVersion: "1.1",
    });
    client = createClient(UserService, transport);

    // The genuine staff caller (see asLawyer above), through the same
    // operator path production onboarding uses.
    const staff = await client.create(
      create(UserSchema, { spec: { email: "staff.caller@example.com" } }),
      auth.asOperator(),
    );
    staffUserId = staff.metadata?.id ?? "";
    const firmMembers = createClient(FirmMemberService, transport);
    await firmMembers.create(
      create(FirmMemberSchema, {
        spec: { userId: staffUserId, role: FirmRole.ASSOCIATE },
      }),
      auth.asOperator(),
    );
    await auth.mint(staffUserId);
  }, 120_000);

  afterEach(async () => {
    // Credentials and refresh sessions reference users; children first.
    // The seeded staff caller (and their firm profile) survives every
    // test — it is the suite's identity fixture, not test data.
    await pool.query("DELETE FROM refresh_tokens");
    await pool.query("DELETE FROM user_credentials WHERE user_id <> $1", [staffUserId]);
    await pool.query("DELETE FROM users WHERE id <> $1", [staffUserId]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  describe("create (FR-ADMIN-001)", () => {
    it("stamps the envelope, lowercases the email, and defaults the name to the local-part", async () => {
      const created = await client.create(
        // Short fictional number: the customer-data guard rejects anything
        // shaped like a real E.164 (10+ digits) in this public repo.
        userInput({ email: "Asha.K@Example.COM", phone: "+91123456" }),
        asOperator(),
      );

      expect(created.metadata?.id).toMatch(/^user_[0-9a-z]{26}$/);
      expect(created.metadata?.version).toBe(1n);
      expect(created.metadata?.createdBy?.id).toBe("operator");
      // The commons resource (DD-005 D2/D3): capability-named apiVersion.
      expect(created.apiVersion).toBe("identity.stigmer.ai/v1");
      expect(created.kind).toBe("User");
      // Stored lowercase: the unique constraint and every lookup agree by
      // construction (T03 D7).
      expect(created.spec?.email).toBe("asha.k@example.com");
      expect(created.spec?.name).toBe("asha.k");
      expect(created.spec?.phone).toBe("+91123456");
    });

    it("keeps an explicit name instead of the local-part fallback", async () => {
      const created = await client.create(
        userInput({ name: "Asha Verma" }),
        asOperator(),
      );
      expect(created.spec?.name).toBe("Asha Verma");
    });

    it("is administration-only: a firm user below managing partner is denied with the policy reason", async () => {
      await expectCode(
        client.create(userInput(), asLawyer()),
        Code.PermissionDenied,
        /Only an operator or the managing partner may manage user accounts/,
      );
    });

    it("INVARIANT (DD-005): no bearer token can claim elevated kind — not even one whose subject says so", async () => {
      // The dead shim accepted `x-dev-caller-kind: system` from anyone.
      // Its replacement mints user-kind principals unconditionally: a
      // token whose SUBJECT is the string "system" is still an ordinary
      // user — and since the rebuild, one with no firm profile at all,
      // refused at the membership gate before any branch can widen.
      await auth.mint("system");
      await expectCode(
        client.create(userInput(), auth.as("system")),
        Code.PermissionDenied,
        /No active firm membership/,
      );
    });

    it("requires authentication", async () => {
      await expectCode(client.create(userInput()), Code.Unauthenticated);
    });

    it("rejects a duplicate email naming the value", async () => {
      await client.create(userInput({ email: "dup@example.com" }), asOperator());
      await expectCode(
        client.create(userInput({ email: "dup@example.com" }), asOperator()),
        Code.AlreadyExists,
        /User with email 'dup@example.com' already exists/,
      );
    });

    it("rejects a re-cased duplicate: casing cannot mint a second account", async () => {
      await client.create(userInput({ email: "nk@example.com" }), asOperator());
      await expectCode(
        client.create(userInput({ email: "NK@Example.com" }), asOperator()),
        Code.AlreadyExists,
        /nk@example\.com/,
      );
    });

    it("rejects a malformed email", async () => {
      await expectCode(
        client.create(userInput({ email: "not-an-email" }), asOperator()),
        Code.InvalidArgument,
        /email/,
      );
    });

    it("rejects a non-E.164 phone (T05's WhatsApp binding matches this exact form)", async () => {
      await expectCode(
        client.create(userInput({ phone: "+91 98765 43210" }), asOperator()),
        Code.InvalidArgument,
        /phone/,
      );
    });
  });

  describe("get (FR-USER-001, narrowed by the rebuild: self or operator)", () => {
    it("loads by internal id and by email, case-insensitively (operator)", async () => {
      const created = await client.create(userInput({ email: "get@example.com" }), asOperator());

      const byId = await client.get({ id: created.metadata?.id ?? "" }, asOperator());
      expect(byId.spec?.email).toBe("get@example.com");

      const byEmail = await client.get({ email: "GET@Example.COM" }, asOperator());
      expect(byEmail.metadata?.id).toBe(created.metadata?.id);
    });

    it("a firm member reads their OWN record; anyone else's is operator territory", async () => {
      const own = await client.get({ id: staffUserId }, asLawyer());
      expect(own.spec?.email).toBe("staff.caller@example.com");

      const other = await client.create(userInput({ email: "other@example.com" }), asOperator());
      await expectCode(
        client.get({ id: other.metadata?.id ?? "" }, asLawyer()),
        Code.PermissionDenied,
        /operator/,
      );
    });

    it("answers NOT_FOUND naming the reference", async () => {
      await expectCode(
        client.get({ email: "ghost@example.com" }, asLawyer()),
        Code.NotFound,
        /User 'ghost@example\.com' not found/,
      );
    });

    it("rejects an empty reference", async () => {
      await expectCode(client.get({}, asLawyer()), Code.InvalidArgument, /id or email/);
    });
  });

  describe("list (FR-USER-001, narrowed by the rebuild: the account register is operator territory)", () => {
    it("orders by email ascending with a stable total (operator)", async () => {
      for (const email of ["c@example.com", "a@example.com", "b@example.com"]) {
        await client.create(userInput({ email }), asOperator());
      }
      const res = await client.list({}, asOperator());
      expect(res.items.map((u) => u.spec?.email)).toEqual([
        "a@example.com",
        "b@example.com",
        "c@example.com",
        // The suite's seeded staff caller — always present.
        "staff.caller@example.com",
      ]);
      expect(res.totalCount).toBe(4n);
    });

    it("a firm member does not read the account register — the roster is FirmMember.List", async () => {
      await expectCode(client.list({}, asLawyer()), Code.PermissionDenied, /not permitted/);
    });

    it("requires authentication", async () => {
      await expectCode(client.list({}), Code.Unauthenticated);
    });
  });

  describe("setPassword (FR-ADMIN-001; T03 D7)", () => {
    it("bcrypts server-side into user_credentials — never into the resource", async () => {
      const created = await client.create(userInput(), asOperator());
      await client.setPassword(
        { id: created.metadata?.id ?? "", password: "correct horse battery" },
        asOperator(),
      );

      const hash = await credentials.getPasswordHash(created.metadata?.id ?? "");
      expect(hash).toBeDefined();
      expect(hash).not.toContain("correct horse battery");
      expect(await verifyPassword("correct horse battery", hash as string)).toBe(true);

      // The resource itself carries nothing: the stored row's spec has
      // exactly the declared fields (leak impossible by construction).
      const row = await pool.query("SELECT resource->'spec' AS spec FROM users WHERE id = $1", [
        created.metadata?.id,
      ]);
      expect(Object.keys(row.rows[0].spec).sort()).toEqual(["email", "name"]);
    });

    it("resolves the target by email and supports reset (operator action, T01 decision 1)", async () => {
      const created = await client.create(userInput({ email: "reset@example.com" }), asOperator());
      await client.setPassword({ email: "Reset@Example.com", password: "first-password" }, asOperator());
      await client.setPassword({ email: "reset@example.com", password: "second-password" }, asOperator());

      const hash = (await credentials.getPasswordHash(created.metadata?.id ?? "")) as string;
      expect(await verifyPassword("second-password", hash)).toBe(true);
      expect(await verifyPassword("first-password", hash)).toBe(false);
    });

    it("is operator-only", async () => {
      const created = await client.create(userInput(), asOperator());
      await expectCode(
        client.setPassword({ id: created.metadata?.id ?? "", password: "long enough" }, asLawyer()),
        Code.PermissionDenied,
        /Only an operator may set a password directly — issue an activation code instead/,
      );
    });

    it("answers NOT_FOUND for an unknown user", async () => {
      await expectCode(
        client.setPassword({ email: "ghost@example.com", password: "long enough" }, asOperator()),
        Code.NotFound,
        /ghost@example\.com/,
      );
    });

    it("rejects a password under 8 characters", async () => {
      const created = await client.create(userInput(), asOperator());
      await expectCode(
        client.setPassword({ id: created.metadata?.id ?? "", password: "short" }, asOperator()),
        Code.InvalidArgument,
        /password/,
      );
    });
  });

  describe("update (T05: the read-only-profile deferral, cashed for channel binding)", () => {
    it("operator corrects a profile over the wire; the phone lands (the WhatsApp re-binding path)", async () => {
      const created = await client.create(userInput({ email: "fixme@example.com" }), asOperator());
      const updated = await client.update(
        create(UserSchema, {
          metadata: { id: created.metadata?.id },
          spec: { email: "fixme@example.com", name: "Asha Verma", phone: "+91123458" },
        }),
        asOperator(),
      );
      expect(updated.spec?.phone).toBe("+91123458");
      expect(updated.metadata?.version).toBe(2n);

      const fetched = await client.get({ email: "fixme@example.com" }, asOperator());
      expect(fetched.spec?.name).toBe("Asha Verma");
      expect(fetched.spec?.phone).toBe("+91123458");
    });

    it("is operator-only: a firm user cannot update anyone", async () => {
      const created = await client.create(userInput(), asOperator());
      await expectCode(
        client.update(
          create(UserSchema, {
            metadata: { id: created.metadata?.id },
            spec: { email: "asha@example.com", name: "Renamed" },
          }),
          asLawyer(),
        ),
        Code.PermissionDenied,
        /Only an operator or the managing partner may manage user accounts/,
      );
    });

    it("SECURITY (DD-008): a firm user cannot update even THEMSELF — a self-set phone would be a self-service impersonation lever", async () => {
      // spec.phone decides which verified WhatsApp sender RESOLVES TO this
      // user. If self-update were allowed, any signed-in clerk could bind
      // their own handset to the partner's account by editing the
      // partner's row — or worse, quietly bind a second handset to their
      // own row and hand it to someone else. The policy branch, not the
      // pipeline, is what forbids this; this test keeps that line alive.
      // The seeded staff caller updating THEIR OWN row — a genuine firm
      // member hitting the operator-only wall, not a stranger hitting
      // the membership gate.
      await expectCode(
        client.update(
          create(UserSchema, {
            metadata: { id: staffUserId },
            spec: { email: "staff.caller@example.com", phone: "+91123459" },
          }),
          asLawyer(),
        ),
        Code.PermissionDenied,
        /Only an operator or the managing partner may manage user accounts/,
      );
    });
  });

  describe("the operation matrix is the contract", () => {
    it("declares exactly create/update/get/list/setPassword/issueActivationCode — no delete (FR-USER-001 notes, amended T05 and DD-003 D4)", () => {
      expect(UserService.methods.map((m) => m.localName).sort()).toEqual([
        "create",
        "get",
        "issueActivationCode",
        "list",
        "setPassword",
        "update",
      ]);
    });
  });
});
