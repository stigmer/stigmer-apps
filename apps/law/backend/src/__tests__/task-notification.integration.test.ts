/**
 * Task + Notification acceptance tests — one file because the scope
 * contract binds them: TASK_ASSIGNMENT notifications are a consumer of
 * Task resource events (publish slot, never handler code), and the ONLY
 * way a notification comes to exist is that real path: Task pipeline →
 * dispatcher → handler → Notification create pipeline via the in-process
 * invoker. Full production path over real HTTP + real Postgres
 * (Testcontainers) with the real migrations and the real dispatcher.
 *
 * Sources: design-decisions/001-mvp-scope-contract.md (Task and
 * Notification record-model rows, the notifications section) as amended
 * by T03 D8; tasks/T03_0_plan.md.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { InProcessEventDispatcher } from "@stigmer/resource-api";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { UserSchema, UserService } from "@stigmer/identity";
import { createPgCredentialStore, createPgRefreshTokenStore } from "@stigmer/identity/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { createTestPool } from "./test-pool.js";
import { createTestAuth, type TestAuth } from "./test-auth.js";
import { testMigrationSources } from "./test-migrations.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import {
  NotificationService,
  NotificationType,
} from "../gen/stigmer/law/notification/v1/notification_pb.js";
import {
  TaskPriority,
  TaskSchema,
  TaskService,
  TaskState,
} from "../gen/stigmer/law/task/v1/task_pb.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

let auth: TestAuth;
const asUser = (id: string) => auth.as(id);
const asOperator = () => auth.asOperator();

/**
 * Notification ordering is createdAt-descending, and two notifications
 * born in the same millisecond tie nondeterministically (the DD-003
 * known flake) — separate order-sensitive creations by a real instant.
 */
const nextInstant = () => new Promise((resolve) => setTimeout(resolve, 5));

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

