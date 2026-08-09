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
import type { CallerExtractor } from "@stigmer/resource-api";
import {
  type GetTaskRequest,
  type ListTasksRequest,
  ListTasksResponseSchema,
  type ListTasksResponse,
  type Task,
  TaskListFilter,
  TaskListScope,
  TaskPriority,
  TaskSchema,
  TaskService,
  TaskState,
  TaskStatusSchema,
  type UpdateTaskStatusRequest,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { todayInFirmTimezone } from "../firm-clock.js";
import { isOverdue, openStatesFilter, overdueFilter } from "./overdue.js";

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
  caller: CallerExtractor;
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
      caller: deps.caller,
      // Page-shaped (T03 D4): overdue is pure computation; case_number
      // (T04b D9) is ONE bulk lookup per response — lawyers speak in case
      // numbers, and every task-listing consumer (web lists, WhatsApp
      // my_open_tasks) renders them, so the reference resolves here, never
      // client-side and never N+1.
      deriveStatus: async (tasks: readonly Task[]) => {
        const today = todayInFirmTimezone();
        const caseIds = [
          ...new Set(
            tasks
              .map((t) => t.spec?.caseId)
              .filter((id): id is string => !!id),
          ),
        ];
        const cases = await deps.store.getByIds("Case", caseIds);
        for (const task of tasks) {
          const state = task.status?.state ?? TaskState.UNSPECIFIED;
          const referenced = cases.get(task.spec?.caseId ?? "") as Case | undefined;
          task.status = create(TaskStatusSchema, {
            state,
            // The one overdue rule (overdue.ts) — the OVERDUE list
            // predicate filters on the same module, and the agreement
            // test pins that they answer identically.
            overdue: isOverdue(task.spec?.dueDate, state, today),
            // A dangling reference (case rows are never deleted in MVP,
            // but the field is best-effort display data) renders empty
            // rather than failing the read.
            caseNumber: referenced?.spec?.caseNumber ?? "",
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
      list: listOperation<Task, ListTasksRequest, ListTasksResponse>({
        // The list contract: soonest due first, dateless last.
        orderBy: { field: "dueDate", direction: "asc", nulls: "last" },
        query: (req, caller) => {
          // Scope first. An explicit case/assignee filter names its own
          // scope; otherwise "My Tasks" is the contract's default, and
          // FIRM must be asked for by name (T05) — before the scope
          // field existed, a firm-wide question was unexpressable and a
          // firm overview would have silently counted only the caller's
          // own work.
          const explicit = req.caseId || req.assigneeId;
          const scope = explicit
            ? {
                ...(req.caseId ? { caseId: req.caseId } : {}),
                ...(req.assigneeId ? { assigneeId: req.assigneeId } : {}),
              }
            : req.scope === TaskListScope.FIRM
              ? {}
              : { assigneeId: caller.id };
          // Then the named predicate — implemented here exactly once,
          // sharing the overdue module with the derivation.
          const predicate =
            req.filter === TaskListFilter.OPEN
              ? openStatesFilter()
              : req.filter === TaskListFilter.OVERDUE
                ? overdueFilter(todayInFirmTimezone())
                : {};
          return {
            pageSize: req.pageSize,
            pageOffset: req.pageOffset,
            filter: { ...scope, ...predicate },
          };
        },
        respond: (items, totalCount) =>
          create(ListTasksResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // No delete: the operation matrix is enforced by the proto itself.
    },
  });
}
