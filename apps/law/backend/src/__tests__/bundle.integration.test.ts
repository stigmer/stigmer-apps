/**
 * The BUNDLED ARTIFACT under test — dist/main.js as a real child
 * process, not the TypeScript sources every other suite exercises
 * (the isc-assistant bundle-suite precedent).
 *
 * Why this suite exists: the production image ships an esbuild bundle
 * plus the copied migration sources (build.mjs), and bundling is
 * precisely the step that can break while every source-level test stays
 * green — dev and E2E both run `tsx src/main.ts`, so nothing else ever
 * executes what actually ships. This suite caught a real defect on its
 * first run: the require-shim banner's un-aliased createRequire import
 * collided with main.ts's own and the bundle died with a SyntaxError.
 *
 * Asserted here, because only the artifact can prove them: the bundle
 * parses and boots; migrations ride BESIDE the bundle and apply in
 * composed order (the dist/migrations layout main.ts detects — DD-005
 * D8's packaging rule); /healthz answers; the Connect stack survived
 * bundling (an unauthenticated RPC is refused, not crashed); and
 * SIGTERM exits 0 (the container contract — exec-form `node` is PID 1).
 *
 * NOT asserted: the SPA static surface. Its presence in a local build
 * depends on whether the web workspace was built, and a conditional
 * assertion is a silent skip; the web E2E proves the same static-routes
 * code against dist/public, and CI's image job boots the real image.
 * The object store is fake config — the S3 client constructs without
 * dialing, and document flows are proven by the MinIO suites.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;

let container: StartedPostgreSqlContainer;
let child: ChildProcess;
let base: string;
let mcpBase: string;
/** Every stdout line the child printed before "listening" (boot log). */
let bootLog: string[];

const MCP_SECRET = "bundle-test-mcp-secret-0123456789abcdef";

/** A port the OS just proved free — config.ts rejects PORT=0 by design. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startBundle(port: number, mcpPort: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [BUNDLE], {
    env: {
      // No process.env passthrough: the artifact must boot from exactly
      // the variables the deployment manifest provides, nothing ambient.
      DATABASE_URL: container.getConnectionUri(),
      PORT: String(port),
      OBJECT_STORE_ENDPOINT: "http://127.0.0.1:9",
      OBJECT_STORE_BUCKET: "bundle-test-documents",
      OBJECT_STORE_ACCESS_KEY_ID: "bundle-test-access-key",
      OBJECT_STORE_SECRET_ACCESS_KEY: "bundle-test-secret-key",
      AUTH_EPHEMERAL_KEYS: "true",
      AUTH_OPERATOR_KEY_SHA256: "a".repeat(64),
      MCP_PORT: String(mcpPort),
      MCP_SHARED_SECRET: MCP_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  bootLog = [];
  const stderr: string[] = [];
  createInterface({ input: proc.stderr! }).on("line", (line) => stderr.push(line));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `bundle did not report listening within ${STARTUP_TIMEOUT_MS}ms\n` +
              `stdout:\n${bootLog.join("\n")}\nstderr:\n${stderr.join("\n")}`,
          ),
        ),
      STARTUP_TIMEOUT_MS,
    );
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `bundle exited before listening (code ${code})\n` +
            `stdout:\n${bootLog.join("\n")}\nstderr:\n${stderr.join("\n")}`,
        ),
      );
    });
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      bootLog.push(line);
      if (line.includes(`backend listening on :${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  return proc;
}

beforeAll(async () => {
  // Always test the bundle of the CURRENT sources, never a stale dist/.
  const build = spawnSync("node", ["build.mjs"], { cwd: PACKAGE_DIR, stdio: "pipe" });
  expect(build.status, String(build.stderr)).toBe(0);

  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const port = await freePort();
  const mcpPort = await freePort();
  child = await startBundle(port, mcpPort);
  base = `http://127.0.0.1:${port}`;
  mcpBase = `http://127.0.0.1:${mcpPort}`;
}, 120_000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (container) await container.stop();
});

describe("the bundled artifact", () => {
  it("applies both migration sources from the copied layout, identity first (DD-005 D8)", () => {
    // Fresh database + first boot: everything applies, and the line
    // proves the migrations were read from dist/migrations, not from
    // node_modules (the image has none).
    const line = bootLog.find((l) => l.startsWith("migrations applied:"));
    expect(line).toBeDefined();
    const applied = (line as string).replace("migrations applied: ", "").split(", ");
    expect(applied[0]).toBe("identity/0001_users.sql");
    expect(applied).toContain("app/0003_cases.sql");
    expect(applied).toContain("app/0014_audit_entries.sql");
  });

  it("serves /healthz before auth", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("refuses an unauthenticated RPC — the Connect stack survived bundling", async () => {
    const response = await fetch(`${base}/stigmer.identity.auth.v1.AuthService/WhoAmI`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code?: string }).code).toBe("unauthenticated");
  });

  it("serves the MCP listener from the artifact: secret gate holds, tools list (T05)", async () => {
    // Without the secret: refused before anything else is read.
    const denied = await fetch(`${mcpBase}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);

    // With it: a real MCP tools/list answers with the journey verbs —
    // the MCP SDK survived bundling (conditional imports are exactly the
    // kind of thing esbuild can break while source tests stay green).
    const listed = await fetch(`${mcpBase}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP_SECRET}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((t) => t.name).sort()).toEqual(
      [
        "add_case_note",
        "case_story",
        "find_tasks",
        "firm_overview",
        "my_day",
        "my_deadlines",
        "outstanding_balances",
        "record_hearing_outcome",
        "upcoming_hearings",
        "update_task_status",
      ].sort(),
    );
  });

  it("exits 0 on SIGTERM — the container shutdown contract", async () => {
    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);
  });
});
