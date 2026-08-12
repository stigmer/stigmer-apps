/**
 * The web app's E2E backend (T04b): the EXACT production server —
 * createBackendServer, real Postgres via Testcontainers, real auth kit
 * with ephemeral keys — serving the web app's build from ../web/dist the
 * way the deployed image serves dist/public. Started by Playwright's
 * webServer (apps/law/web/playwright.config.ts) and killed with it;
 * Testcontainers' reaper collects the database container.
 *
 * Seeding runs through the real operator path (UserService over the
 * wire), never through store writes — the E2E suite trusts nothing the
 * product's own surfaces cannot do. Seeded identities are FICTIONAL
 * (the customer-data guard scans every path) and must match
 * apps/law/web/e2e/fixtures.ts, the consuming side.
 */

import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { InProcessEventDispatcher } from "@stigmer/resource-api";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { UserSchema, UserService } from "@stigmer/identity";
import { CaseSchema, CaseService, ClientRole, ForumKind } from "../gen/stigmer/law/case/v1/case_pb.js";
import { ClientSchema, ClientService } from "../gen/stigmer/law/client/v1/client_pb.js";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmRole,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  createPgActivationCodeStore,
  createPgCredentialStore,
  createPgRefreshTokenStore,
} from "@stigmer/identity/postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createTestAuth } from "../__tests__/test-auth.js";
import { startTestAuthz } from "../__tests__/test-authz.js";
import { testMigrationSources } from "../__tests__/test-migrations.js";
import { createTestPool } from "../__tests__/test-pool.js";
import { memoryObjectStore } from "../__tests__/memory-object-store.js";
import type { AssistantRuntime } from "../assistant/assistant-service.js";
import { createFirmServers } from "../server.js";
import { createResourceStore } from "../storage.js";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 8798);
/** Dev-only, obviously fictional; printed below for the smoke script. */
const MCP_SECRET = "e2e-dev-mcp-shared-secret-0123456789";

/**
 * The fake-assistant mode (E2E_FAKE_ASSISTANT=1): a fictional
 * AssistantRuntime so the REAL dock, the REAL lazy chunk, and the REAL
 * SDK stylesheet load in the browser — the layout class of defect
 * (stigmer/stigmer#454: a second stylesheet flipping the app's rules;
 * the DD-019 unbounded-height leak) is structurally invisible to the
 * assistant-disabled suite. No agent platform is dialed: the base URL
 * is a closed local port, so every SDK data call refuses immediately
 * and the layout under test is what a lawyer sees while the platform
 * is reachable — the panel frame, the composer, the stylesheet.
 */
const FAKE_ASSISTANT = process.env.E2E_FAKE_ASSISTANT === "1";
const fakeAssistantRuntime = (): AssistantRuntime => ({
  config: {
    apiBaseUrl: "http://127.0.0.1:9",
    clientId: "stgm_cid_e2e_fake",
    clientSecret: "stgm_cs_e2e_fake",
    org: "e2e-fake-org",
    agentInstanceId: "ain_e2e_fake",
    consoleUrl: "http://127.0.0.1:9",
  },
  minter: async () => ({ accessToken: "e2e-fake-platform-token", expiresInSeconds: 900 }),
});

/** Must match apps/law/web/e2e/fixtures.ts. Roles matter now: the
 * matrix (FR-AUTHZ-*) makes a partner's and an associate's screens
 * genuinely different, and the E2E suite proves both. */
const SEED_USERS = [
  {
    email: "asha@acme.example",
    name: "Asha Rao",
    password: "sensible-e2e-passphrase",
    phone: "+91123456",
    role: FirmRole.MANAGING_PARTNER,
  },
  {
    email: "ravi@acme.example",
    name: "Ravi Iyer",
    password: "sensible-e2e-passphrase",
    phone: "+91123457",
    role: FirmRole.ASSOCIATE,
  },
];

