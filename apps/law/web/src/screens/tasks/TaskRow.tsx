/**
 * One task, at a glance — shared by Home's My Tasks and the task list.
 * Reads ONLY contract facts: the derived case number (D9), the derived
 * overdue flag, stored state, and spec fields. Color never carries
 * meaning alone (D5): overdue and state always render as words.
 */

import { Badge } from "../../components/Badge.js";
import { ListRow, RowMeta, RowTitle } from "../../components/ListCard.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { TaskState } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { formatCalendarDate, taskPriorityLabel, taskStateLabel } from "../../lib/format.js";

export function TaskRow(props: { task: Task; showAssignee?: string }) {
  const { task } = props;
  const id = task.metadata?.id ?? "";
  const state = task.status?.state ?? TaskState.UNSPECIFIED;

  return (
    <ListRow to={`/tasks/${id}`}>
      <RowTitle grow>{task.spec?.title}</RowTitle>
      {task.status?.caseFileNumber && <RowMeta>{task.status.caseFileNumber}</RowMeta>}
      {props.showAssignee && <RowMeta>{props.showAssignee}</RowMeta>}
      {task.spec?.dueDate && <RowMeta>Due {formatCalendarDate(task.spec.dueDate)}</RowMeta>}
      {task.status?.overdue && <Badge tone="warn">Overdue</Badge>}
      <RowMeta faint>{taskPriorityLabel(task.spec?.priority ?? 0)}</RowMeta>
      <Badge tone={state === TaskState.CLOSED ? "neutral" : "brand"}>
        {taskStateLabel(state)}
      </Badge>
    </ListRow>
  );
}
