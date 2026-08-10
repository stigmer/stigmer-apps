/**
 * The storage registry: one PostgresResourceStore configured with every
 * resource kind's table mapping — the app is the composition root, so
 * cross-package references (FirmMember.user_id → the identity User)
 * resolve by kind through this ONE store. Identity's kinds arrive from
 * `@stigmer/identity/postgres` beside its migration source; each app
 * kind's table, generated columns, and indexes live in its migration file
 * (backend/migrations), and this registry must mirror those migrations
 * exactly — the integration tests run against the real migrations, so a
 * mismatch cannot survive its first test run.
 *
 * Registered logical fields are the CLOSED filter/order/search/sum
 * vocabulary per kind (DD-008 D4 discipline): a field appears here
 * because a named predicate, derivation, or policy lookup reads it, and
 * for no other reason. `id` is registered where a predicate composes an
 * id set (the membership-scoped case list).
 */

import type pg from "pg";
import type { ResourceStore } from "@stigmer/resource-api";
import { PostgresResourceStore } from "@stigmer/resource-api/postgres";
import { identityStoreKinds } from "@stigmer/identity/postgres";
import { AuditEntrySchema } from "./gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { CaseSchema } from "./gen/stigmer/law/case/v1/case_pb.js";
import { CaseMemberSchema } from "./gen/stigmer/law/casemember/v1/casemember_pb.js";
import { CaseNoteSchema } from "./gen/stigmer/law/casenote/v1/casenote_pb.js";
import { ClientSchema } from "./gen/stigmer/law/client/v1/client_pb.js";
import { DeadlineSchema } from "./gen/stigmer/law/deadline/v1/deadline_pb.js";
import { DocumentSchema } from "./gen/stigmer/law/document/v1/document_pb.js";
import { FeeArrangementSchema } from "./gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import { FirmMemberSchema } from "./gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { HearingSchema } from "./gen/stigmer/law/hearing/v1/hearing_pb.js";
import { LedgerEntrySchema } from "./gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { NotificationSchema } from "./gen/stigmer/law/notification/v1/notification_pb.js";
import { TaskSchema } from "./gen/stigmer/law/task/v1/task_pb.js";
import { TaskCommentSchema } from "./gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";

export function createResourceStore(pool: pg.Pool): ResourceStore {
  return new PostgresResourceStore(pool, {
    ...identityStoreKinds(),
    Client: {
      schema: ClientSchema,
      table: "clients",
      columns: {
        displayName: "display_name",
        createdAt: "created_at",
      },
    },
    FirmMember: {
      schema: FirmMemberSchema,
      table: "firm_members",
      naturalKey: { column: "user_id", jsonField: "userId" },
      columns: {
        role: "role",
        active: "active",
        createdAt: "created_at",
      },
    },
    Case: {
      schema: CaseSchema,
      table: "cases",
      naturalKey: { column: "file_number", jsonField: "fileNumber" },
      columns: {
        id: "id",
        courtCaseNumber: "court_case_number",
        clientId: "client_id",
        leadLawyerId: "lead_lawyer_id",
        forumKind: "forum_kind",
        lifecycle: "lifecycle",
        nextHearingDate: "next_hearing_date",
        opposingPartiesText: "opposing_parties_text",
        createdAt: "created_at",
      },
    },
    CaseMember: {
      schema: CaseMemberSchema,
      table: "case_members",
      // The composed pair — the definition's naturalKey.get builds the
      // same `{caseId}:{memberId}` string this column stores.
      naturalKey: { column: "member_key", jsonField: "caseId" },
      columns: {
        caseId: "case_id",
        memberId: "member_id",
        active: "active",
        createdAt: "created_at",
      },
    },
    Hearing: {
      schema: HearingSchema,
      table: "hearings",
      columns: {
        caseId: "case_id",
        date: "date",
        outcomeKind: "outcome_kind",
        createdAt: "created_at",
      },
    },
    Deadline: {
      schema: DeadlineSchema,
      table: "deadlines",
      columns: {
        caseId: "case_id",
        dueDate: "due_date",
        ownerId: "owner_id",
        state: "state",
        createdAt: "created_at",
      },
    },
    FeeArrangement: {
      schema: FeeArrangementSchema,
      table: "fee_arrangements",
      naturalKey: { column: "case_id", jsonField: "caseId" },
    },
    LedgerEntry: {
      schema: LedgerEntrySchema,
      table: "ledger_entries",
      columns: {
        caseId: "case_id",
        entryKind: "entry_kind",
        amountPaise: "amount_paise",
        date: "date",
        createdAt: "created_at",
      },
    },
    Task: {
      schema: TaskSchema,
      table: "tasks",
      columns: {
        caseId: "case_id",
        assigneeId: "assignee_id",
        dueDate: "due_date",
        // Stored lifecycle state — the open/overdue named predicates
        // filter on it; values are proto3-JSON enum names.
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
        category: "category",
        hearingId: "hearing_id",
        createdAt: "created_at",
      },
    },
    AuditEntry: {
      schema: AuditEntrySchema,
      table: "audit_entries",
      naturalKey: { column: "dedup_key", jsonField: "dedupKey" },
      columns: {
        caseId: "case_id",
        createdAt: "created_at",
      },
    },
  });
}
