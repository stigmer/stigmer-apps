/**
 * One task, at a glance — shared by Home's My Tasks and the task list.
 * Reads ONLY contract facts: the derived case number (D9), the derived
 * overdue flag, stored state, and spec fields. Color never carries
 * meaning alone (D5): overdue and state always render as words.
 */

import { Link } from "react-router-dom";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { TaskState } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { formatCalendarDate, taskPriorityLabel, taskStateLabel } from "../../lib/format.js";

export function TaskRow(props: { task: Task; showAssignee?: string }) {
  const { task } = props;
  const id = task.metadata?.id ?? "";
  const state = task.status?.state ?? TaskState.UNSPECIFIED;

  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/tasks/${id}`}
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-brand-surface"
      >
        <span className="flex-1 basis-48 font-medium">{task.spec?.title}</span>
        {task.status?.caseNumber && (
          <span className="text-sm text-ink-muted">{task.status.caseNumber}</span>
        )}
        {props.showAssignee && (
          <span className="text-sm text-ink-muted">{props.showAssignee}</span>
        )}
        {task.spec?.dueDate && (
          <span className="text-sm text-ink-muted">
            Due {formatCalendarDate(task.spec.dueDate)}
          </span>
        )}
        {task.status?.overdue && (
          <span className="rounded-card bg-warn-surface px-2 py-0.5 text-xs font-medium text-warn">
            Overdue
          </span>
        )}
        <span className="text-sm text-ink-faint">{taskPriorityLabel(task.spec?.priority ?? 0)}</span>
        <span
          className={
            state === TaskState.CLOSED
              ? "rounded-card px-2 py-0.5 text-xs text-ink-faint"
              : "rounded-card bg-brand-surface px-2 py-0.5 text-xs font-medium text-brand"
          }
        >
          {taskStateLabel(state)}
        </span>
      </Link>
    </li>
  );
}
