/**
 * Stage A toolchain proof: a Connect client calls the real HTTP server,
 * which writes to a real Postgres — exercising codegen, the Connect
 * adapter, pg, and the cross-repo @stigmer/resource-api migration runner
 * in one path. Deleted with the Ping service when Case lands.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PingService } from "../gen/lawfirm/ping/v1/ping_pb.js";
import { createBackendServer } from "../server.js";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

describe("backend round trip", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool, MIGRATIONS_DIR);

    server = createBackendServer({ pool });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
  });

  it("serves /healthz without touching the database", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("round-trips proto -> Connect -> Postgres and counts pings", async () => {
    const transport = createConnectTransport({ baseUrl, httpVersion: "1.1" });
    const client = createClient(PingService, transport);

    const first = await client.ping({ label: "stage-a" });
    expect(first.label).toBe("stage-a");
    expect(first.totalPings).toBe(1n);

    const second = await client.ping({ label: "stage-a-again" });
    expect(second.totalPings).toBe(2n);

    // The response must reflect durable state, not in-process memory.
    const rows = await pool.query("SELECT label FROM pings ORDER BY id");
    expect(rows.rows.map((r) => r.label)).toEqual(["stage-a", "stage-a-again"]);
  });

  it("answers UNIMPLEMENTED-style errors for unknown paths, not crashes", async () => {
    const res = await fetch(`${baseUrl}/lawfirm.nosuch.v1.NoService/Nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // connect-es returns 404 for unregistered paths; the process must
    // survive and keep serving.
    expect(res.status).toBe(404);
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
  });
});
