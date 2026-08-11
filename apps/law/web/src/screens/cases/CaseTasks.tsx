/**
 * Tasks on this matter (FR-TASK-001's case view): the case-filtered
 * list plus the pre-bound entrance — a task born here never asks for
 * the file number again.
 */

import { useState } from "react";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { ButtonLink } from "../../components/Button.js";
import { ListCard } from "../../components/ListCard.js";
import { Pagination } from "../../components/Pagination.js";
import { TaskRow } from "../tasks/TaskRow.js";
import { useTaskList } from "../tasks/queries.js";

export function CaseTasks(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const tasks = useTaskList({ caseId: props.caseId }, page);

  return (
    <section aria-label="Tasks on this case" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Tasks</h2>
        <ButtonLink to={`/tasks/new?case=${props.caseId}`}>New task</ButtonLink>
      </div>
      {tasks.isPending && <Loading label="Loading tasks…" />}
      {tasks.isError && <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />}
      {tasks.isSuccess && tasks.data.items.length === 0 && (
        <EmptyState title="No tasks on this matter" />
      )}
      {tasks.isSuccess && tasks.data.items.length > 0 && (
        <>
          <ListCard>
            {tasks.data.items.map((task) => (
              <TaskRow key={task.metadata?.id} task={task} />
            ))}
          </ListCard>
          <Pagination page={page} totalCount={Number(tasks.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
