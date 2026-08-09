/**
 * Phone-screen formatting for tool answers: plain language, DD/MM/YYYY,
 * the firm's clock (the web app's conventions, restated here because the
 * backend may not import web code). These strings are read by the model
 * and usually relayed into WhatsApp with light rephrasing — so they are
 * written as things a person would say, not as records.
 */

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
