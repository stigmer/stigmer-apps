/**
 * Phone-screen formatting for tool answers: plain language, DD/MM/YYYY,
 * the firm's clock (the web app's conventions, restated here because the
 * backend may not import web code). These strings are read by the model
 * and usually relayed into WhatsApp with light rephrasing — so they are
 * written as things a person would say, not as records.
 */

import { DocumentCategory } from "../gen/stigmer/law/document/v1/document_pb.js";
import { OutcomeKind } from "../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { TaskState } from "../gen/stigmer/law/task/v1/task_pb.js";

/** "2026-08-14" → "14/08/2026". Unset → the honest phrase, not a dash. */
export function formatDate(isoDate: string | undefined): string {
  if (!isoDate) return "no date set";
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

export function formatState(state: TaskState): string {
  switch (state) {
    case TaskState.OPEN:
      return "open";
    case TaskState.IN_PROGRESS:
      return "in progress";
    case TaskState.CLOSED:
      return "closed";
    default:
      return "unknown";
  }
}

/** Naturalizes a count: "no open tasks", "1 open task", "4 open tasks". */
export function countNoun(count: number | bigint, singular: string, plural?: string): string {
  const n = typeof count === "bigint" ? Number(count) : count;
  const noun = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n === 0 ? "no" : n} ${noun}`;
}

/** The outcome vocabulary as a lawyer says it, not as the enum spells it. */
export function formatOutcome(kind: OutcomeKind): string {
  switch (kind) {
    case OutcomeKind.ADJOURNED:
      return "adjourned";
    case OutcomeKind.HEARD:
      return "heard";
    case OutcomeKind.ORDERS_RESERVED:
      return "orders reserved";
    case OutcomeKind.ORDER_PRONOUNCED:
      return "order pronounced";
    case OutcomeKind.NOT_LISTED:
      return "not listed";
    case OutcomeKind.NOT_REACHED:
      return "not reached";
    case OutcomeKind.OTHER:
      return "other";
    default:
      return "scheduled";
  }
}

/** The category vocabulary as filed papers are named. UNSPECIFIED is
 * spoken as "uncategorized" — an honest state, not a missing one. */
export function formatCategory(category: DocumentCategory): string {
  if (category === DocumentCategory.UNSPECIFIED) return "uncategorized";
  const name = DocumentCategory[category];
  return name ? name.toLowerCase().replace(/_/g, " ") : "uncategorized";
}

/** Bytes → "312 KB" / "2.4 MB" — a size a person scans, not a count. */
export function formatBytes(bytes: bigint | number): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Integer paise → "₹1,23,456.50" (Indian digit grouping). */
export function formatPaise(paise: bigint): string {
  const rupees = Number(paise) / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
  }).format(rupees);
}
