/**
 * CaseNote + TaskComment acceptance tests — the two append-only
 * resources, sharing a file because they are the same recipe with
 * opposite reading orders (notes newest-first, comments oldest-first).
 * Full production path over real HTTP + real Postgres (Testcontainers)
 * with the real migrations.
 *
 * Source: design-decisions/001-mvp-scope-contract.md record-model rows.
 */

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaseSchema, CaseService } from "../gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseNoteSchema,
  CaseNoteService,
} from "../gen/stigmer/law/casenote/v1/casenote_pb.js";
import { TaskSchema, TaskService } from "../gen/stigmer/law/task/v1/task_pb.js";
import {
  TaskCommentSchema,
  TaskCommentService,
} from "../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";
import { UserSchema, UserService } from "../gen/stigmer/law/user/v1/user_pb.js";
import { createPgCredentialStore } from "../domain/user/credentials.js";
import { memoryObjectStore } from "./memory-object-store.js";
import { createBackendServer } from "../server.js";
import { createResourceStore } from "../storage.js";

const MIGRATIONS_DIR = new URL("../../migrations", import.meta.url).pathname;

const asUser = (id: string) => ({ headers: { "x-dev-caller-id": id } });
const asOperator = () => ({
  headers: { "x-dev-caller-id": "ops-one", "x-dev-caller-kind": "operator" },
});

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

describe("CaseNote and TaskComment resources", () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let server: http.Server;
  let transport: Transport;
  let notes: Client<typeof CaseNoteService>;
  let comments: Client<typeof TaskCommentService>;

  let lawyer = "";
  let caseId = "";
  let otherCaseId = "";
  let taskId = "";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool, MIGRATIONS_DIR);

    server = createBackendServer({
      store: createResourceStore(pool),
      credentials: createPgCredentialStore(pool),
      objectStore: memoryObjectStore(),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    transport = createConnectTransport({
      baseUrl: `http://localhost:${port}`,
      httpVersion: "1.1",
    });
    notes = createClient(CaseNoteService, transport);
    comments = createClient(TaskCommentService, transport);

    const users = createClient(UserService, transport);
    lawyer = (
      await users.create(create(UserSchema, { spec: { email: "note-author@example.com" } }), asOperator())
    ).metadata?.id as string;

    const cases = createClient(CaseService, transport);
    const makeCase = async (caseNumber: string) =>
      (
        await cases.create(
          create(CaseSchema, {
            spec: { caseNumber, clientName: "Client", caseType: "civil", assignedLawyerId: lawyer },
          }),
          asUser(lawyer),
        )
      ).metadata?.id as string;
    caseId = await makeCase("WP-1/2026");
    otherCaseId = await makeCase("WP-2/2026");

    const tasks = createClient(TaskService, transport);
    taskId = (
      await tasks.create(
        create(TaskSchema, { spec: { caseId, title: "Collect vakalatnama" } }),
        asUser(lawyer),
      )
    ).metadata?.id as string;
  }, 120_000);

  afterEach(async () => {
    await pool.query("DELETE FROM case_notes");
    await pool.query("DELETE FROM task_comments");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await pool.end();
    await container.stop();
  });

  describe("case notes (append-only, newest first)", () => {
    const noteInput = (content: string, forCase = caseId) =>
      create(CaseNoteSchema, { spec: { caseId: forCase, content } });

    it("stamps the envelope — created_by/created_at ARE the author and date", async () => {
      const note = await notes.create(noteInput("Client called about the adjournment"), asUser(lawyer));
      expect(note.metadata?.id).toMatch(/^note_[0-9a-z]{26}$/);
      expect(note.metadata?.createdBy?.id).toBe(lawyer);
      expect(note.metadata?.createdAt).toBeDefined();
      expect(note.apiVersion).toBe("law.stigmer.ai/v1");
      expect(note.kind).toBe("CaseNote");
      expect(note.spec?.content).toBe("Client called about the adjournment");
    });

    it("rejects a case that does not exist (reference check)", async () => {
      await expectCode(
        notes.create(noteInput("x", "case_ghost"), asUser(lawyer)),
        Code.FailedPrecondition,
        /case 'case_ghost' not found/,
      );
    });

    it("rejects empty content and content over 5000 characters", async () => {
      await expectCode(notes.create(noteInput(""), asUser(lawyer)), Code.InvalidArgument, /content/);
      await expectCode(
        notes.create(noteInput("x".repeat(5001)), asUser(lawyer)),
        Code.InvalidArgument,
        /content/,
      );
    });

    it("lists one case's notes newest first with a stable total", async () => {
      await notes.create(noteInput("first"), asUser(lawyer));
      await notes.create(noteInput("second"), asUser(lawyer));
      await notes.create(noteInput("other case"), asUser(lawyer));
      // A different case's note never leaks into this case's thread.
      await notes.create(noteInput("elsewhere", otherCaseId), asUser(lawyer));

      const list = await notes.list({ caseId }, asUser(lawyer));
      expect(list.items.map((n) => n.spec?.content)).toEqual(["other case", "second", "first"]);
      expect(list.totalCount).toBe(3n);
    });

    it("requires the case reference on list and authentication everywhere", async () => {
      await expectCode(notes.list({ caseId: "" }, asUser(lawyer)), Code.InvalidArgument, /case_id/);
      await expectCode(notes.list({ caseId }), Code.Unauthenticated);
      await expectCode(notes.create(noteInput("x")), Code.Unauthenticated);
    });

    it("declares exactly create/list — append-only is the contract", () => {
      expect(CaseNoteService.methods.map((m) => m.localName).sort()).toEqual(["create", "list"]);
    });
  });

  describe("task comments (append-only, oldest first)", () => {
    const commentInput = (content: string, forTask = taskId) =>
      create(TaskCommentSchema, { spec: { taskId: forTask, content } });

    it("stamps the envelope and lists oldest first — a conversation reads top-down", async () => {
      const comment = await comments.create(commentInput("Started on this"), asUser(lawyer));
      expect(comment.metadata?.id).toMatch(/^cmt_[0-9a-z]{26}$/);
      expect(comment.metadata?.createdBy?.id).toBe(lawyer);
      expect(comment.kind).toBe("TaskComment");

      await comments.create(commentInput("Blocked on the certified copy"), asUser(lawyer));
      const list = await comments.list({ taskId }, asUser(lawyer));
      expect(list.items.map((c) => c.spec?.content)).toEqual([
        "Started on this",
        "Blocked on the certified copy",
      ]);
      expect(list.totalCount).toBe(2n);
    });

    it("rejects a task that does not exist (reference check)", async () => {
      await expectCode(
        comments.create(commentInput("x", "task_ghost"), asUser(lawyer)),
        Code.FailedPrecondition,
        /task 'task_ghost' not found/,
      );
    });

    it("rejects empty content and content over 2000 characters", async () => {
      await expectCode(comments.create(commentInput(""), asUser(lawyer)), Code.InvalidArgument, /content/);
      await expectCode(
        comments.create(commentInput("x".repeat(2001)), asUser(lawyer)),
        Code.InvalidArgument,
        /content/,
      );
    });

    it("requires the task reference on list and authentication everywhere", async () => {
      await expectCode(comments.list({ taskId: "" }, asUser(lawyer)), Code.InvalidArgument, /task_id/);
      await expectCode(comments.list({ taskId }), Code.Unauthenticated);
      await expectCode(comments.create(commentInput("x")), Code.Unauthenticated);
    });

    it("declares exactly create/list — append-only is the contract", () => {
      expect(TaskCommentService.methods.map((m) => m.localName).sort()).toEqual(["create", "list"]);
    });
  });
});
