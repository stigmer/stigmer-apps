/**
 * Task detail (FR-TASK-003/004/005/007). The one state control is the
 * status select wired to UpdateStatus — the contract's ONLY write path
 * for lifecycle state; the edit form (spec fields) deliberately cannot
 * touch it. Derived facts (overdue, case number) render as received.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { FormError, InlineSelect } from "../../components/Field.js";
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

  return (
    <section aria-label="Task">
      <div className="mb-1 text-xs text-ink-muted">
        <Link to="/tasks" className="text-brand underline">
          Tasks
        </Link>{" "}
        / {t.status?.caseFileNumber || "…"}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t.spec?.title}</h1>
        {!editing && <Button onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      {editing ? (
        <TaskEditForm task={t} onDone={() => setEditing(false)} />
      ) : (
        <dl className="grid max-w-3xl grid-cols-1 gap-x-8 gap-y-2 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-muted">Case</dt>
            <dd>
              {t.spec?.caseId ? (
                <Link to={`/cases/${t.spec.caseId}`} className="text-brand underline">
                  {t.status?.caseFileNumber || t.spec.caseId}
                </Link>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Status</dt>
            <dd className="flex items-center gap-2">
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
                <option value={TaskState.IN_PROGRESS}>{taskStateLabel(TaskState.IN_PROGRESS)}</option>
                <option value={TaskState.CLOSED}>{taskStateLabel(TaskState.CLOSED)}</option>
              </InlineSelect>
              {t.status?.overdue && <Badge tone="warn">Overdue</Badge>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Assigned to</dt>
            <dd>
              {t.spec?.assigneeId ? roster.data?.nameOf(t.spec.assigneeId) ?? "…" : "Unassigned"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Due date</dt>
            <dd>{t.spec?.dueDate ? formatCalendarDate(t.spec.dueDate) : "No due date"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Priority</dt>
            <dd>{taskPriorityLabel(t.spec?.priority ?? 0)}</dd>
          </div>
          {t.spec?.description && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-ink-muted">Description</dt>
              <dd className="whitespace-pre-wrap">{t.spec.description}</dd>
            </div>
          )}
        </dl>
      )}

      {statusError && (
        <div className="mt-3">
          <FormError message={statusError} />
        </div>
      )}

      <TaskComments taskId={id} />
    </section>
  );
}
