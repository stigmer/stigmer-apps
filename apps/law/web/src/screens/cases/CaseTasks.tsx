/**
 * Tasks on this matter (FR-TASK-001's case view): the case-filtered
 * list plus the pre-bound entrance — a task born here never asks for
 * the file number again.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { TaskRow } from "../tasks/TaskRow.js";
import { useTaskList } from "../tasks/queries.js";

export function CaseTasks(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const tasks = useTaskList({ caseId: props.caseId }, page);

  return (
    <section aria-label="Tasks on this case" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Tasks</h2>
        <Link
          to={`/tasks/new?case=${props.caseId}`}
          className="flex h-11 items-center rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
        >
          New task
        </Link>
      </div>
      {tasks.isPending && <Loading label="Loading tasks…" />}
      {tasks.isError && <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />}
      {tasks.isSuccess && tasks.data.items.length === 0 && (
        <EmptyState title="No tasks on this matter" />
      )}
      {tasks.isSuccess && tasks.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {tasks.data.items.map((task) => (
              <TaskRow key={task.metadata?.id} task={task} />
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(tasks.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
