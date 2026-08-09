/**
 * Home — "what needs my attention today?" (the FR-APP-001 transfer):
 * My Tasks, soonest due first with overdue called out, before any
 * navigation. The list IS the contract's default ("no filter means the
 * caller's assignments"), ordered server-side.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { useCurrentUser } from "../../session/use-session.js";
import { TaskRow } from "../tasks/TaskRow.js";
import { useTaskList } from "../tasks/queries.js";

export function HomeScreen() {
  const user = useCurrentUser();
  const [page, setPage] = useState(0);
  const myTasks = useTaskList({}, page);

  return (
    <section aria-label="Today">
      <h1 className="mb-4 text-xl font-semibold">
        Welcome, {user.spec?.name || user.spec?.email}
      </h1>

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-medium">My tasks</h2>
        <Link to="/tasks/new" className="text-sm text-brand underline">
          New task
        </Link>
      </div>

      {myTasks.isPending && <Loading label="Loading your tasks…" />}
      {myTasks.isError && <ErrorState error={myTasks.error} onRetry={() => void myTasks.refetch()} />}
      {myTasks.isSuccess && myTasks.data.items.length === 0 && (
        <EmptyState title="No tasks assigned to you">
          Tasks assigned to you appear here, soonest due first.
        </EmptyState>
      )}
      {myTasks.isSuccess && myTasks.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {myTasks.data.items.map((task) => (
              <TaskRow key={task.metadata?.id} task={task} />
            ))}
          </ul>
          <Pagination
            page={page}
            totalCount={Number(myTasks.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
