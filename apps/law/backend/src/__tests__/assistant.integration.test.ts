/**
 * AssistantService acceptance tests (T05 web leg): the full production
 * path — Connect client → real HTTP server → the assistant service →
 * the policy's liveness gate → the minter port — with only the agent
 * platform faked (the port exists exactly so no test dials it).
 *
 * The one property everything here defends: the mint is SELF-SCOPED.
 * The platform's mint RPC takes asserted identity on trust, so the law
 * session must be the entire authorization for whose token is minted —
 * a caller can only ever receive a token carrying their own user id
 * and email.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { UserSchema, UserService } from "@stigmer/identity";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "@stigmer/identity/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MintInput } from "../assistant/minter.js";
import type { AssistantConfig } from "../config.js";
import {
  AssistantService,
} from "../gen/stigmer/law/assistant/v1/assistant_pb.js";
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

const ASSISTANT_CONFIG: AssistantConfig = {
  apiBaseUrl: "https://api.stigmer.example",
  clientId: "stgm_cid_test",
  clientSecret: "stgm_cs_test",
  org: "test-org",
  agentInstanceId: "agi_test",
  consoleUrl: "https://console.firm.example",
};

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

describe("AssistantService (T05 web leg)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let auth: TestAuth;
  let authz: TestAuthz;
  let configured: http.Server;
  let bare: http.Server;
  let assistant: Client<typeof AssistantService>;
  let bareAssistant: Client<typeof AssistantService>;
  let users: Client<typeof UserService>;
  let firmMembers: Client<typeof FirmMemberService>;

  /** Every mint the fake performed — the self-scoping evidence. */
  const mints: MintInput[] = [];
  /** Flip to make the platform "down" for the failure-path test. */
  let platformDown = false;

  let lawyerId: string;
  let colleagueId: string;
  let profilelessId: string;
  let deactivatedId: string;

  async function provision(email: string, role = FirmRole.ASSOCIATE): Promise<string> {
    const created = await users.create(create(UserSchema, { spec: { email } }), auth.asOperator());
    const userId = created.metadata?.id as string;
    await firmMembers.create(
      create(FirmMemberSchema, { spec: { userId, role } }),
      auth.asOperator(),
    );
    return userId;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    auth = await createTestAuth();
    authz = await startTestAuthz();

    const shared = {
      store: createResourceStore(pool),
      auth: auth.kit,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      activationCodes: createPgActivationCodeStore(pool),
      objectStore: memoryObjectStore(),
    };
    configured = createBackendServer({
      ...shared,
      authz: await authz.newEngine(),
      assistant: {
        config: ASSISTANT_CONFIG,
        minter: async (input) => {
          if (platformDown) throw new Error("platform unreachable (fake)");
          mints.push(input);
          return { accessToken: `platform-token-for-${input.userId}`, expiresInSeconds: 900 };
        },
      },
    });
    // The open-source posture: same server shape, no assistant at all.
    bare = createBackendServer({ ...shared, authz: await authz.newEngine() });

    const listen = (server: http.Server) =>
      new Promise<Transport>((resolve) => {
        server.listen(0, () => {
          const { port } = server.address() as AddressInfo;
          resolve(
            createConnectTransport({ baseUrl: `http://localhost:${port}`, httpVersion: "1.1" }),
          );
        });
      });
    const transport = await listen(configured);
    const bareTransport = await listen(bare);
    assistant = createClient(AssistantService, transport);
    bareAssistant = createClient(AssistantService, bareTransport);
    users = createClient(UserService, transport);
    firmMembers = createClient(FirmMemberService, transport);

    lawyerId = await provision("Asha.Rao@firm.example");
    colleagueId = await provision("ravi@firm.example");
    deactivatedId = await provision("former@firm.example");
    const formerProfile = await firmMembers.get({ userId: deactivatedId }, auth.asOperator());
    formerProfile.spec!.active = false;
    await firmMembers.update(formerProfile, auth.asOperator());
    // A login identity with NO firm profile — fail-closed must hold here.
    const profileless = await users.create(
      create(UserSchema, { spec: { email: "visitor@firm.example" } }),
      auth.asOperator(),
    );
    profilelessId = profileless.metadata?.id as string;

    await auth.mint(lawyerId, colleagueId, profilelessId, deactivatedId);
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => configured.close(resolve));
    await new Promise((resolve) => bare.close(resolve));
    await pool.end();
    await container.stop();
    await authz.stop();
  });

  describe("GetConfig", () => {
    it("requires authentication — the config is nobody else's business", async () => {
      await expectCode(assistant.getConfig({}), Code.Unauthenticated);
    });

    it("answers the full integration shape for a signed-in user", async () => {
      const config = await assistant.getConfig({}, auth.as(lawyerId));
      expect(config).toMatchObject({
        enabled: true,
        apiBaseUrl: "https://api.stigmer.example",
        org: "test-org",
        agentInstanceId: "agi_test",
        consoleUrl: "https://console.firm.example",
      });
    });

    it("answers enabled=false (not an error) when the deployment has no assistant", async () => {
      const config = await bareAssistant.getConfig({}, auth.as(lawyerId));
      expect(config.enabled).toBe(false);
      expect(config.apiBaseUrl).toBe("");
    });

    it("never provisions: reading config performs no mint", async () => {
      const before = mints.length;
      await assistant.getConfig({}, auth.as(lawyerId));
      expect(mints.length).toBe(before);
    });
  });

  describe("MintToken", () => {
    it("mints strictly for the caller's own user id and pipeline-lowercased email", async () => {
      const res = await assistant.mintToken({}, auth.as(lawyerId));
      expect(res.accessToken).toBe(`platform-token-for-${lawyerId}`);
      expect(res.expiresInSeconds).toBe(900);
      // The email was provisioned re-cased ("Asha.Rao@…"); the mint must
      // carry the normalized natural key — the exact value the MCP
      // entrance's stigmer_user resolver matches against.
      expect(mints.at(-1)).toMatchObject({
        userId: lawyerId,
        userEmail: "asha.rao@firm.example",
      });
    });

    it("two callers, two identities — nothing in the request can steer the mint", async () => {
      await assistant.mintToken({}, auth.as(lawyerId));
      await assistant.mintToken({}, auth.as(colleagueId));
      expect(mints.at(-2)?.userId).toBe(lawyerId);
      expect(mints.at(-1)?.userId).toBe(colleagueId);
    });

    it("requires authentication", async () => {
      await expectCode(assistant.mintToken({}), Code.Unauthenticated);
    });

    it("the operator key has no platform identity to mint for", async () => {
      await expectCode(
        assistant.mintToken({}, auth.asOperator()),
        Code.NotFound,
        /has no user profile/,
      );
    });

    it("a login identity without a firm profile is refused (fail-closed)", async () => {
      await expectCode(
        assistant.mintToken({}, auth.as(profilelessId)),
        Code.PermissionDenied,
        /No active firm membership/,
      );
    });

    it("deactivation closes the assistant with every other door (FR-MEMBER-002)", async () => {
      await expectCode(
        assistant.mintToken({}, auth.as(deactivatedId)),
        Code.PermissionDenied,
        /No active firm membership/,
      );
    });

    it("answers FAILED_PRECONDITION when the deployment has no assistant", async () => {
      await expectCode(
        bareAssistant.mintToken({}, auth.as(lawyerId)),
        Code.FailedPrecondition,
        /not configured/,
      );
    });

    it("a platform failure is UNAVAILABLE with a plain sentence — details stay in the log", async () => {
      platformDown = true;
      try {
        await expectCode(
          assistant.mintToken({}, auth.as(lawyerId)),
          Code.Unavailable,
          /assistant is unavailable right now/,
        );
      } finally {
        platformDown = false;
      }
    });
  });
});
