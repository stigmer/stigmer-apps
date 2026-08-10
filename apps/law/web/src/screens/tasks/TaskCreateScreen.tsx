/**
 * New task (FR-TASK-001). Two entrances: from a case detail
 * (?case=<id> pre-binds the case) and standalone — where the lawyer
 * types the firm's FILE NUMBER and the natural-key Get resolves it
 * (file numbers are what lawyers say out loud; this is why no case
 * picker is needed). The due date input is a native date field: its
 * wire value is already the contract's YYYY-MM-DD.
 */

import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { useQuery } from "@tanstack/react-query";
import { useApiClients } from "../../api/clients.js";
import { TaskPriority, TaskSpecSchema } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { useFirmRoster } from "../members/queries.js";
import { useCreateTask } from "./queries.js";

export function TaskCreateScreen() {
  const [params] = useSearchParams();
  const boundCaseId = params.get("case") ?? "";
  const { cases } = useApiClients();
  const roster = useFirmRoster();
  const createTask = useCreateTask();
  const navigate = useNavigate();

  const boundCase = useQuery({
    queryKey: ["cases", "byId", boundCaseId],
    queryFn: () => cases.get({ id: boundCaseId }),
    enabled: boundCaseId !== "",
  });

  const [fileNumber, setFileNumber] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.MEDIUM);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      // Standalone entrance: resolve the typed file number first, so a
      // typo answers the server's own "Case '…' not found" before
      // anything is created.
      const caseId = boundCaseId || (await cases.get({ fileNumber: fileNumber.trim() })).metadata?.id;
      const created = await createTask.mutateAsync(
        create(TaskSpecSchema, {
          caseId,
          title: title.trim(),
          description: description.trim(),
          assigneeId: assigneeId || undefined,
          dueDate: dueDate || undefined,
          priority,
        }),
      );
      navigate(`/tasks/${created.metadata?.id}`);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  const field = "mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3";
  const label = "mb-1 block text-sm font-medium";

  return (
    <section aria-label="New task" className="max-w-lg">
      <h1 className="mb-4 text-xl font-semibold">New task</h1>
      <form onSubmit={(e) => void onSubmit(e)} className="rounded-card border border-line bg-surface p-6">
        {boundCaseId ? (
          <p className="mb-4 text-sm text-ink-muted">
            For matter{" "}
            <span className="font-medium text-ink">
              {boundCase.data?.spec?.fileNumber ?? "…"}
            </span>
          </p>
        ) : (
          <>
            <label htmlFor="task-case" className={label}>
              File number
            </label>
            <input
              id="task-case"
              required
              value={fileNumber}
              onChange={(e) => setFileNumber(e.target.value)}
              placeholder="The firm's own number, e.g. CS/2026/042"
              className={field}
            />
          </>
        )}

        <label htmlFor="task-title" className={label}>
          Title
        </label>
        <input
          id="task-title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={field}
        />

        <label htmlFor="task-description" className={label}>
          Description <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <textarea
          id="task-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mb-4 block w-full rounded-card border border-line bg-surface px-3 py-2"
        />

        <label htmlFor="task-assignee" className={label}>
          Assign to
        </label>
        <select
          id="task-assignee"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          className={field}
        >
          <option value="">Unassigned</option>
          {roster.data?.members.map((member) => (
            <option key={member.metadata?.id} value={member.metadata?.id}>
              {member.status?.userName || member.status?.userEmail}
            </option>
          ))}
        </select>

        <label htmlFor="task-due" className={label}>
          Due date <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id="task-due"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className={field}
        />

        <label htmlFor="task-priority" className={label}>
          Priority
        </label>
        <select
          id="task-priority"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value) as TaskPriority)}
          className={field}
        >
          <option value={TaskPriority.LOW}>Low</option>
          <option value={TaskPriority.MEDIUM}>Medium</option>
          <option value={TaskPriority.HIGH}>High</option>
        </select>

        {error && (
          <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={createTask.isPending}
            className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
          >
            {createTask.isPending ? "Creating…" : "Create task"}
          </button>
          <Link to="/tasks" className="flex h-11 items-center rounded-card px-4 text-brand hover:bg-brand-surface">
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}
