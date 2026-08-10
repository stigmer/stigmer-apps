/**
 * Tasks (FR-TASK-001): "My Tasks" is the default BY CONTRACT (no filter
 * means the caller's assignments — the screen sends no filter unless the
 * user picks a colleague). Ordering is the server's: soonest due first,
 * dateless last. Assignees are FirmMembers, so the picker reads the
 * roster — the app's one person directory.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { useFirmMember } from "../../session/use-firm-member.js";
import { useFirmRoster } from "../members/queries.js";
import { TaskRow } from "./TaskRow.js";
import { useTaskList } from "./queries.js";

export function TaskListScreen() {
  // "Me" is my FirmMember id — the id task assignments actually carry.
  const myId = useFirmMember().data?.metadata?.id ?? "";
  const roster = useFirmRoster();
  const [assigneeId, setAssigneeId] = useState("");
  const [page, setPage] = useState(0);

  // No selection = the contract's default ("My Tasks"); picking a
  // colleague names the scope explicitly.
  const effective = assigneeId || myId;
  const list = useTaskList(effective === myId ? {} : { assigneeId: effective }, page);

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
          value={effective}
          onChange={(e) => {
            setAssigneeId(e.target.value);
            setPage(0);
          }}
          className="h-11 rounded-card border border-line bg-surface px-2"
        >
          <option value={myId}>Me</option>
          {roster.data?.members
            .filter((member) => member.metadata?.id !== myId)
            .map((member) => (
              <option key={member.metadata?.id} value={member.metadata?.id}>
                {member.status?.userName || member.status?.userEmail}
              </option>
            ))}
        </select>
      </div>

      {list.isPending && <Loading label="Loading tasks…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState title="No tasks here">
          {effective === myId
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
