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
 * 2. **Ids travel in the answer.** Tasks deliberately have no
 *    user-facing identifier (no natural key, by contract), so a write
 *    like update_task_status can only be reached through an id a
 *    previous read returned. Ids ride the text lines (the model's
 *    only guaranteed view) AND structuredContent; the agent's
 *    instructions keep them out of the human-facing reply.
 */

import { create } from "@bufbuild/protobuf";
import type { ChannelIdentityResolver, User } from "@stigmer/identity";
import { ListUsersRequestSchema } from "@stigmer/identity";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { GetCaseRequestSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import type { AppResources } from "../../routes.js";
import type { CallerPrincipal } from "@stigmer/resource-api";
import { formatDate, formatState } from "../format.js";

export interface ToolDeps {
  readonly resources: AppResources;
  readonly resolveChannelIdentity: ChannelIdentityResolver;
}

/**
 * Resolves a person the caller NAMED (an assignee argument) — distinct
 * from resolving the caller themself, but under the same discipline:
 * exact match on email or display name, exactly one or refuse naming
 * the candidates. Deliberately not fuzzy search — search is out of the
 * MVP scope contract, and a wrong guess about "Ravi" answers with the
 * wrong person's caseload.
 */
export async function resolvePersonByNameOrEmail(
  resources: AppResources,
  principal: CallerPrincipal,
  nameOrEmail: string,
): Promise<{ readonly user: User } | { readonly refusal: string }> {
  const needle = nameOrEmail.trim().toLowerCase();
  const page = await resources.users.invoke.list(
    create(ListUsersRequestSchema, { pageSize: 100 }),
    principal,
  );
  if (page.totalCount > 100n) {
    return {
      refusal:
        "The firm has too many members to match by name — use the person's " +
        "exact email address instead.",
    };
  }
  const matches = page.items.filter(
    (u) =>
      u.spec?.email?.toLowerCase() === needle ||
      u.spec?.name?.toLowerCase() === needle,
  );
  if (matches.length === 1) {
    return { user: matches[0] as User };
  }
  if (matches.length === 0) {
    return {
      refusal: `I couldn't find anyone called "${nameOrEmail.trim()}" in the firm. Use their exact name or email.`,
    };
  }
  const candidates = matches
    .map((u) => `${u.spec?.name} (${u.spec?.email})`)
    .join(", ");
  return {
    refusal: `More than one person matches "${nameOrEmail.trim()}": ${candidates}. Use the email address to be exact.`,
  };
}

/** Loads a case by its court number — NOT_FOUND relays a clean sentence. */
export function caseByNumber(
  resources: AppResources,
  principal: CallerPrincipal,
  caseNumber: string,
): Promise<Case> {
  return resources.cases.invoke.get(
    create(GetCaseRequestSchema, { caseNumber: caseNumber.trim() }),
    principal,
  );
}

/** One task as a model-facing text line: human facts first, id last. */
export function taskLine(task: Task): string {
  const due = task.spec?.dueDate
    ? `due ${formatDate(task.spec.dueDate)}${task.status?.overdue ? " (OVERDUE)" : ""}`
    : "no due date";
  const caseRef = task.status?.caseNumber ? ` · case ${task.status.caseNumber}` : "";
  return `${task.spec?.title} — ${due}, ${formatState(task.status?.state ?? 0)}${caseRef} · id ${task.metadata?.id}`;
}

/** One task as structured content. */
export function taskRecord(task: Task): Record<string, unknown> {
  return {
    id: task.metadata?.id,
    title: task.spec?.title,
    case_number: task.status?.caseNumber || undefined,
    due_date: task.spec?.dueDate,
    state: formatState(task.status?.state ?? 0),
    overdue: task.status?.overdue ?? false,
    assignee_id: task.spec?.assigneeId,
  };
}
