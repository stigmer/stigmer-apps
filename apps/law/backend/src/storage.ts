/**
 * The storage registry: one PostgresResourceStore configured with every
 * resource kind's table mapping — the app is the composition root, so
 * cross-package references (Case.assigned_lawyer_id → the identity User)
 * resolve by kind through this ONE store. Identity's kinds arrive from
 * `@stigmer/identity/postgres` beside its migration source; each app
 * kind's table, generated columns, and indexes live in its migration file
 * (backend/migrations), and this registry must mirror those migrations
 * exactly — the integration tests run against the real migrations, so a
 * mismatch cannot survive its first test run.
 */

import type pg from "pg";
import type { ResourceStore } from "@stigmer/resource-api";
import { PostgresResourceStore } from "@stigmer/resource-api/postgres";
import { identityStoreKinds } from "@stigmer/identity/postgres";
import { CaseSchema } from "./gen/stigmer/law/case/v1/case_pb.js";
import { CaseNoteSchema } from "./gen/stigmer/law/casenote/v1/casenote_pb.js";
import { DocumentSchema } from "./gen/stigmer/law/document/v1/document_pb.js";
import { NotificationSchema } from "./gen/stigmer/law/notification/v1/notification_pb.js";
import { TaskSchema } from "./gen/stigmer/law/task/v1/task_pb.js";
import { TaskCommentSchema } from "./gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";

export function createResourceStore(pool: pg.Pool): ResourceStore {
  return new PostgresResourceStore(pool, {
    ...identityStoreKinds(),
    Case: {
      schema: CaseSchema,
      table: "cases",
      naturalKey: { column: "case_number", jsonField: "caseNumber" },
      columns: {
        nextHearingDate: "next_hearing_date",
      },
    },
    Task: {
      schema: TaskSchema,
      table: "tasks",
      columns: {
        caseId: "case_id",
        assigneeId: "assignee_id",
        dueDate: "due_date",
        // Stored lifecycle state (0007) — the open/overdue named
        // predicates filter on it; values are proto3-JSON enum names.
        state: "state",
      },
    },
    Notification: {
      schema: NotificationSchema,
      table: "notifications",
      naturalKey: { column: "dedup_key", jsonField: "dedupKey" },
      columns: {
        recipientId: "recipient_id",
        read: "read",
        createdAt: "created_at",
      },
    },
    CaseNote: {
      schema: CaseNoteSchema,
      table: "case_notes",
      columns: {
        caseId: "case_id",
        createdAt: "created_at",
      },
    },
    TaskComment: {
      schema: TaskCommentSchema,
      table: "task_comments",
      columns: {
        taskId: "task_id",
        createdAt: "created_at",
      },
    },
    Document: {
      schema: DocumentSchema,
      table: "documents",
      columns: {
        caseId: "case_id",
        createdAt: "created_at",
      },
    },
  });
}
