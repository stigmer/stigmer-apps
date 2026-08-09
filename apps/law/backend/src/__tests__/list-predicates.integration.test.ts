/**
 * The T05 named list predicates over real HTTP + real Postgres: task
 * scope (MINE default / FIRM explicit), the OPEN and OVERDUE filters,
 * and the case hearing window.
 *
 * The load-bearing test is THE AGREEMENT TEST: the set the OVERDUE
 * filter returns must equal the set whose derived status.overdue is true
 * — both sides consume the one rule in domain/task/overdue.ts, and this
 * test is what keeps a count and the list it opens from ever disagreeing
 * (the drift the named-predicate design exists to prevent).
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { UserSchema, UserService } from "@stigmer/identity";
import { createPgCredentialStore, createPgRefreshTokenStore } from "@stigmer/identity/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import {
  type Task,
  TaskListFilter,
  TaskListScope,
  TaskSchema,
  TaskService,
  TaskState,
} from "../gen/stigmer/law/task/v1/task_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../domain/firm-clock.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { testMigrationSources } from "./test-migrations.js";
import { createTestPool } from "./test-pool.js";

let auth: TestAuth;
const asUser = (id: string) => auth.as(id);
const asOperator = () => auth.asOperator();

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

describe("named list predicates (T05)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let transport: Transport;
  let tasks: Client<typeof TaskService>;
  let cases: Client<typeof CaseService>;

  let asha = "";
  let bina = "";
  let caseId = "";

  const today = todayInFirmTimezone();
  const yesterday = addDaysToIsoDate(today, -1);
  const tomorrow = addDaysToIsoDate(today, 1);

  /** title → id, for readable assertions. */
  const byTitle = new Map<string, string>();

  async function seedTask(
    title: string,
    options: { assignee: string; dueDate?: string; state: TaskState },
  ): Promise<void> {
    const created = await tasks.create(
      create(TaskSchema, {
        spec: { caseId, title, assigneeId: options.assignee, dueDate: options.dueDate },
      }),
      asUser(asha),
    );
    const id = created.metadata?.id as string;
    byTitle.set(title, id);
    if (options.state !== TaskState.OPEN) {
      await tasks.updateStatus({ id, state: options.state }, asUser(asha));
    }
  }

  const titles = (items: readonly Task[]) => items.map((t) => t.spec?.title).sort();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = createTestPool(container.getConnectionUri());
    await runMigrations(pool, testMigrationSources());
    auth = await createTestAuth();

    server = createBackendServer({
      store: createResourceStore(pool),
      auth: auth.kit,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      objectStore: memoryObjectStore(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    transport = createConnectTransport({ baseUrl: `http://localhost:${port}`, httpVersion: "1.1" });
    tasks = createClient(TaskService, transport);
    cases = createClient(CaseService, transport);

    const users = createClient(UserService, transport);
    asha = (
      await users.create(create(UserSchema, { spec: { email: "asha@example.com" } }), asOperator())
    ).metadata?.id as string;
    bina = (
      await users.create(create(UserSchema, { spec: { email: "bina@example.com" } }), asOperator())
    ).metadata?.id as string;
    await auth.mint(asha, bina);

    caseId = (
      await cases.create(
        create(CaseSchema, {
          spec: {
            caseNumber: "WP-1/2026",
            clientName: "Base Client",
            caseType: "civil",
            assignedLawyerId: asha,
          },
        }),
        asUser(asha),
      )
    ).metadata?.id as string;

    // The fixture matrix: every state × due-date combination that can
    // exist through the API, split across two assignees so the scope
    // dimension is real. Overdue-by-derivation is exactly the
    // yesterday × {OPEN, IN_PROGRESS} cells.
    await seedTask("open-past-asha", { assignee: asha, dueDate: yesterday, state: TaskState.OPEN });
    await seedTask("open-today-asha", { assignee: asha, dueDate: today, state: TaskState.OPEN });
    await seedTask("open-future-bina", { assignee: bina, dueDate: tomorrow, state: TaskState.OPEN });
    await seedTask("open-dateless-bina", { assignee: bina, state: TaskState.OPEN });
    await seedTask("progress-past-bina", { assignee: bina, dueDate: yesterday, state: TaskState.IN_PROGRESS });
    await seedTask("progress-future-asha", { assignee: asha, dueDate: tomorrow, state: TaskState.IN_PROGRESS });
    await seedTask("closed-past-asha", { assignee: asha, dueDate: yesterday, state: TaskState.CLOSED });
    await seedTask("closed-dateless-bina", { assignee: bina, state: TaskState.CLOSED });
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
  });

  describe("task scope", () => {
    it("no scope, no filters: the contract's My-Tasks default is unchanged", async () => {
      const mine = await tasks.list({}, asUser(bina));
      expect(titles(mine.items)).toEqual([
        "closed-dateless-bina",
        "open-dateless-bina",
        "open-future-bina",
        "progress-past-bina",
      ]);
    });

    it("FIRM scope is the explicit, deliberate widening — everyone's tasks", async () => {
      const firm = await tasks.list({ scope: TaskListScope.FIRM }, asUser(bina));
      expect(firm.totalCount).toBe(8n);
    });

    it("MINE stated explicitly behaves exactly like the default", async () => {
      const mine = await tasks.list({ scope: TaskListScope.MINE }, asUser(bina));
      expect(mine.totalCount).toBe(4n);
    });

    it("an explicit assignee filter names its own scope, as before", async () => {
      const binas = await tasks.list({ assigneeId: bina }, asUser(asha));
      expect(binas.totalCount).toBe(4n);
    });
  });

  describe("the OPEN and OVERDUE filters", () => {
    it("THE AGREEMENT TEST: the OVERDUE filter returns exactly the set whose derived overdue is true", async () => {
      const filtered = await tasks.list(
        { scope: TaskListScope.FIRM, filter: TaskListFilter.OVERDUE, pageSize: 100 },
        asUser(asha),
      );
      const everything = await tasks.list(
        { scope: TaskListScope.FIRM, pageSize: 100 },
        asUser(asha),
      );
      const derivedOverdue = everything.items.filter((t) => t.status?.overdue === true);

      // The two halves of the one rule agree…
      expect(titles(filtered.items)).toEqual(titles(derivedOverdue));
      // …and every returned row's own derived status is consistent with
      // the filter that selected it.
      for (const task of filtered.items) {
        expect(task.status?.overdue, task.spec?.title).toBe(true);
      }
      // …and the set is the one the fixture matrix predicts: past due
      // AND not finished. Due-today is not overdue; CLOSED never is;
      // dateless never is.
      expect(titles(filtered.items)).toEqual(["open-past-asha", "progress-past-bina"]);
      expect(filtered.totalCount).toBe(2n);
    });

    it("OPEN means not finished: OPEN and IN_PROGRESS, never CLOSED", async () => {
      const open = await tasks.list(
        { scope: TaskListScope.FIRM, filter: TaskListFilter.OPEN, pageSize: 100 },
        asUser(asha),
      );
      expect(titles(open.items)).toEqual([
        "open-dateless-bina",
        "open-future-bina",
        "open-past-asha",
        "open-today-asha",
        "progress-future-asha",
        "progress-past-bina",
      ]);
    });

    it("filter and scope compose: my open tasks is the argument-free WhatsApp question", async () => {
      const mine = await tasks.list({ filter: TaskListFilter.OPEN }, asUser(bina));
      expect(titles(mine.items)).toEqual([
        "open-dateless-bina",
        "open-future-bina",
        "progress-past-bina",
      ]);
    });

    it("filter composes with an explicit assignee too", async () => {
      const overdueBina = await tasks.list(
        { assigneeId: bina, filter: TaskListFilter.OVERDUE },
        asUser(asha),
      );
      expect(titles(overdueBina.items)).toEqual(["progress-past-bina"]);
    });

    it("an out-of-range filter enum is refused, not guessed", async () => {
      await expectCode(
        tasks.list({ filter: 99 as TaskListFilter }, asUser(asha)),
        Code.InvalidArgument,
      );
    });
  });

  describe("the case hearing window", () => {
    beforeAll(async () => {
      const hearingCase = (caseNumber: string, nextHearingDate?: string) =>
        cases.create(
          create(CaseSchema, {
            spec: {
              caseNumber,
              clientName: "Windows & Co",
              caseType: "civil",
              assignedLawyerId: asha,
              nextHearingDate,
            },
          }),
          asUser(asha),
        );
      await hearingCase("HRG-PAST/2026", yesterday);
      await hearingCase("HRG-TODAY/2026", today);
      await hearingCase("HRG-EDGE/2026", addDaysToIsoDate(today, 7));
      await hearingCase("HRG-BEYOND/2026", addDaysToIsoDate(today, 8));
      // WP-1/2026 (the base case) is the dateless fixture.
    });

    it("the window is [today, today+N] inclusive: past, beyond, and dateless never match", async () => {
      const week = await cases.list({ hearingWithinDays: 7 }, asUser(asha));
      expect(week.items.map((c) => c.spec?.caseNumber)).toEqual([
        "HRG-TODAY/2026",
        "HRG-EDGE/2026",
      ]);
      expect(week.totalCount).toBe(2n);
    });

    it("0 means no narrowing — the pre-T05 list, unchanged", async () => {
      const all = await cases.list({}, asUser(asha));
      expect(all.totalCount).toBe(5n);
    });

    it("the horizon is capped: 91 days is refused by validation", async () => {
      await expectCode(cases.list({ hearingWithinDays: 91 }, asUser(asha)), Code.InvalidArgument);
    });

    it("unscheduled_only answers exactly the dateless matters", async () => {
      const unscheduled = await cases.list({ unscheduledOnly: true }, asUser(asha));
      expect(unscheduled.items.map((c) => c.spec?.caseNumber)).toEqual(["WP-1/2026"]);
      expect(unscheduled.totalCount).toBe(1n);
    });

    it("a window AND unscheduled is contradictory — refused, not guessed", async () => {
      await expectCode(
        cases.list({ hearingWithinDays: 7, unscheduledOnly: true }, asUser(asha)),
        Code.InvalidArgument,
        /mutually exclusive/,
      );
    });
  });
});
