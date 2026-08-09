/**
 * Spec edit (FR-TASK-005) under last-write-wins (D10): the form is
 * initialized from the freshly-loaded task and submits the COMPLETE spec
 * — under full-spec replacement, omitting a field would blank it, so
 * every spec field appears here even when unchanged (the case binding
 * stays fixed: moving a task between cases is not a screen this MVP
 * offers). Lifecycle state is NOT here — updateStatus is its only write
 * path (FR-TASK-004).
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  type Task,
  TaskPriority,
  TaskSpecSchema,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { useUserDirectory } from "../users/queries.js";
import { useUpdateTask } from "./queries.js";

export function TaskEditForm(props: { task: Task; onDone: () => void }) {
  const { task } = props;
  const directory = useUserDirectory();
  const updateTask = useUpdateTask();

  const [title, setTitle] = useState(task.spec?.title ?? "");
  const [description, setDescription] = useState(task.spec?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task.spec?.assigneeId ?? "");
  const [dueDate, setDueDate] = useState(task.spec?.dueDate ?? "");
  const [priority, setPriority] = useState<TaskPriority>(
    task.spec?.priority ?? TaskPriority.MEDIUM,
  );
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await updateTask.mutateAsync({
        task,
        spec: create(TaskSpecSchema, {
          caseId: task.spec?.caseId ?? "",
          title: title.trim(),
          description: description.trim(),
          assigneeId: assigneeId || undefined,
          dueDate: dueDate || undefined,
          priority,
        }),
      });
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  const field = "mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3";
  const label = "mb-1 block text-sm font-medium";

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Edit task"
      className="rounded-card border border-line bg-surface p-4"
    >
      <label htmlFor="edit-title" className={label}>
        Title
      </label>
      <input
        id="edit-title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className={field}
      />

      <label htmlFor="edit-description" className={label}>
        Description
      </label>
      <textarea
        id="edit-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        className="mb-4 block w-full rounded-card border border-line bg-surface px-3 py-2"
      />

      <label htmlFor="edit-assignee" className={label}>
        Assign to
      </label>
      <select
        id="edit-assignee"
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
        className={field}
      >
        <option value="">Unassigned</option>
        {directory.data?.users.map((u) => (
          <option key={u.metadata?.id} value={u.metadata?.id}>
            {u.spec?.name || u.spec?.email}
          </option>
        ))}
      </select>

      <label htmlFor="edit-due" className={label}>
        Due date
      </label>
      <input
        id="edit-due"
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        className={field}
      />

      <label htmlFor="edit-priority" className={label}>
        Priority
      </label>
      <select
        id="edit-priority"
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
          disabled={updateTask.isPending}
          className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
        >
          {updateTask.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={props.onDone}
          className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
