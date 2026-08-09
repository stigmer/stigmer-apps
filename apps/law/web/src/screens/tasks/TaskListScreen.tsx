/**
 * Tasks (FR-TASK-002): "My Tasks" is the default BY CONTRACT (no filter
 * means the caller's assignments — the screen sends no filter unless the
 * user picks a colleague). Ordering is the server's: soonest due first,
 * dateless last. The assignee picker reads the user directory — the same
 * bounded set task creation needs.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { useCurrentUser } from "../../session/use-session.js";
import { useUserDirectory } from "../users/queries.js";
import { TaskRow } from "./TaskRow.js";
import { useTaskList } from "./queries.js";

export function TaskListScreen() {
  const me = useCurrentUser();
  const myId = me.metadata?.id ?? "";
  const directory = useUserDirectory();
  const [assigneeId, setAssigneeId] = useState(myId);
  const [page, setPage] = useState(0);

  // Selecting yourself = the contract's default (no filter): the wire
  // shape matches what "My Tasks" means server-side either way.
  const list = useTaskList(assigneeId === myId ? {} : { assigneeId }, page);

  return (
    <section aria-label="Tasks">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <Link
          to="/tasks/new"
          className="flex h-11 items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
        >
          New task
        </Link>
      </div>

      <div className="mb-3">
        <label htmlFor="assignee-filter" className="mr-2 text-sm text-ink-muted">
          Assigned to
        </label>
        <select
          id="assignee-filter"
          value={assigneeId}
          onChange={(e) => {
            setAssigneeId(e.target.value);
            setPage(0);
          }}
          className="h-11 rounded-card border border-line bg-surface px-2"
        >
          <option value={myId}>Me</option>
          {directory.data?.users
            .filter((u) => u.metadata?.id !== myId)
            .map((u) => (
              <option key={u.metadata?.id} value={u.metadata?.id}>
                {u.spec?.name || u.spec?.email}
              </option>
            ))}
        </select>
      </div>

      {list.isPending && <Loading label="Loading tasks…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState title="No tasks here">
          {assigneeId === myId
            ? "Tasks assigned to you appear here, soonest due first."
            : "This person has no assigned tasks."}
        </EmptyState>
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {list.data.items.map((task) => (
              <TaskRow key={task.metadata?.id} task={task} />
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(list.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
