/**
 * Task data access (T04b D3): TanStack Query over the typed clients —
 * explicit loading/error states, invalidation on mutation, never a
 * hand-patched parallel copy of server data. Ordering, "My Tasks"
 * defaulting, overdue, and the derived case number are all SERVER facts
 * (the list contract + D9); these hooks only carry them.
 *
 * Query keys: everything task-shaped lives under ["tasks"], so one
 * prefix invalidation after any mutation refetches exactly the screens
 * that could have changed.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Task,
  // Aliased: this module's own TaskListFilter interface predates the
  // proto enum of the same name.
  TaskListFilter as ProtoTaskListFilter,
  TaskSchema,
  type TaskSpec,
  TaskSpecSchema,
  type TaskState,
} from "../../gen/stigmer/law/task/v1/task_pb.js";

export interface TaskListFilter {
  /** Absent = the contract's "My Tasks" default (caller's assignments). */
  readonly assigneeId?: string;
  /** The case-detail view's filter. */
  readonly caseId?: string;
}

export function useTaskList(filter: TaskListFilter, page: number) {
  const { tasks } = useApiClients();
  return useQuery({
    queryKey: ["tasks", "list", filter, page],
    queryFn: () =>
      tasks.list({
        pageSize: PAGE_SIZE,
        pageOffset: page * PAGE_SIZE,
        assigneeId: filter.assigneeId ?? "",
        caseId: filter.caseId ?? "",
      }),
  });
}

/** Work waiting for an owner (FR-TASK-002): open tasks with no
 * assignee, firm-shaped visibility (the contract's rule — an unassigned
 * task has no "mine" to default to). */
export function useUnassignedOpenTasks() {
  const { tasks } = useApiClients();
  return useQuery({
    queryKey: ["tasks", "unassigned"],
    queryFn: () =>
      tasks.list({ unassignedOnly: true, filter: ProtoTaskListFilter.OPEN, pageSize: 20 }),
  });
}

export function useTask(id: string) {
  const { tasks } = useApiClients();
  return useQuery({
    queryKey: ["tasks", "byId", id],
    queryFn: () => tasks.get({ id }),
  });
}

export function useCreateTask() {
  const { tasks } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: TaskSpec) => tasks.create(create(TaskSchema, { spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

/** Full-spec replacement (D10): callers submit the COMPLETE desired spec. */
export function useUpdateTask() {
  const { tasks } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly task: Task; readonly spec: TaskSpec }) =>
      tasks.update(
        create(TaskSchema, { metadata: input.task.metadata, spec: input.spec }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTaskStatus() {
  const { tasks } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly id: string; readonly state: TaskState }) =>
      tasks.updateStatus({ id: input.id, state: input.state }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useTaskComments(taskId: string) {
  const { taskComments } = useApiClients();
  return useQuery({
    // Comments are conversation (oldest first, the list contract) and can
    // exceed a page; the screen pages explicitly if total_count says so.
    queryKey: ["tasks", "comments", taskId],
    queryFn: () => taskComments.list({ taskId, pageSize: 100 }),
  });
}

export function useAddTaskComment(taskId: string) {
  const { taskComments } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      taskComments.create({ spec: { taskId, content } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["tasks", "comments", taskId] }),
  });
}

export { TaskSpecSchema };
