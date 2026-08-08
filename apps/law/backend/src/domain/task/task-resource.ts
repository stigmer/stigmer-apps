/**
 * The Task resource on the commons pipeline. Operation matrix (DD-001):
 * create, update, updateStatus, get, list — no delete.
 *
 * Lifecycle state is STORED status: OPEN on create (domain step below),
 * changed only through UpdateStatus (the commons preserves stored status
 * across Update, so a client cannot smuggle a state change through a spec
 * edit). `overdue` is derived on read, never stored.
 */

import { clone, create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  createOperation,
  customOperation,
  defineResource,
  getOperation,
  listOperation,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import { callerFromRequest } from "../../auth/caller.js";
import {
  type GetTaskRequest,
  type ListTasksRequest,
  ListTasksResponseSchema,
  type Task,
  TaskPriority,
  TaskSchema,
  TaskService,
  TaskState,
  TaskStatusSchema,
  type UpdateTaskStatusRequest,
} from "../../gen/stigmer/law/task/v1/task_pb.js";

/**
 * "Today" for overdue derivation, in the firm's timezone (Asia/Kolkata —
 * the same clock the hearing-reminder schedule uses, DD-001). A UTC
 * server would otherwise flip tasks overdue at 05:30 the previous
 * evening, firm time. en-CA formats as YYYY-MM-DD, comparable to the
 * stored calendar dates as text.
 */
function todayInFirmTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

/**
 * Domain defaults (record model): a stored row always carries a concrete
 * priority. Runs on create AND update — a full-spec replacement with an
 * unspecified priority means "default", not "unset".
 */
const priorityDefaultStep: PipelineStep<WriteContext<Task>> = {
  name: "default-priority",
  execute(ctx) {
    const spec = (ctx.newState as Task).spec;
    if (spec && spec.priority === TaskPriority.UNSPECIFIED) {
      spec.priority = TaskPriority.MEDIUM;
    }
  },
};

/**
 * Create-only: every task starts OPEN. build-new-state cleared whatever
 * status the client sent (system-managed), so this sets the true initial
 * state right before persist.
 */
const openOnCreateStep: PipelineStep<WriteContext<Task>> = {
  name: "initialize-status",
  execute(ctx) {
    (ctx.newState as Task).status = create(TaskStatusSchema, { state: TaskState.OPEN });
  },
};

export function taskResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
}) {
  // case_id is mandatory (validated), assignee_id optional (the step
  // skips empty) — both must exist when set (FAILED_PRECONDITION, D3).
  const referenceChecks = referencesExistStep<Task>(deps.store, [
    { kind: "Case", label: "case", get: (t) => t.spec?.caseId || undefined },
    { kind: "User", label: "assignee", get: (t) => t.spec?.assigneeId || undefined },
  ]);

  return defineResource({
    definition: {
      kind: "Task",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "task",
      schema: TaskSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: callerFromRequest,
      // Page-shaped (T03 D4); pure computation here, so no query at all.
      deriveStatus: (tasks: readonly Task[]) => {
        const today = todayInFirmTimezone();
        for (const task of tasks) {
          const dueDate = task.spec?.dueDate;
          const state = task.status?.state ?? TaskState.UNSPECIFIED;
          task.status = create(TaskStatusSchema, {
            state,
            overdue:
              dueDate !== undefined && dueDate < today && state !== TaskState.CLOSED,
          });
        }
      },
    },
    service: TaskService,
    operations: {
      create: createOperation<Task>({
        beforePersist: [priorityDefaultStep, openOnCreateStep, referenceChecks],
      }),
      update: updateOperation<Task>({
        beforePersist: [priorityDefaultStep, referenceChecks],
      }),
      updateStatus: customOperation<Task, UpdateTaskStatusRequest, Task>({
        async handler(ctx) {
          // load() authorizes "updateStatus" (permissive for any firm
          // user — FR-USER-001 equal access, a deliberate decision).
          const task = await ctx.load({ id: ctx.input.id });
          // The pre-mutation state rides the event so subscribers can
          // diff, same as the update pipeline's previous-state contract.
          const previous = clone(TaskSchema, task);
          task.status = create(TaskStatusSchema, {
            state: ctx.input.state,
            overdue: false, // derived on read; never persisted as truth
          });
          const saved = await ctx.save(task);
          await ctx.publish("updated", saved, previous);
          return saved;
        },
      }),
      get: getOperation<Task, GetTaskRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: listOperation<Task, ListTasksRequest, unknown>({
        // The list contract: soonest due first, dateless last.
        orderBy: { field: "dueDate", direction: "asc", nulls: "last" },
        query: (req, caller) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          // No explicit filter means "My Tasks" (scope contract): the
          // caller-scoped default the D2 seam exists for.
          filter:
            req.caseId || req.assigneeId
              ? {
                  ...(req.caseId ? { caseId: req.caseId } : {}),
                  ...(req.assigneeId ? { assigneeId: req.assigneeId } : {}),
                }
              : { assigneeId: caller.id },
        }),
        respond: (items, totalCount) =>
          create(ListTasksResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // No delete: the operation matrix is enforced by the proto itself.
    },
  });
}
