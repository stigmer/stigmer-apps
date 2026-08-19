/**
 * Display formatting (T04b D5): DD/MM/YYYY and IST are the firm's locale
 * (FR-LANG-001) — and NOTHING here does timezone math. Calendar dates
 * (hearing dates, due dates) are plain YYYY-MM-DD strings on the wire and
 * reformat as strings; the one derived time fact, `overdue`, is computed
 * server-side in Asia/Kolkata (the record model). A client Date parse of
 * a calendar date would shift it a day for any user west of IST.
 *
 * This module is also the ONE place enum values become words: every
 * screen imports its labels from here, so the product speaks one
 * vocabulary — the profession's, never the wire's.
 */

import { CaseLifecycle, ClientRole, ForumKind } from "../gen/stigmer/law/case/v1/case_pb.js";
import { ClientKind } from "../gen/stigmer/law/client/v1/client_pb.js";
import { DeadlineState } from "../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { DocumentCategory } from "../gen/stigmer/law/document/v1/document_pb.js";
import { FeeKind } from "../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import { FirmRole } from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { OutcomeKind } from "../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { LedgerEntryKind } from "../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { TaskPriority, TaskState } from "../gen/stigmer/law/task/v1/task_pb.js";

/** "2026-08-20" → "20/08/2026" (FR-LANG-001's date format). */
export function formatCalendarDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Timestamps (note/comment creation) render as IST calendar date + time. */
export function formatInstant(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/* ------------------------------- money ------------------------------- */

const INDIAN_GROUPING = new Intl.NumberFormat("en-IN");

/**
 * Integer paise (the wire's bigint) → "₹1,23,456.78" with Indian digit
 * grouping. Pure bigint arithmetic — amounts never pass through float.
 */
export function formatPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${INDIAN_GROUPING.format(rupees)}.${fraction}`;
}

/**
 * A typed rupee amount ("12,345.50", "₹500") → integer paise, or
 * undefined when the text is not an amount. Grouping commas and a ₹
 * prefix are tolerated; more than two decimals are not.
 */
export function parseRupeesToPaise(text: string): bigint | undefined {
  const cleaned = text.replace(/[,\s₹]/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return undefined;
  const rupees = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return rupees * 100n + fraction;
}

/* ------------------------------- labels ------------------------------ */

const TASK_STATE_LABELS: Record<TaskState, string> = {
  [TaskState.UNSPECIFIED]: "Unknown",
  [TaskState.OPEN]: "Open",
  [TaskState.IN_PROGRESS]: "In progress",
  [TaskState.CLOSED]: "Closed",
};

export function taskStateLabel(state: TaskState): string {
  return TASK_STATE_LABELS[state] ?? "Unknown";
}

const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  [TaskPriority.UNSPECIFIED]: "Medium",
  [TaskPriority.LOW]: "Low",
  [TaskPriority.MEDIUM]: "Medium",
  [TaskPriority.HIGH]: "High",
};

export function taskPriorityLabel(priority: TaskPriority): string {
  return TASK_PRIORITY_LABELS[priority] ?? "Medium";
}

const CASE_LIFECYCLE_LABELS: Record<CaseLifecycle, string> = {
  // UNSPECIFIED is treated as ACTIVE everywhere (the contract's words).
  [CaseLifecycle.UNSPECIFIED]: "Active",
  [CaseLifecycle.ACTIVE]: "Active",
  [CaseLifecycle.DISPOSED]: "Disposed",
  [CaseLifecycle.CLOSED]: "Closed",
};

export function caseLifecycleLabel(lifecycle: CaseLifecycle): string {
  return CASE_LIFECYCLE_LABELS[lifecycle] ?? "Active";
}

const FORUM_KIND_LABELS: Record<ForumKind, string> = {
  [ForumKind.UNSPECIFIED]: "Forum not set",
  [ForumKind.DISTRICT_COURT]: "District Court",
  [ForumKind.HIGH_COURT]: "High Court",
  [ForumKind.NCLT]: "NCLT",
  [ForumKind.DRT]: "DRT",
  [ForumKind.CONSUMER_FORUM]: "Consumer Forum",
  [ForumKind.OTHER]: "Other forum",
};

export function forumKindLabel(kind: ForumKind): string {
  return FORUM_KIND_LABELS[kind] ?? "Forum not set";
}

const CLIENT_ROLE_LABELS: Record<ClientRole, string> = {
  [ClientRole.UNSPECIFIED]: "Role not set",
  [ClientRole.PLAINTIFF]: "Plaintiff",
  [ClientRole.DEFENDANT]: "Defendant",
  [ClientRole.PETITIONER]: "Petitioner",
  [ClientRole.RESPONDENT]: "Respondent",
  [ClientRole.COMPLAINANT]: "Complainant",
  [ClientRole.ACCUSED]: "Accused",
  [ClientRole.APPELLANT]: "Appellant",
  [ClientRole.OTHER]: "Other",
};

export function clientRoleLabel(role: ClientRole): string {
  return CLIENT_ROLE_LABELS[role] ?? "Role not set";
}

const OUTCOME_KIND_LABELS: Record<OutcomeKind, string> = {
  // UNSPECIFIED means no outcome yet — the hearing is still scheduled.
  [OutcomeKind.UNSPECIFIED]: "Scheduled",
  [OutcomeKind.ADJOURNED]: "Adjourned",
  [OutcomeKind.HEARD]: "Heard",
  [OutcomeKind.ORDERS_RESERVED]: "Orders reserved",
  [OutcomeKind.ORDER_PRONOUNCED]: "Order pronounced",
  [OutcomeKind.NOT_LISTED]: "Not listed",
  [OutcomeKind.NOT_REACHED]: "Not reached",
  [OutcomeKind.OTHER]: "Other",
};

export function outcomeKindLabel(kind: OutcomeKind): string {
  return OUTCOME_KIND_LABELS[kind] ?? "Scheduled";
}

const DEADLINE_STATE_LABELS: Record<DeadlineState, string> = {
  [DeadlineState.UNSPECIFIED]: "Open",
  [DeadlineState.OPEN]: "Open",
  [DeadlineState.MET]: "Met",
  [DeadlineState.MISSED]: "Missed",
  [DeadlineState.WITHDRAWN]: "Withdrawn",
};

export function deadlineStateLabel(state: DeadlineState): string {
  return DEADLINE_STATE_LABELS[state] ?? "Open";
}

const FIRM_ROLE_LABELS: Record<FirmRole, string> = {
  [FirmRole.UNSPECIFIED]: "Member",
  [FirmRole.MANAGING_PARTNER]: "Managing partner",
  [FirmRole.PARTNER]: "Partner",
  [FirmRole.ASSOCIATE]: "Associate",
  [FirmRole.JUNIOR]: "Junior",
  [FirmRole.CLERK]: "Clerk",
  [FirmRole.OFFICE_STAFF]: "Office staff",
};

export function firmRoleLabel(role: FirmRole): string {
  return FIRM_ROLE_LABELS[role] ?? "Member";
}

const FEE_KIND_LABELS: Record<FeeKind, string> = {
  [FeeKind.UNSPECIFIED]: "Not set",
  [FeeKind.LUMP_SUM]: "Lump sum",
  [FeeKind.PER_APPEARANCE]: "Per appearance",
  [FeeKind.RETAINER]: "Monthly retainer",
  [FeeKind.NOT_SET]: "Not set",
};

export function feeKindLabel(kind: FeeKind): string {
  return FEE_KIND_LABELS[kind] ?? "Not set";
}

const LEDGER_ENTRY_KIND_LABELS: Record<LedgerEntryKind, string> = {
  [LedgerEntryKind.UNSPECIFIED]: "Entry",
  [LedgerEntryKind.CHARGE]: "Charge",
  [LedgerEntryKind.RECEIPT]: "Receipt",
  [LedgerEntryKind.EXPENSE]: "Expense",
};

export function ledgerEntryKindLabel(kind: LedgerEntryKind): string {
  return LEDGER_ENTRY_KIND_LABELS[kind] ?? "Entry";
}

// UNSPECIFIED renders as "Other" by the proto's own instruction
// (uploads predating the category land there honestly).
const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  [DocumentCategory.UNSPECIFIED]: "Other",
  [DocumentCategory.PLEADING]: "Pleading",
  [DocumentCategory.APPLICATION]: "Application",
  [DocumentCategory.EVIDENCE]: "Evidence",
  [DocumentCategory.ORDER_JUDGMENT]: "Order / judgment",
  [DocumentCategory.CORRESPONDENCE]: "Correspondence",
  [DocumentCategory.VAKALATNAMA]: "Vakalatnama",
  [DocumentCategory.JUDGMENT]: "Judgment",
  [DocumentCategory.OTHER]: "Other",
  [DocumentCategory.ACT]: "Bare act",
};

export function documentCategoryLabel(category: DocumentCategory): string {
  return DOCUMENT_CATEGORY_LABELS[category] ?? "Other";
}

const CLIENT_KIND_LABELS: Record<ClientKind, string> = {
  [ClientKind.UNSPECIFIED]: "Individual",
  [ClientKind.INDIVIDUAL]: "Individual",
  [ClientKind.ORGANIZATION]: "Organisation",
};

export function clientKindLabel(kind: ClientKind): string {
  return CLIENT_KIND_LABELS[kind] ?? "Individual";
}
