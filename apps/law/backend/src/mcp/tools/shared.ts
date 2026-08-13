/**
 * Shared shapes and resolution helpers for the tool modules.
 *
 * Two rules bind every tool:
 *
 * 1. **Tools compose, never compute.** A tool assembles typed pipeline
 *    answers (items, server-computed totals, derived fields) into
 *    phone-screen sentences. The moment a tool derives a business fact,
 *    that fact belongs in the contract instead — the discipline that
 *    keeps the web app a thin shell applies here verbatim.
 * 2. **Ids travel in the answer.** Writes like update_task_status can
 *    only be reached through an id a previous read returned. Ids ride
 *    the text lines (the model's only guaranteed view) AND
 *    structuredContent; the agent's instructions keep them out of the
 *    human-facing reply.
 */

import { create } from "@bufbuild/protobuf";
import type { CallerIdentityResolver } from "@stigmer/identity";
import type {
  AuthorizationPolicy,
  CallerPrincipal,
  ResourceStore,
} from "@stigmer/resource-api";
import type {
  CaseDocumentInput,
} from "../../domain/document/store-document.js";
import type { FetchedDocument } from "../../files/remote-fetch.js";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { GetCaseRequestSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { Deadline } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { ListFirmMembersRequestSchema } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import type { Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import type { AppResources } from "../../routes.js";
import { formatBytes, formatCategory, formatDate, formatOutcome, formatState } from "../format.js";

export interface ToolDeps {
  readonly resources: AppResources;
  readonly resolveCallerIdentity: CallerIdentityResolver;
  /**
   * The one shared store — for page-shaped DISPLAY lookups only (file
   * numbers for lines the caller already received through authorized
   * pipelines). Tools never write through it and never widen access
   * with it (DD-A4: writes ride invoke).
   */
  readonly store: ResourceStore;
  /**
   * The policy oracle, for PRE-authorization in front of expensive or
   * external side effects only (attach_document checks Document/create
   * before fetching remote bytes — the upload route's "one policy, two
   * enforcement points" arrangement). Never a substitute for the
   * pipeline's own authorization, which still runs on every write.
   */
  readonly policy: AuthorizationPolicy;
  /**
   * The guarded byte entrance for model-quoted URLs (files/
   * remote-fetch.ts) and the one document store implementation
   * (domain/document/store-document.ts), injected as narrow
   * capabilities: rule 1 above means a tool composes these, and the
   * raw ObjectStore never enters the tool layer.
   */
  readonly fetchDocument: (url: string) => Promise<FetchedDocument>;
  readonly storeDocument: (
    input: CaseDocumentInput,
    caller: CallerPrincipal,
  ) => Promise<Document>;
  /**
   * Whether this deployment reads scans (the OCR sweep is configured
   * AND enabled). The honesty sentences depend on it: promising "being
   * read — try again shortly" on a deployment that will never read the
   * scan is the exact dishonesty the tools exist to avoid (DD-009; the
   * credits notice is the deployment-conditional precedent).
   */
  readonly ocrEnabled: boolean;
}

/** File numbers for answer lines — one bulk lookup, never N+1. */
export async function fileNumbersByCaseId(
  store: ResourceStore,
  caseIds: readonly string[],
): Promise<(caseId: string | undefined) => string | undefined> {
  const unique = [...new Set(caseIds.filter((id): id is string => !!id))];
  const cases = await store.getByIds("Case", unique);
  return (caseId) =>
    ((cases.get(caseId ?? "") as Case | undefined)?.spec?.fileNumber) || undefined;
}

/**
 * Resolves a person the caller NAMED (an assignee, a deadline owner) to
 * their FirmMember — spec person references are FirmMember ids on the
 * rebuilt contract. Exact match on the profile's derived name or email,
 * exactly one or refuse naming the candidates: a wrong guess about
 * "Ravi" answers with the wrong person's caseload.
 */
export async function resolveMemberByNameOrEmail(
  resources: AppResources,
  principal: CallerPrincipal,
  nameOrEmail: string,
): Promise<{ readonly member: FirmMember } | { readonly refusal: string }> {
  const needle = nameOrEmail.trim().toLowerCase();
  const page = await resources.firmMembers.invoke.list(
    create(ListFirmMembersRequestSchema, { pageSize: 100 }),
    principal,
  );
  if (page.totalCount > 100n) {
    return {
      refusal:
        "The firm has too many members to match by name — use the person's " +
        "exact email address instead.",
    };
  }
  const matches = (page.items as FirmMember[]).filter(
    (m) =>
      m.status?.userEmail?.toLowerCase() === needle ||
      m.status?.userName?.toLowerCase() === needle,
  );
  if (matches.length === 1) {
    return { member: matches[0] as FirmMember };
  }
  if (matches.length === 0) {
    return {
      refusal: `I couldn't find anyone called "${nameOrEmail.trim()}" in the firm. Use their exact name or email.`,
    };
  }
  const candidates = matches
    .map((m) => `${m.status?.userName} (${m.status?.userEmail})`)
    .join(", ");
  return {
    refusal: `More than one person matches "${nameOrEmail.trim()}": ${candidates}. Use the email address to be exact.`,
  };
}

/** Loads a case by the firm's file number — NOT_FOUND (and the policy's
 * membership denial) relay clean sentences through the gate. */
export function caseByFileNumber(
  resources: AppResources,
  principal: CallerPrincipal,
  fileNumber: string,
): Promise<Case> {
  return resources.cases.invoke.get(
    create(GetCaseRequestSchema, { fileNumber: fileNumber.trim() }),
    principal,
  );
}

/** One task as a model-facing text line: human facts first, id last. */
export function taskLine(task: Task): string {
  const due = task.spec?.dueDate
    ? `due ${formatDate(task.spec.dueDate)}${task.status?.overdue ? " (OVERDUE)" : ""}`
    : "no due date";
  const caseRef = task.status?.caseFileNumber ? ` · ${task.status.caseFileNumber}` : "";
  return `${task.spec?.title} — ${due}, ${formatState(task.status?.state ?? 0)}${caseRef} · id ${task.metadata?.id}`;
}

/** One task as structured content. */
export function taskRecord(task: Task): Record<string, unknown> {
  return {
    id: task.metadata?.id,
    title: task.spec?.title,
    file_number: task.status?.caseFileNumber || undefined,
    due_date: task.spec?.dueDate,
    state: formatState(task.status?.state ?? 0),
    overdue: task.status?.overdue ?? false,
    assignee_id: task.spec?.assigneeId,
  };
}

/** One hearing as a diary/board line. */
export function hearingLine(hearing: Hearing, fileNumber?: string): string {
  const listing = [
    hearing.spec?.listSerialNumber ? `item ${hearing.spec.listSerialNumber}` : "",
    hearing.spec?.courtHall ? `hall ${hearing.spec.courtHall}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const state = hearing.status?.outcomeKind
    ? formatOutcome(hearing.status.outcomeKind) +
      (hearing.status.nextDate ? `, next ${formatDate(hearing.status.nextDate)}` : "")
    : "scheduled";
  return [
    fileNumber ? `${fileNumber} — ` : "",
    formatDate(hearing.spec?.date),
    hearing.spec?.purpose ? ` for ${hearing.spec.purpose}` : "",
    listing ? ` (${listing})` : "",
    `: ${state}`,
    ` · id ${hearing.metadata?.id}`,
  ].join("");
}

/** One deadline as a nudge line. */
export function deadlineLine(deadline: Deadline, fileNumber?: string): string {
  const overdue = deadline.status?.overdue ? " (OVERDUE)" : "";
  const caseRef = fileNumber ? ` · ${fileNumber}` : "";
  return `${deadline.spec?.title} — due ${formatDate(deadline.spec?.dueDate)}${overdue}${caseRef} · id ${deadline.metadata?.id}`;
}

/** One document as a register line: what the paper is, then the record
 * facts. The upload day comes from metadata (documents are immutable —
 * created IS the only date they have). */
export function documentLine(document: Document, fileNumber?: string): string {
  const caseRef = fileNumber ? `${fileNumber} — ` : "";
  const uploaded = document.metadata?.createdAt?.seconds;
  const day = uploaded
    ? formatDate(new Date(Number(uploaded) * 1000).toISOString().slice(0, 10))
    : "unknown date";
  return (
    `${caseRef}${document.spec?.fileName} — ${formatCategory(document.spec?.category ?? 0)}, ` +
    `uploaded ${day} (${formatBytes(document.spec?.sizeBytes ?? 0n)}) · id ${document.metadata?.id}`
  );
}

/** One document as structured content. */
export function documentRecord(document: Document, fileNumber?: string): Record<string, unknown> {
  return {
    id: document.metadata?.id,
    file_name: document.spec?.fileName,
    category: formatCategory(document.spec?.category ?? 0),
    file_number: fileNumber,
    size_bytes: Number(document.spec?.sizeBytes ?? 0n),
    hearing_id: document.spec?.hearingId || undefined,
  };
}
