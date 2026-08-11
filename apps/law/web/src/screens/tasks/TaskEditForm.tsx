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
import { Button } from "../../components/Button.js";
import { FormCard, FormError, Input, Label, Select, TextArea } from "../../components/Field.js";
import {
  type Task,
  TaskPriority,
  TaskSpecSchema,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { useFirmRoster } from "../members/queries.js";
import { useUpdateTask } from "./queries.js";

export function TaskEditForm(props: { task: Task; onDone: () => void }) {
  const { task } = props;
  const roster = useFirmRoster();
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

  return (
    <FormCard onSubmit={(e) => void onSubmit(e)} aria-label="Edit task">
      <Label htmlFor="edit-title">Title</Label>
      <Input
        id="edit-title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <Label htmlFor="edit-description">Description</Label>
      <TextArea
        id="edit-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />

      <Label htmlFor="edit-assignee">Assign to</Label>
      <Select id="edit-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
        <option value="">Unassigned</option>
        {roster.data?.members.map((member) => (
          <option key={member.metadata?.id} value={member.metadata?.id}>
            {member.status?.userName || member.status?.userEmail}
          </option>
        ))}
      </Select>

      <Label htmlFor="edit-due">Due date</Label>
      <Input id="edit-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

      <Label htmlFor="edit-priority">Priority</Label>
      <Select
        id="edit-priority"
        value={priority}
        onChange={(e) => setPriority(Number(e.target.value) as TaskPriority)}
      >
        <option value={TaskPriority.LOW}>Low</option>
        <option value={TaskPriority.MEDIUM}>Medium</option>
        <option value={TaskPriority.HIGH}>High</option>
      </Select>

      <FormError message={error} />

      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={updateTask.isPending}>
          {updateTask.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button onClick={props.onDone}>Cancel</Button>
      </div>
    </FormCard>
  );
}
