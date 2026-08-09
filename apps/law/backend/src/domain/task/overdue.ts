/**
 * The overdue rule, written exactly once (T05). Two consumers must agree
 * forever: the read-side derivation (Task.status.overdue) and the
 * OVERDUE list predicate's store filter — if they drift, a count and the
 * list it opens disagree, the exact defect the platform's
 * channel-conversation filter design exists to prevent. An agreement
 * test in the task suite pins them together: the filtered set must equal
 * the set whose derived overdue is true.
 *
 * The rule: not finished (state in OPEN_STATES) AND the due date has
 * passed in the firm's timezone. Strict `<`: a task due today is not
 * overdue until the first read after midnight, firm time. No due date
 * means never overdue.
 */

import type { FilterValue } from "@stigmer/resource-api";
import {
  TaskState,
  TaskStateSchema,
} from "../../gen/stigmer/law/task/v1/task_pb.js";

/**
 * "Not finished", as a positive set rather than `!== CLOSED`: the store
 * predicate needs the member list, and a positive set keeps the two
 * consumers literally the same expression. (UNSPECIFIED is not a member;
 * it is also unreachable in stored rows — create forces OPEN and
 * UpdateStatus rejects it.)
 */
export const OPEN_STATES: readonly TaskState[] = [TaskState.OPEN, TaskState.IN_PROGRESS];

/**
 * The proto3-JSON names of OPEN_STATES ("TASK_STATE_OPEN", …) — what the
 * stored generated column renders and therefore what filters compare.
 * Derived from the schema so no literal exists to typo.
 */
const OPEN_STATE_JSON_NAMES: readonly string[] = OPEN_STATES.map((state) => {
  const value = TaskStateSchema.values.find((v) => v.number === state);
  if (!value) {
    throw new Error(`TaskState ${state} missing from schema (codegen drift)`);
  }
  return value.name;
});

/** The derivation half: is this task overdue as of `today` (YYYY-MM-DD)? */
export function isOverdue(
  dueDate: string | undefined,
  state: TaskState,
  today: string,
): boolean {
  return dueDate !== undefined && dueDate < today && OPEN_STATES.includes(state);
}

/** The OPEN predicate's store filter: state in OPEN_STATES. */
export function openStatesFilter(): Readonly<Record<string, FilterValue>> {
  return { state: { in: OPEN_STATE_JSON_NAMES } };
}

/** The OVERDUE predicate's store filter — the query half of isOverdue. */
export function overdueFilter(today: string): Readonly<Record<string, FilterValue>> {
  return { state: { in: OPEN_STATE_JSON_NAMES }, dueDate: { lt: today } };
}
