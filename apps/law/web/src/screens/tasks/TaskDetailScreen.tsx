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
      <div className="mb-1 text-sm text-ink-muted">
        <Link to="/tasks" className="text-brand underline">
          Tasks
        </Link>{" "}
        / {t.status?.caseFileNumber || "…"}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t.spec?.title}</h1>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <TaskEditForm task={t} onDone={() => setEditing(false)} />
      ) : (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-muted">Case</dt>
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
            <dt className="text-sm text-ink-muted">Status</dt>
            <dd className="flex items-center gap-2">
              <label htmlFor="task-state" className="sr-only">
                Status
              </label>
              <select
                id="task-state"
                value={t.status?.state ?? TaskState.OPEN}
                disabled={updateStatus.isPending}
                onChange={(e) => void onStateChange(Number(e.target.value) as TaskState)}
                className="h-11 rounded-card border border-line bg-surface px-2"
              >
                <option value={TaskState.OPEN}>{taskStateLabel(TaskState.OPEN)}</option>
                <option value={TaskState.IN_PROGRESS}>{taskStateLabel(TaskState.IN_PROGRESS)}</option>
                <option value={TaskState.CLOSED}>{taskStateLabel(TaskState.CLOSED)}</option>
              </select>
              {t.status?.overdue && (
                <span className="rounded-card bg-warn-surface px-2 py-0.5 text-xs font-medium text-warn">
                  Overdue
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Assigned to</dt>
            <dd>
              {t.spec?.assigneeId ? roster.data?.nameOf(t.spec.assigneeId) ?? "…" : "Unassigned"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Due date</dt>
            <dd>{t.spec?.dueDate ? formatCalendarDate(t.spec.dueDate) : "No due date"}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Priority</dt>
            <dd>{taskPriorityLabel(t.spec?.priority ?? 0)}</dd>
          </div>
          {t.spec?.description && (
            <div className="sm:col-span-2">
              <dt className="text-sm text-ink-muted">Description</dt>
              <dd className="whitespace-pre-wrap">{t.spec.description}</dd>
            </div>
          )}
        </dl>
      )}

      {statusError && (
        <p role="alert" className="mt-3 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {statusError}
        </p>
      )}

      <TaskComments taskId={id} />
    </section>
  );
}