describe("Task and Notification resources", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let transport: Transport;
  let tasks: Client<typeof TaskService>;
  let notifications: Client<typeof NotificationService>;

  // Real principals: My-Tasks defaults and recipient scoping key off the
  // caller id being a real User id.
  let asha = ""; // creates most tasks
  let bina = ""; // the usual assignee
  let caseId = "";

  function taskInput(overrides: Partial<{
    caseId: string;
    title: string;
    assigneeId: string;
    dueDate: string;
    priority: TaskPriority;
  }> = {}) {
    return create(TaskSchema, {
      spec: {
        caseId: overrides.caseId ?? caseId,
        title: overrides.title ?? "Draft counter-affidavit",
        assigneeId: overrides.assigneeId,
        dueDate: overrides.dueDate,
        priority: overrides.priority ?? TaskPriority.UNSPECIFIED,
      },
    });
  }

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
      dispatcher: new InProcessEventDispatcher(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    transport = createConnectTransport({
      baseUrl: `http://localhost:${port}`,
      httpVersion: "1.1",
    });
    tasks = createClient(TaskService, transport);
    notifications = createClient(NotificationService, transport);

    const users = createClient(UserService, transport);
    asha = (
      await users.create(create(UserSchema, { spec: { email: "asha@example.com" } }), asOperator())
    ).metadata?.id as string;
    bina = (
      await users.create(create(UserSchema, { spec: { email: "bina@example.com" } }), asOperator())
    ).metadata?.id as string;
    await auth.mint(asha, bina);

    const cases = createClient(CaseService, transport);
    caseId = (
      await cases.create(
        create(CaseSchema, {
          spec: {
            caseNumber: "CRL-9/2026",
            clientName: "Base Client",
            caseType: "criminal",
            assignedLawyerId: asha,
          },
        }),
        asUser(asha),
      )
    ).metadata?.id as string;
  }, 120_000);

  afterEach(async () => {
    await pool.query("DELETE FROM notifications");
    await pool.query("DELETE FROM tasks");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
  });

  describe("task create (record model)", () => {
    it("stamps the envelope and applies the domain defaults: MEDIUM priority, OPEN state", async () => {
      const created = await tasks.create(taskInput(), asUser(asha));

      expect(created.metadata?.id).toMatch(/^task_[0-9a-z]{26}$/);
      expect(created.metadata?.version).toBe(1n);
      expect(created.apiVersion).toBe("law.stigmer.ai/v1");
      expect(created.kind).toBe("Task");
      expect(created.spec?.priority).toBe(TaskPriority.MEDIUM);
      expect(created.status?.state).toBe(TaskState.OPEN);
      expect(created.status?.overdue).toBe(false);
    });

    it("keeps an explicit priority instead of the default", async () => {
      const created = await tasks.create(
        taskInput({ priority: TaskPriority.HIGH }),
        asUser(asha),
      );
      expect(created.spec?.priority).toBe(TaskPriority.HIGH);
    });

    it("rejects a case that does not exist (reference check)", async () => {
      await expectCode(
        tasks.create(taskInput({ caseId: "case_ghost" }), asUser(asha)),
        Code.FailedPrecondition,
        /case 'case_ghost' not found/,
      );
    });

    it("rejects an assignee that does not exist (reference check)", async () => {
      await expectCode(
        tasks.create(taskInput({ assigneeId: "user_ghost" }), asUser(asha)),
        Code.FailedPrecondition,
        /assignee 'user_ghost' not found/,
      );
    });

    it("rejects a missing case_id and an over-long title (validation before references)", async () => {
      await expectCode(
        tasks.create(taskInput({ caseId: "" }), asUser(asha)),
        Code.InvalidArgument,
        /case_id/,
      );
      await expectCode(
        tasks.create(taskInput({ title: "x".repeat(201) }), asUser(asha)),
        Code.InvalidArgument,
        /title/,
      );
    });

    it("rejects a malformed due date (calendar date, not an instant)", async () => {
      await expectCode(
        tasks.create(taskInput({ dueDate: "01-09-2026" }), asUser(asha)),
        Code.InvalidArgument,
        /due_date/,
      );
    });

    it("requires authentication", async () => {
      await expectCode(tasks.create(taskInput()), Code.Unauthenticated);
    });
  });

  describe("task lifecycle (state via updateStatus ONLY)", () => {
    it("transitions OPEN → IN_PROGRESS → CLOSED, bumping the version each time", async () => {
      const created = await tasks.create(taskInput(), asUser(asha));
      const id = created.metadata?.id ?? "";

      const inProgress = await tasks.updateStatus(
        { id, state: TaskState.IN_PROGRESS },
        asUser(bina),
      );
      expect(inProgress.status?.state).toBe(TaskState.IN_PROGRESS);
      expect(inProgress.metadata?.version).toBe(2n);
      expect(inProgress.metadata?.updatedBy?.id).toBe(bina);

      const closed = await tasks.updateStatus({ id, state: TaskState.CLOSED }, asUser(bina));
      expect(closed.status?.state).toBe(TaskState.CLOSED);
      expect(closed.metadata?.version).toBe(3n);
    });

    it("a spec update can NEVER change the state — stored status survives, smuggled status is discarded", async () => {
      const created = await tasks.create(taskInput(), asUser(asha));
      const id = created.metadata?.id ?? "";
      await tasks.updateStatus({ id, state: TaskState.IN_PROGRESS }, asUser(asha));

      const edit = create(TaskSchema, {
        metadata: { id },
        spec: { caseId, title: "Draft counter-affidavit (revised)" },
        // The smuggle attempt:
        status: { state: TaskState.CLOSED },
      });
      const updated = await tasks.update(edit, asUser(asha));
      expect(updated.spec?.title).toBe("Draft counter-affidavit (revised)");
      expect(updated.status?.state).toBe(TaskState.IN_PROGRESS);
    });

    it("rejects UNSPECIFIED state and answers NOT_FOUND for an unknown task", async () => {
      const created = await tasks.create(taskInput(), asUser(asha));
      await expectCode(
        tasks.updateStatus(
          { id: created.metadata?.id ?? "", state: TaskState.UNSPECIFIED },
          asUser(asha),
        ),
        Code.InvalidArgument,
        /state/,
      );
      await expectCode(
        tasks.updateStatus(
          { id: "task_00000000000000000000000000", state: TaskState.CLOSED },
          asUser(asha),
        ),
        Code.NotFound,
        /task_0{26}/,
      );
    });

    it("derives overdue on read: past due date and not CLOSED", async () => {
      const overdue = await tasks.create(
        taskInput({ title: "was due long ago", dueDate: "2020-01-01" }),
        asUser(asha),
      );
      expect(overdue.status?.overdue).toBe(true);

      const closed = await tasks.updateStatus(
        { id: overdue.metadata?.id ?? "", state: TaskState.CLOSED },
        asUser(asha),
      );
      expect(closed.status?.overdue).toBe(false);

      const dateless = await tasks.create(taskInput({ title: "no due date" }), asUser(asha));
      expect(dateless.status?.overdue).toBe(false);
    });
  });

  describe("task list (due_date asc dateless last; default 'My Tasks')", () => {
    it("defaults to the caller's assignments, ordered soonest-due first", async () => {
      await tasks.create(
        taskInput({ title: "mine-later", assigneeId: asha, dueDate: "2026-12-01" }),
        asUser(bina),
      );
      await tasks.create(taskInput({ title: "mine-dateless", assigneeId: asha }), asUser(bina));
      await tasks.create(
        taskInput({ title: "mine-soon", assigneeId: asha, dueDate: "2026-08-20" }),
        asUser(bina),
      );
      await tasks.create(
        taskInput({ title: "someone-elses", assigneeId: bina, dueDate: "2026-01-01" }),
        asUser(asha),
      );
      await tasks.create(taskInput({ title: "unassigned" }), asUser(asha));

      const mine = await tasks.list({}, asUser(asha));
      expect(mine.items.map((t) => t.spec?.title)).toEqual([
        "mine-soon",
        "mine-later",
        "mine-dateless",
      ]);
      expect(mine.totalCount).toBe(3n);
    });

    it("filters by case (the case detail view) and by an explicit assignee", async () => {
      await tasks.create(taskInput({ title: "a", assigneeId: asha }), asUser(asha));
      await tasks.create(taskInput({ title: "b", assigneeId: bina }), asUser(asha));
      await tasks.create(taskInput({ title: "c" }), asUser(asha));

      const forCase = await tasks.list({ caseId }, asUser(asha));
      expect(forCase.totalCount).toBe(3n);

      const binas = await tasks.list({ assigneeId: bina }, asUser(asha));
      expect(binas.items.map((t) => t.spec?.title)).toEqual(["b"]);
    });

    it("requires authentication", async () => {
      await expectCode(tasks.list({}), Code.Unauthenticated);
    });
  });

  describe("TASK_ASSIGNMENT notifications (publish slot, never handler code)", () => {
    it("assigning a task to someone else notifies them through the full pipeline", async () => {
      const task = await tasks.create(
        taskInput({ title: "File the appeal", assigneeId: bina }),
        asUser(asha),
      );

      const inbox = await notifications.list({}, asUser(bina));
      expect(inbox.totalCount).toBe(1n);
      const n = inbox.items[0];
      expect(n?.metadata?.id).toMatch(/^ntf_[0-9a-z]{26}$/);
      expect(n?.metadata?.createdBy?.id).toBe("system");
      expect(n?.spec?.type).toBe(NotificationType.TASK_ASSIGNMENT);
      expect(n?.spec?.recipientId).toBe(bina);
      expect(n?.spec?.body).toContain("File the appeal");
      expect(n?.spec?.target?.kind).toBe("Task");
      expect(n?.spec?.target?.id).toBe(task.metadata?.id);
      expect(n?.status?.read).toBe(false);
    });

    it("never notifies on self-assignment or when the assignee is unchanged", async () => {
      const own = await tasks.create(
        taskInput({ title: "self", assigneeId: asha }),
        asUser(asha),
      );
      // Status-only update and a spec edit keeping the assignee.
      await tasks.updateStatus(
        { id: own.metadata?.id ?? "", state: TaskState.IN_PROGRESS },
        asUser(bina),
      );
      const edit = create(TaskSchema, {
        metadata: { id: own.metadata?.id ?? "" },
        spec: { caseId, title: "self (renamed)", assigneeId: asha },
      });
      await tasks.update(edit, asUser(bina));

      expect((await notifications.list({}, asUser(asha))).totalCount).toBe(0n);
    });

    it("re-assignment A→B→A notifies A again — the dedup key includes the task version", async () => {
      const task = await tasks.create(
        taskInput({ title: "bounces", assigneeId: bina }),
        asUser(asha),
      );
      const id = task.metadata?.id ?? "";
      const reassign = (assigneeId: string) =>
        create(TaskSchema, { metadata: { id }, spec: { caseId, title: "bounces", assigneeId } });

      await tasks.update(reassign(asha), asUser(asha)); // to the actor: no notify
      await tasks.update(reassign(bina), asUser(asha)); // back to bina: notify again

      const inbox = await notifications.list({}, asUser(bina));
      expect(inbox.totalCount).toBe(2n);
      const keys = inbox.items.map((n) => n.spec?.dedupKey);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe("notification inbox (recipient-scoped, newest first)", () => {
    it("lists only the caller's own, newest first; unread badge is derived", async () => {
      await tasks.create(taskInput({ title: "first", assigneeId: bina }), asUser(asha));
      await nextInstant();
      await tasks.create(taskInput({ title: "second", assigneeId: bina }), asUser(asha));
      await tasks.create(taskInput({ title: "for-asha", assigneeId: asha }), asUser(bina));

      const binas = await notifications.list({}, asUser(bina));
      expect(binas.totalCount).toBe(2n);
      expect(binas.items.map((n) => n.spec?.body)).toEqual([
        'You have been assigned: "second"',
        'You have been assigned: "first"',
      ]);

      // The unread badge: totalCount of an unread-only page of one.
      const badge = await notifications.list({ unreadOnly: true, pageSize: 1 }, asUser(bina));
      expect(badge.totalCount).toBe(2n);
    });

    it("markRead is recipient-only: the recipient succeeds, anyone else is denied", async () => {
      await tasks.create(taskInput({ title: "t", assigneeId: bina }), asUser(asha));
      const target = (await notifications.list({}, asUser(bina))).items[0];
      const id = target?.metadata?.id ?? "";

      await expectCode(
        notifications.markRead({ id }, asUser(asha)),
        Code.PermissionDenied,
        /Only the recipient/,
      );

      const marked = await notifications.markRead({ id }, asUser(bina));
      expect(marked.status?.read).toBe(true);
      expect(marked.metadata?.version).toBe(2n);
      expect((await notifications.list({ unreadOnly: true }, asUser(bina))).totalCount).toBe(0n);
    });

    it("markAllRead marks the caller's unread and reports the count; a second call finds none", async () => {
      await tasks.create(taskInput({ title: "t1", assigneeId: bina }), asUser(asha));
      await tasks.create(taskInput({ title: "t2", assigneeId: bina }), asUser(asha));

      const first = await notifications.markAllRead({}, asUser(bina));
      expect(first.markedCount).toBe(2);
      expect((await notifications.list({ unreadOnly: true }, asUser(bina))).totalCount).toBe(0n);

      const second = await notifications.markAllRead({}, asUser(bina));
      expect(second.markedCount).toBe(0);
    });

    it("requires authentication", async () => {
      await expectCode(notifications.list({}), Code.Unauthenticated);
    });
  });

  describe("the operation matrices are the contracts", () => {
    it("Task declares exactly create/get/list/update/updateStatus — no delete", () => {
      expect(TaskService.methods.map((m) => m.localName).sort()).toEqual([
        "create",
        "get",
        "list",
        "update",
        "updateStatus",
      ]);
    });

    it("Notification declares exactly list/markRead/markAllRead — create is system-only, off the wire", () => {
      expect(NotificationService.methods.map((m) => m.localName).sort()).toEqual([
        "list",
        "markAllRead",
        "markRead",
      ]);
    });
  });
});
