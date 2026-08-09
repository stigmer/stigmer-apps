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
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import { createPgCredentialStore, createPgRefreshTokenStore } from "@stigmer/identity/postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createTestAuth } from "../__tests__/test-auth.js";
import { testMigrationSources } from "../__tests__/test-migrations.js";
import { createTestPool } from "../__tests__/test-pool.js";
import { memoryObjectStore } from "../__tests__/memory-object-store.js";
import { createFirmServers } from "../server.js";
import { createResourceStore } from "../storage.js";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 8798);
/** Dev-only, obviously fictional; printed below for the smoke script. */
const MCP_SECRET = "e2e-dev-mcp-shared-secret-0123456789";

/** Must match apps/law/web/e2e/fixtures.ts. */
const SEED_USERS = [
  { email: "asha@acme.example", name: "Asha Rao", password: "sensible-e2e-passphrase", phone: "+91123456" },
  { email: "ravi@acme.example", name: "Ravi Iyer", password: "sensible-e2e-passphrase", phone: "+91123457" },
];

const container = await new PostgreSqlContainer("postgres:17-alpine").start();
const pool = createTestPool(container.getConnectionUri());
await runMigrations(pool, testMigrationSources());
const auth = await createTestAuth();

// Both listeners, exactly like production (T05): the web app for
// Playwright, the MCP entrance for scripts/mcp-smoke.ts.
const { web: server, mcp } = createFirmServers(
  {
    store: createResourceStore(pool),
    auth: auth.kit,
    credentials: createPgCredentialStore(pool),
    refreshTokens: createPgRefreshTokenStore(pool),
    objectStore: memoryObjectStore(),
    dispatcher: new InProcessEventDispatcher(),
    webRoot: fileURLToPath(new URL("../../../web/dist", import.meta.url)),
  },
  { sharedSecret: MCP_SECRET },
);
await new Promise<void>((resolve) => server.listen(PORT, resolve));
await new Promise<void>((resolve) => mcp.listen(MCP_PORT, resolve));

const transport = createConnectTransport({ baseUrl: `http://localhost:${PORT}`, httpVersion: "1.1" });
const users = createClient(UserService, transport);
const userIds: string[] = [];
for (const seed of SEED_USERS) {
  const created = await users.create(
    // Fictional short phones (the guard's convention): they make the
    // seeded users reachable through the MCP identity gate too.
    create(UserSchema, { spec: { email: seed.email, name: seed.name, phone: seed.phone } }),
    auth.asOperator(),
  );
  userIds.push(created.metadata?.id as string);
  await users.setPassword({ email: seed.email, password: seed.password }, auth.asOperator());
}

// One seeded case so task flows have something real to bind to — created
// through the wire AS THE FIRST SEEDED USER, so its audit fields carry a
// user principal exactly like production rows.
const firstUserId = userIds[0] as string;
await auth.mint(firstUserId);
const cases = createClient(CaseService, transport);
await cases.create(
  create(CaseSchema, {
    spec: {
      caseNumber: "WP-1234/2026",
      clientName: "Acme Traders",
      caseType: "civil",
      assignedLawyerId: firstUserId,
    },
  }),
  auth.as(firstUserId),
);

console.log(`e2e backend ready on :${PORT} (seeded ${SEED_USERS.length} users, 1 case)`);
console.log(
  `mcp entrance on :${MCP_PORT} — smoke it with: npx tsx scripts/mcp-smoke.ts ` +
    `--url http://localhost:${MCP_PORT} --secret ${MCP_SECRET} --wa 91123456`,
);
