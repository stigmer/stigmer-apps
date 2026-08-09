/**
 * Display formatting (T04b D5): DD/MM/YYYY and IST are the firm's locale
 * (FR-LANG-001) — and NOTHING here does timezone math. Calendar dates
 * (hearing dates, due dates) are plain YYYY-MM-DD strings on the wire and
 * reformat as strings; the one derived time fact, `overdue`, is computed
 * server-side in Asia/Kolkata (the record model). A client Date parse of
 * a calendar date would shift it a day for any user west of IST.
 */

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
