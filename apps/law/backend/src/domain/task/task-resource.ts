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
  FilterValue,
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
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import type { CallerExtractor } from "@stigmer/resource-api";
import type { PolicyGuards } from "../authz/policy.js";
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
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  // case_id is mandatory (validated), assignee_id optional (the step
  // skips empty) — both must exist when set (FAILED_PRECONDITION, D3).
  // The assignee is a FirmMember (the rebuilt contract's person refs).
  const referenceChecks = referencesExistStep<Task>(deps.store, [
    { kind: "Case", label: "case", get: (t) => t.spec?.caseId || undefined },
    { kind: "FirmMember", label: "assignee", get: (t) => t.spec?.assigneeId || undefined },
  ]);

  // Tasks are case content: writes carry the create-input membership
  // check the authorize slot cannot make (policy.ts, rule shapes).
  const membershipOnWrite: PipelineStep<WriteContext<Task>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as Task).spec?.caseId;
      if (ctx.caller && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId);
      }
    },
  };

  // Page-shaped (T03 D4): overdue is pure computation; the file number
  // (T04b D9) is ONE bulk lookup per response — lawyers speak in file
  // numbers, and every task-listing consumer (web lists, the assistant's
  // task tools) renders them, so the reference resolves here, never
  // client-side and never N+1. Named because the CUSTOM list below must
  // apply it itself (custom operations bypass the automatic derivation).
  const deriveTaskStatus = async (tasks: readonly Task[]) => {
    const today = todayInFirmTimezone();
    const caseIds = [
      ...new Set(tasks.map((t) => t.spec?.caseId).filter((id): id is string => !!id)),
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
        // Best-effort display data: a dangling reference renders
        // empty rather than failing the read.
        caseFileNumber: referenced?.spec?.fileNumber ?? "",
      });
    }
  };

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
      deriveStatus: deriveTaskStatus,
    },
    service: TaskService,
    operations: {
      create: createOperation<Task>({
        beforePersist: [priorityDefaultStep, openOnCreateStep, membershipOnWrite, referenceChecks],
      }),
      update: updateOperation<Task>({
        beforePersist: [priorityDefaultStep, membershipOnWrite, referenceChecks],
      }),
      updateStatus: customOperation<Task, UpdateTaskStatusRequest, Task>({
        async handler(ctx) {
          // load() authorizes "updateStatus": case members and partners
          // (the rebuilt matrix).
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
      // Custom rather than the list flavor: "My Tasks" needs the
      // caller's FirmMember (an async fact), and non-partner visibility
      // scopes to member cases (the matrix, applied as query shaping).
      list: customOperation<Task, ListTasksRequest, ListTasksResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          const member = await deps.guards.requireMember(ctx.caller);

          // Scope first. An explicit case filter is case content and
          // gates on membership; otherwise "My Tasks" is the contract's
          // default and FIRM must be asked for by name — for partners
          // that is the whole firm, for everyone else their member
          // cases (the request widens the ask, never the visibility).
          let scope: Record<string, FilterValue>;
          if (ctx.input.caseId) {
            await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
            scope = {
              caseId: ctx.input.caseId,
              ...(ctx.input.assigneeId ? { assigneeId: ctx.input.assigneeId } : {}),
            };
          } else {
            const visible = await deps.guards.visibleCaseIds(member);
            const visibility: Record<string, FilterValue> =
              visible !== undefined ? { caseId: { in: [...visible] } } : {};
            if (ctx.input.assigneeId) {
              scope = { ...visibility, assigneeId: ctx.input.assigneeId };
            } else if (ctx.input.scope === TaskListScope.FIRM) {
              scope = visibility;
            } else {
              // "My Tasks": my assignments, by my FirmMember id.
              scope = { assigneeId: member.metadata?.id ?? "" };
            }
          }

          // Then the named predicate — implemented here exactly once,
          // sharing the overdue module with the derivation.
          const predicate =
            ctx.input.filter === TaskListFilter.OPEN
              ? openStatesFilter()
              : ctx.input.filter === TaskListFilter.OVERDUE
                ? overdueFilter(todayInFirmTimezone())
                : {};

          const { items, totalCount } = await deps.store.list("Task", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // The list contract: soonest due first, dateless last.
            orderBy: { field: "dueDate", direction: "asc", nulls: "last" },
            filter: { ...scope, ...predicate },
          });
          const tasks = items as Task[];
          await deriveTaskStatus(tasks);
          return create(ListTasksResponseSchema, {
            items: tasks,
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No delete: the operation matrix is enforced by the proto itself.
    },
  });
}
