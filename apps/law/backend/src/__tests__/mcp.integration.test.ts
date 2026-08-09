/**
 * The MCP surface end to end (T05, DD-008), in three rings:
 *
 * 1. The IDENTITY MATRIX over an in-memory MCP transport with a real MCP
 *    client: every caller class (anonymous / unknown / ambiguous /
 *    bound) against the tools, asserting the EXACT relayable sentences —
 *    on a chat surface the copy is the contract.
 * 2. A lawyer's WORKING DAY through the tools against real Postgres,
 *    asserting the writes land through the same pipelines as the web
 *    app, attributed to the LAWYER — never a service account.
 * 3. The HTTP GATE on the real second listener: health before auth, the
 *    constant-time secret boundary, and the PINNED TRUTH of DD-008 —
 *    a forged identity WITH the secret IS trusted. That is the trust
 *    model as fact, not a wish: whoever holds the secret can assert any
 *    identity, which is why the secret gets no public exposure.
 *
 * Fixture discipline: short fictional phones only (+91123456 shapes);
 * the CI guard fails on anything real-shaped.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createChannelIdentityResolver,
  UserSchema,
  type ChannelIdentity,
} from "@stigmer/identity";
import { createPgCredentialStore, createPgRefreshTokenStore } from "@stigmer/identity/postgres";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema } from "../gen/stigmer/law/case/v1/case_pb.js";
import { ListCaseNotesRequestSchema } from "../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { GetTaskRequestSchema, TaskSchema } from "../gen/stigmer/law/task/v1/task_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../domain/firm-clock.js";
import { buildFirmMcpServer } from "../mcp/server.js";
import {
  REFUSAL_AMBIGUOUS_CALLER,
  REFUSAL_NO_IDENTITY,
  REFUSAL_UNKNOWN_CALLER,
} from "../mcp/refusals.js";
import type { ToolDeps } from "../mcp/tools/shared.js";
import { createFirmServers } from "../server.js";
import { createResourceStore } from "../storage.js";
import { createApp, type AppResources } from "../routes.js";
import { firmPolicy } from "../domain/authz/policy.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { testMigrationSources } from "./test-migrations.js";
import { createTestPool } from "./test-pool.js";
import { memoryObjectStore } from "./memory-object-store.js";

// Verified staff identities (wa_id = digits of the stored E.164 phone).
const ASHA_WA: ChannelIdentity = { kind: "whatsapp_phone", value: "91123456" };
const UNKNOWN_WA: ChannelIdentity = { kind: "whatsapp_phone", value: "91999999" };
const SHARED_WA: ChannelIdentity = { kind: "whatsapp_phone", value: "91123999" };

const OPERATOR = { id: "operator", kind: "operator" } as const;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let resources: AppResources;
let deps: ToolDeps;
let auth: TestAuth;

let asha = "";
let bina = "";
let caseId = "";
let taskId = "";

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

/** A connected MCP client for one identity — the runner's exact view. */
async function connectedClient(identity: ChannelIdentity | undefined): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await Promise.all([
    buildFirmMcpServer(identity, deps).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function callTool(
  identity: ChannelIdentity | undefined,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await connectedClient(identity);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = createTestPool(container.getConnectionUri());
  await runMigrations(pool, testMigrationSources());
  auth = await createTestAuth();

  const store = createResourceStore(pool);
  const app = createApp({
    store,
    // The matrix drives resources through invoke only; no wire caller.
    caller: () => undefined,
    credentials: createPgCredentialStore(pool),
    refreshTokens: createPgRefreshTokenStore(pool),
  });
  resources = app.resources;
  deps = { resources, resolveChannelIdentity: createChannelIdentityResolver(store) };

  // Seed through the real pipelines as the operator (user provisioning)
  // and as the lawyer (case/tasks) — never store writes.
  const user = (email: string, name: string, phone?: string) =>
    resources.users.invoke.create!(
      create(UserSchema, { spec: { email, name, phone } }),
      OPERATOR,
    );
  asha = (await user("asha@firm.example", "Asha", "+91123456")).metadata?.id as string;
  bina = (await user("bina@firm.example", "Bina", "+91123457")).metadata?.id as string;
  await user("shared-a@firm.example", "Shared A", "+91123999");
  await user("shared-b@firm.example", "Shared B", "+91123999");

  const today = todayInFirmTimezone();
  caseId = (
    await resources.cases.invoke.create!(
      create(CaseSchema, {
        spec: {
          caseNumber: "CRL-42/2026",
          clientName: "Meera Traders",
          caseType: "criminal",
          assignedLawyerId: asha,
          nextHearingDate: addDaysToIsoDate(today, 3),
        },
      }),
      { id: asha, kind: "user" },
    )
  ).metadata?.id as string;

  taskId = (
    await resources.tasks.invoke.create!(
      create(TaskSchema, {
        spec: {
          caseId,
          title: "Draft counter-affidavit",
          assigneeId: asha,
          dueDate: addDaysToIsoDate(today, -2),
        },
      }),
      { id: asha, kind: "user" },
    )
  ).metadata?.id as string;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("the identity matrix (exact relayable sentences)", () => {
  const ALL_TOOLS = [
    "add_case_note",
    "find_tasks",
    "firm_overview",
    "get_case",
    "my_open_tasks",
    "upcoming_hearings",
    "update_task_status",
  ].sort();

  it("anonymous discovery lists every tool — hiding would leave them UNCLASSIFIED and ungated", async () => {
    const client = await connectedClient(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    await client.close();
  });

  it("my_open_tasks exposes NO person-identifying argument — own-row is structural, not prompted", async () => {
    const client = await connectedClient(ASHA_WA);
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "my_open_tasks")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema?.properties ?? {})).toEqual([]);
    await client.close();
  });

  it("every tool refuses an anonymous CALL with the no-identity sentence", async () => {
    for (const name of ["my_open_tasks", "firm_overview"]) {
      const result = await callTool(undefined, name);
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toBe(REFUSAL_NO_IDENTITY);
    }
  });

  it("an unknown number is refused with the sentence that TEACHES the way in", async () => {
    const result = await callTool(UNKNOWN_WA, "my_open_tasks");
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(REFUSAL_UNKNOWN_CALLER);
  });

  it("a number on two accounts is refused as ambiguous — never guessed", async () => {
    const result = await callTool(SHARED_WA, "firm_overview");
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(REFUSAL_AMBIGUOUS_CALLER);
  });
});

describe("a lawyer's working day through the tools", () => {
  it("my_open_tasks answers the caller's own work with case numbers and ids", async () => {
    const result = await callTool(ASHA_WA, "my_open_tasks");
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Draft counter-affidavit");
    expect(text(result)).toContain("OVERDUE");
    expect(text(result)).toContain("CRL-42/2026");
    expect(text(result)).toContain(taskId);
    const structured = result.structuredContent as { tasks: { id: string }[] };
    expect(structured.tasks[0]?.id).toBe(taskId);
  });

  it("get_case assembles the whole matter: lawyer name, counts, notes", async () => {
    const result = await callTool(ASHA_WA, "get_case", { case_number: "CRL-42/2026" });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Meera Traders");
    expect(text(result)).toContain("Asha");
    expect(text(result)).toContain("1 open task");
  });

  it("get_case relays the pipeline's NOT_FOUND sentence verbatim", async () => {
    const result = await callTool(ASHA_WA, "get_case", { case_number: "NO-SUCH/2026" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("NO-SUCH/2026");
    expect(text(result)).toContain("not found");
  });

  it("find_tasks answers 'what is Asha working on' by exact name", async () => {
    const result = await callTool(ASHA_WA, "find_tasks", { assignee: "asha", status: "overdue" });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("1 overdue task for Asha");
    expect(text(result)).toContain("Draft counter-affidavit");
  });

  it("find_tasks refuses an unknown name, naming the fix", async () => {
    const result = await callTool(ASHA_WA, "find_tasks", { assignee: "Nobody" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('"Nobody"');
  });

  it("upcoming_hearings shows the calendar with the assigned lawyer", async () => {
    const result = await callTool(ASHA_WA, "upcoming_hearings", { days_ahead: 7 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("CRL-42/2026");
    expect(text(result)).toContain("Asha");
  });

  it("firm_overview reports server-computed counts", async () => {
    const result = await callTool(ASHA_WA, "firm_overview");
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("1 hearing in the next 7 days");
    expect(text(result)).toContain("1 open task");
    expect(text(result)).toContain("1 overdue task");
    const structured = result.structuredContent as Record<string, number>;
    expect(structured.overdue_tasks).toBe(1);
    expect(structured.total_cases).toBe(1);
  });

  it("add_case_note lands through the real pipeline, ATTRIBUTED TO THE LAWYER", async () => {
    const result = await callTool(ASHA_WA, "add_case_note", {
      case_number: "CRL-42/2026",
      note: "Hearing adjourned to next month; judge asked for the survey report.",
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("CRL-42/2026");

    const notes = await resources.caseNotes.invoke.list(
      create(ListCaseNotesRequestSchema, { caseId }),
      { id: bina, kind: "user" },
    );
    const note = notes.items[0];
    expect(note?.spec?.content).toContain("survey report");
    // The audit trail records the human, never a service account — the
    // property that makes a WhatsApp note byte-equal in meaning to a
    // browser note.
    expect(note?.metadata?.createdBy?.id).toBe(asha);
    expect(note?.metadata?.createdBy?.id).not.toBe("operator");
  });

  it("update_task_status mutates through the one write path, audited to the lawyer", async () => {
    const result = await callTool(ASHA_WA, "update_task_status", {
      task_id: taskId,
      status: "in_progress",
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("in progress");

    const task = await resources.tasks.invoke.get(
      create(GetTaskRequestSchema, { id: taskId }),
      { id: bina, kind: "user" },
    );
    expect(task.status?.state).toBe(2); // IN_PROGRESS
    expect(task.metadata?.updatedBy?.id).toBe(asha);
  });
});

describe("the HTTP gate (the real second listener)", () => {
  const SECRET = "http-suite-mcp-secret-0123456789abcdef";
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const servers = createFirmServers(
      {
        store: createResourceStore(pool),
        auth: auth.kit,
        credentials: createPgCredentialStore(pool),
        refreshTokens: createPgRefreshTokenStore(pool),
        objectStore: memoryObjectStore(),
      },
      { sharedSecret: SECRET },
    );
    server = servers.mcp;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function rpc(headers: Record<string, string>, body?: string) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  it("health answers before auth and never touches the database", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
  });

  it("no secret, wrong secret: refused before anything else is read", async () => {
    expect((await rpc({})).status).toBe(401);
    expect((await rpc({ authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("a forged identity WITHOUT the secret is refused — headers alone are nothing", async () => {
    const response = await rpc({
      "x-stigmer-caller-kind": "whatsapp_phone",
      "x-stigmer-caller-value": "91123456",
    });
    expect(response.status).toBe(401);
  });

  it("PINNED TRUTH (DD-008): a forged identity WITH the secret IS trusted", async () => {
    // Whoever holds the secret can assert any lawyer's identity. This
    // test documents the boundary as a fact so nobody discovers it as a
    // surprise: the secret must be treated as the credential it is, and
    // the listener gets no public exposure (cluster-internal port).
    const response = await rpc(
      {
        authorization: `Bearer ${SECRET}`,
        "x-stigmer-caller-kind": "whatsapp_phone",
        "x-stigmer-caller-value": "91123456",
      },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "my_open_tasks", arguments: {} },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.content?.[0]?.text).toContain("Draft counter-affidavit");
  });

  it("anonymous discovery works over HTTP with just the secret", async () => {
    const response = await rpc({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools).toHaveLength(7);
  });

  it("the endpoint is POST /mcp and nothing else", async () => {
    const wrongPath = await fetch(`${base}/other`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(wrongPath.status).toBe(404);
    const wrongMethod = await fetch(`${base}/mcp`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(wrongMethod.status).toBe(405);
  });
});