const container = await new PostgreSqlContainer("postgres:17-alpine").start();
const pool = createTestPool(container.getConnectionUri());
await runMigrations(pool, testMigrationSources());
const auth = await createTestAuth();
// The FGA engine, containered like Postgres — the exact production
// policy path; seeding below flows through pipelines, so tuple sync
// populates the store without an explicit reconcile.
const authz = await startTestAuthz();

// Both listeners, exactly like production (T05): the web app for
// Playwright, the MCP entrance for scripts/mcp-smoke.ts.
const { web: server, mcp } = createFirmServers(
  {
    store: createResourceStore(pool),
    auth: auth.kit,
    authz: await authz.newEngine(),
    credentials: createPgCredentialStore(pool),
    refreshTokens: createPgRefreshTokenStore(pool),
    activationCodes: createPgActivationCodeStore(pool),
    objectStore: memoryObjectStore(),
    dispatcher: new InProcessEventDispatcher(),
    webRoot: fileURLToPath(new URL("../../../web/dist", import.meta.url)),
    ...(FAKE_ASSISTANT ? { assistant: fakeAssistantRuntime() } : {}),
  },
  { sharedSecret: MCP_SECRET },
);
await new Promise<void>((resolve) => server.listen(PORT, resolve));
await new Promise<void>((resolve) => mcp.listen(MCP_PORT, resolve));

const transport = createConnectTransport({ baseUrl: `http://localhost:${PORT}`, httpVersion: "1.1" });
const users = createClient(UserService, transport);
const firmMembers = createClient(FirmMemberService, transport);
const userIds: string[] = [];
const memberIds: string[] = [];
for (const seed of SEED_USERS) {
  const created = await users.create(
    // Fictional short phones (the guard's convention): they make the
    // seeded users reachable through the MCP identity gate too.
    create(UserSchema, { spec: { email: seed.email, name: seed.name, phone: seed.phone } }),
    auth.asOperator(),
  );
  const userId = created.metadata?.id as string;
  userIds.push(userId);
  await users.setPassword({ email: seed.email, password: seed.password }, auth.asOperator());
  // The firm profile — without it the policy denies everything
  // (fail-closed): a User with no FirmMember is not firm staff.
  const profile = await firmMembers.create(
    create(FirmMemberSchema, { spec: { userId, role: seed.role } }),
    auth.asOperator(),
  );
  memberIds.push(profile.metadata?.id as string);
}

// One client + one case so every flow has something real to bind to —
// created through the wire AS THE ASSOCIATE (who becomes the lead, and
// therefore a case member by materialization), so audit fields carry a
// user principal exactly like production rows.
const associateUserId = userIds[1] as string;
const associateMemberId = memberIds[1] as string;
await auth.mint(associateUserId);
const clients = createClient(ClientService, transport);
const seededClient = await clients.create(
  create(ClientSchema, { spec: { displayName: "Acme Traders", notes: "fictional e2e client" } }),
  auth.as(associateUserId),
);
const cases = createClient(CaseService, transport);
await cases.create(
  create(CaseSchema, {
    spec: {
      fileNumber: "WP/2026/1234",
      clientId: seededClient.metadata?.id as string,
      clientRole: ClientRole.PETITIONER,
      opposingParties: [{ name: "State of Telangana" }],
      forum: { forumKind: ForumKind.HIGH_COURT, name: "High Court for the State of Telangana" },
      caseType: "writ",
      leadLawyerId: associateMemberId,
    },
  }),
  auth.as(associateUserId),
);

console.log(
  `e2e backend ready on :${PORT} (seeded ${SEED_USERS.length} users with firm profiles, 1 client, 1 case` +
    `${FAKE_ASSISTANT ? ", fake assistant enabled" : ""})`,
);
console.log(
  `mcp entrance on :${MCP_PORT} — smoke it with: npx tsx scripts/mcp-smoke.ts ` +
    `--url http://localhost:${MCP_PORT} --secret ${MCP_SECRET} --wa 91123456`,
);
