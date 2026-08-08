/**
 * Case acceptance tests, derived line-by-line from the MVP scope contract
 * (design-decisions/001-mvp-scope-contract.md and project log §R3.2).
 * Every test names its FR. Full production path: Connect client → real
 * HTTP server → pipeline → real Postgres (Testcontainers), with the cases
 * migration applied by the commons runner.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import { UserSchema, UserService } from "../gen/stigmer/law/user/v1/user_pb.js";
import { createPgCredentialStore } from "../domain/user/credentials.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

const asLawyer = (id = "lawyer-one") => ({
  headers: { "x-dev-caller-id": id },
});
const asOperator = () => ({
  headers: { "x-dev-caller-id": "ops-one", "x-dev-caller-kind": "operator" },
});

// Real user ids for assigned_lawyer_id: since the T03 reference check,
// a case must point at an existing User. Populated in beforeAll.
let lawyer1 = "";
let lawyer2 = "";

function caseInput(overrides: Partial<{
  caseNumber: string;
  clientName: string;
  caseType: string;
  assignedLawyerId: string;
  nextHearingDate: string;
}> = {}) {
  return create(CaseSchema, {
    spec: {
      caseNumber: overrides.caseNumber ?? "CRL-142/2026",
      clientName: overrides.clientName ?? "Ramesh Traders",
      caseType: overrides.caseType ?? "criminal",
      assignedLawyerId: overrides.assignedLawyerId ?? lawyer1,
      nextHearingDate: overrides.nextHearingDate,
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

describe("Case resource", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let client: Client<typeof CaseService>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool, MIGRATIONS_DIR);

    server = createBackendServer({
      store: createResourceStore(pool),
      credentials: createPgCredentialStore(pool),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const transport = createConnectTransport({
      baseUrl: `http://localhost:${port}`,
      httpVersion: "1.1",
    });
    client = createClient(CaseService, transport);

    // The lawyers every case fixture assigns — real users, through the
    // real operator provisioning path (the reference check demands them).
    const users = createClient(UserService, transport);
    lawyer1 = (
      await users.create(
        create(UserSchema, { spec: { email: "lawyer-one@example.com" } }),
        asOperator(),
      )
    ).metadata?.id as string;
    lawyer2 = (
      await users.create(
        create(UserSchema, { spec: { email: "lawyer-two@example.com" } }),
        asOperator(),
      )
    ).metadata?.id as string;
  }, 120_000);

  afterEach(async () => {
    await pool.query("DELETE FROM cases");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
  });

  describe("create (FR-CASE-001)", () => {
    it("stamps the envelope and derives document_count", async () => {
      const created = await client.create(
        caseInput({ nextHearingDate: "2026-09-01" }),
        asLawyer(),
      );

      expect(created.metadata?.id).toMatch(/^case_[0-9a-z]{26}$/);
      expect(created.metadata?.version).toBe(1n);
      expect(created.metadata?.createdBy?.id).toBe("lawyer-one");
      expect(created.apiVersion).toBe("law.stigmer.ai/v1");
      expect(created.kind).toBe("Case");
      expect(created.spec?.caseNumber).toBe("CRL-142/2026");
      // Derived on read, never stored; 0 until Document lands (T03).
      expect(created.status?.documentCount).toBe(0);
    });

    it("rejects a duplicate case number naming the value (AC7)", async () => {
      await client.create(caseInput({ caseNumber: "CRL-142/2026" }), asLawyer());
      await expectCode(
        client.create(caseInput({ caseNumber: "CRL-142/2026" }), asLawyer("lawyer-two")),
        Code.AlreadyExists,
        /Case with case number 'CRL-142\/2026' already exists/,
      );
    });

    it("answers exactly one ALREADY_EXISTS under a true concurrent race (database backstop)", async () => {
      const results = await Promise.allSettled([
        client.create(caseInput({ caseNumber: "RACE-1/2026" }), asLawyer("a")),
        client.create(caseInput({ caseNumber: "RACE-1/2026" }), asLawyer("b")),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const err = ConnectError.from((rejected[0] as PromiseRejectedResult).reason);
      expect(err.code).toBe(Code.AlreadyExists);

      const rows = await pool.query("SELECT count(*)::int AS n FROM cases");
      expect(rows.rows[0].n).toBe(1);
    });

    it.each([
      ["case_number", caseInput({ caseNumber: "" })],
      ["client_name", caseInput({ clientName: "" })],
      ["case_type", caseInput({ caseType: "" })],
      ["assigned_lawyer_id", caseInput({ assignedLawyerId: "" })],
    ])("rejects a missing mandatory field: %s (AC2-AC5)", async (field, input) => {
      await expectCode(client.create(input, asLawyer()), Code.InvalidArgument, new RegExp(field));
    });

    it("rejects a malformed hearing date (calendar date, not an instant)", async () => {
      await expectCode(
        client.create(caseInput({ nextHearingDate: "01-09-2026" }), asLawyer()),
        Code.InvalidArgument,
        /next_hearing_date/,
      );
    });

    it("requires authentication", async () => {
      await expectCode(client.create(caseInput()), Code.Unauthenticated);
    });

    it("rejects an assigned lawyer that does not exist (T03 reference check)", async () => {
      await expectCode(
        client.create(caseInput({ assignedLawyerId: "user_ghost" }), asLawyer()),
        Code.FailedPrecondition,
        /assigned lawyer 'user_ghost' not found/,
      );
      const rows = await pool.query("SELECT count(*)::int AS n FROM cases");
      expect(rows.rows[0].n).toBe(0);
    });
  });

  describe("update (FR-CASE-004)", () => {
    it("replaces spec, preserves identity and create-audit, bumps version", async () => {
      const created = await client.create(caseInput(), asLawyer("author"));
      const edit = create(CaseSchema, {
        metadata: { id: created.metadata?.id ?? "" },
        spec: {
          caseNumber: "CRL-142/2026",
          clientName: "Ramesh Traders Pvt Ltd",
          caseType: "criminal",
          assignedLawyerId: lawyer2,
          nextHearingDate: "2026-10-05",
        },
      });
      const updated = await client.update(edit, asLawyer("editor"));

      expect(updated.metadata?.id).toBe(created.metadata?.id);
      expect(updated.metadata?.version).toBe(2n);
      expect(updated.metadata?.createdBy?.id).toBe("author");
      expect(updated.metadata?.updatedBy?.id).toBe("editor");
      expect(updated.spec?.clientName).toBe("Ramesh Traders Pvt Ltd");
      expect(updated.spec?.nextHearingDate).toBe("2026-10-05");
    });

    it("allows correcting the case number, re-validating uniqueness", async () => {
      await client.create(caseInput({ caseNumber: "CRL-1/2026" }), asLawyer());
      const b = await client.create(caseInput({ caseNumber: "CRL-2/2026" }), asLawyer());

      // Renumber B onto a free number: allowed.
      const renumber = create(CaseSchema, {
        metadata: { id: b.metadata?.id ?? "" },
        spec: { caseNumber: "CRL-3/2026", clientName: "x", caseType: "civil", assignedLawyerId: lawyer1 },
      });
      const renumbered = await client.update(renumber, asLawyer());
      expect(renumbered.spec?.caseNumber).toBe("CRL-3/2026");

      // Renumber B onto A's number: ALREADY_EXISTS.
      const collide = create(CaseSchema, {
        metadata: { id: b.metadata?.id ?? "" },
        spec: { caseNumber: "CRL-1/2026", clientName: "x", caseType: "civil", assignedLawyerId: lawyer1 },
      });
      await expectCode(client.update(collide, asLawyer()), Code.AlreadyExists, /CRL-1\/2026/);
    });

    it("answers NOT_FOUND for an unknown id", async () => {
      const edit = create(CaseSchema, {
        metadata: { id: "case_00000000000000000000000000" },
        spec: { caseNumber: "X-1", clientName: "x", caseType: "civil", assignedLawyerId: lawyer1 },
      });
      await expectCode(client.update(edit, asLawyer()), Code.NotFound, /case_0{26}/);
    });

    it("rejects reassignment to a lawyer that does not exist (T03 reference check)", async () => {
      const created = await client.create(caseInput(), asLawyer());
      const edit = create(CaseSchema, {
        metadata: { id: created.metadata?.id ?? "" },
        spec: {
          caseNumber: "CRL-142/2026",
          clientName: "Ramesh Traders",
          caseType: "criminal",
          assignedLawyerId: "user_ghost",
        },
      });
      await expectCode(
        client.update(edit, asLawyer()),
        Code.FailedPrecondition,
        /assigned lawyer 'user_ghost' not found/,
      );
    });
  });

  describe("get (FR-CASE-003)", () => {
    it("loads by internal id and by case number (lawyers speak in case numbers)", async () => {
      const created = await client.create(caseInput({ caseNumber: "WP-77/2026" }), asLawyer());
      const byId = await client.get({ id: created.metadata?.id ?? "" }, asLawyer());
      expect(byId.spec?.caseNumber).toBe("WP-77/2026");

      const byNumber = await client.get({ caseNumber: "WP-77/2026" }, asLawyer());
      expect(byNumber.metadata?.id).toBe(created.metadata?.id);
      expect(byNumber.status?.documentCount).toBe(0);
    });

    it("answers NOT_FOUND naming the reference", async () => {
      await expectCode(
        client.get({ caseNumber: "GHOST-1/2026" }, asLawyer()),
        Code.NotFound,
        /Case 'GHOST-1\/2026' not found/,
      );
    });

    it("rejects an empty reference", async () => {
      await expectCode(client.get({}, asLawyer()), Code.InvalidArgument, /id or case number/);
    });
  });

  describe("list (FR-CASE-002)", () => {
    it("orders by next hearing date ascending with dateless cases last (AC4/AC5)", async () => {
      await client.create(caseInput({ caseNumber: "C-LATER", nextHearingDate: "2026-12-01" }), asLawyer());
      await client.create(caseInput({ caseNumber: "C-NONE" }), asLawyer());
      await client.create(caseInput({ caseNumber: "C-SOON", nextHearingDate: "2026-08-20" }), asLawyer());

      const res = await client.list({}, asLawyer());
      expect(res.items.map((c) => c.spec?.caseNumber)).toEqual(["C-SOON", "C-LATER", "C-NONE"]);
      expect(res.totalCount).toBe(3n);
    });

    it("defaults to page size 20 and paginates with a stable total", async () => {
      for (let i = 0; i < 25; i++) {
        await client.create(
          caseInput({
            caseNumber: `BULK-${String(i).padStart(2, "0")}/2026`,
            nextHearingDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
          }),
          asLawyer(),
        );
      }
      const first = await client.list({}, asLawyer());
      expect(first.items).toHaveLength(20);
      expect(first.totalCount).toBe(25n);

      const second = await client.list({ pageOffset: 20 }, asLawyer());
      expect(second.items).toHaveLength(5);
    });

    it("rejects an out-of-range page size", async () => {
      await expectCode(client.list({ pageSize: 1000 }, asLawyer()), Code.InvalidArgument);
    });

    it("requires authentication", async () => {
      await expectCode(client.list({}), Code.Unauthenticated);
    });
  });

  describe("the operation matrix is the contract", () => {
    it("declares exactly create/update/get/list — no delete (FR-CASE-004 notes, Appendix C)", () => {
      expect(CaseService.methods.map((m) => m.localName).sort()).toEqual([
        "create",
        "get",
        "list",
        "update",
      ]);
    });
  });
});
