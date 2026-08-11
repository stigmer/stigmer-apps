/**
 * Task detail (FR-TASK-003/004/005/007) on the DD-005 detail frame: the
 * story (description, comments) in the reading column, the facts in the
 * context rail. The one state control is the status select wired to
 * UpdateStatus — the contract's ONLY write path for lifecycle state; the
 * edit form (spec fields) deliberately cannot touch it. Derived facts
 * (overdue, case number) render as received.
 *
 * Edit mode replaces the whole detail frame with the focused form
 * (DD-005's uniform rule): the form edits the same facts the rail
 * shows, and a stale rail beside a live form would lie.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { CardSurface } from "../../components/SectionCard.js";
import { DetailLayout } from "../../components/DetailLayout.js";
import { FormError, InlineSelect } from "../../components/Field.js";
import { MetaItem, MetaPanel } from "../../components/MetaPanel.js";
import { TaskState } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { formatCalendarDate, taskPriorityLabel, taskStateLabel } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import { TaskComments } from "./TaskComments.js";
import { TaskEditForm } from "./TaskEditForm.js";
import { useTask, useUpdateTaskStatus } from "./queries.js";

export function TaskDetailScreen() {
  const { id = "" } = useParams();
  const task = useTask(id);
  const updateStatus = useUpdateTaskStatus();
  const roster = useFirmRoster();
  const [editing, setEditing] = useState(false);
  const [statusError, setStatusError] = useState<string | undefined>();

  if (task.isPending) return <Loading label="Loading task…" />;
  if (task.isError) return <ErrorState error={task.error} onRetry={() => void task.refetch()} />;
  const t = task.data;

  async function onStateChange(state: TaskState) {
    setStatusError(undefined);
    try {
      await updateStatus.mutateAsync({ id, state });
    } catch (err) {
      setStatusError(ConnectError.from(err).rawMessage);
    }
  }

  if (editing) {
    return (
      <section aria-label={`Edit ${t.spec?.title ?? "task"}`}>
        <h1 className="mb-4 text-lg font-semibold">Edit {t.spec?.title}</h1>
        <TaskEditForm task={t} onDone={() => setEditing(false)} />
      </section>
    );
  }

  return (
    <section aria-label="Task">
      <div className="mb-1 text-xs text-ink-muted">
        <Link to="/tasks" className="text-brand underline">
          Tasks
        </Link>{" "}
        / {t.status?.caseFileNumber || "…"}
      </div>

      <h1 className="mb-4 text-lg font-semibold">{t.spec?.title}</h1>

      <DetailLayout
        railLabel="Task facts"
        rail={
          <MetaPanel footer={<Button onClick={() => setEditing(true)}>Edit</Button>}>
            <MetaItem label="Status">
              <div className="flex items-center gap-2">
                <label htmlFor="task-state" className="sr-only">
                  Status
                </label>
                <InlineSelect
                  id="task-state"
                  value={t.status?.state ?? TaskState.OPEN}
                  disabled={updateStatus.isPending}
                  onChange={(e) => void onStateChange(Number(e.target.value) as TaskState)}
                >
                  <option value={TaskState.OPEN}>{taskStateLabel(TaskState.OPEN)}</option>
                  <option value={TaskState.IN_PROGRESS}>
                    {taskStateLabel(TaskState.IN_PROGRESS)}
                  </option>
                  <option value={TaskState.CLOSED}>{taskStateLabel(TaskState.CLOSED)}</option>
                </InlineSelect>
                {t.status?.overdue && <Badge tone="warn">Overdue</Badge>}
              </div>
              {statusError && (
                <div className="mt-1">
                  <FormError message={statusError} />
                </div>
              )}
            </MetaItem>
            <MetaItem label="Case">
              {t.spec?.caseId ? (
                <Link to={`/cases/${t.spec.caseId}`} className="text-brand underline">
                  {t.status?.caseFileNumber || t.spec.caseId}
                </Link>
              ) : (
                "—"
              )}
            </MetaItem>
            <MetaItem label="Assigned to">
              {t.spec?.assigneeId ? roster.data?.nameOf(t.spec.assigneeId) ?? "…" : "Unassigned"}
            </MetaItem>
            <MetaItem label="Due date">
              {t.spec?.dueDate ? formatCalendarDate(t.spec.dueDate) : "No due date"}
            </MetaItem>
            <MetaItem label="Priority">{taskPriorityLabel(t.spec?.priority ?? 0)}</MetaItem>
          </MetaPanel>
        }
      >
        <CardSurface>
          {t.spec?.description ? (
            <p className="whitespace-pre-wrap">{t.spec.description}</p>
          ) : (
            <p className="text-ink-muted">No description.</p>
          )}
        </CardSurface>

        <TaskComments taskId={id} />
      </DetailLayout>
    </section>
  );
}
