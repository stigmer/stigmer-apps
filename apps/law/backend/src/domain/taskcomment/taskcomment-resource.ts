/**
 * The TaskComment resource on the commons pipeline. Append-only (DD-001
 * operation matrix): create and list, nothing else — the proto declares
 * no other method, so the absence is the contract. Author and timestamp
 * are the envelope's created_by/created_at.
 *
 * Comments are case content reached THROUGH the task: both write and
 * list resolve task → case and gate on membership (FR-AUTHZ-002).
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  createOperation,
  customOperation,
  defineResource,
  failedPrecondition,
  invalidArgument,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import {
  type ListTaskCommentsRequest,
  type ListTaskCommentsResponse,
  ListTaskCommentsResponseSchema,
  type TaskComment,
  TaskCommentSchema,
  TaskCommentService,
} from "../../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

export function taskCommentResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  async function caseIdOfTask(taskId: string): Promise<string> {
    const task = (await deps.store.getById("Task", taskId)) as Task | undefined;
    if (!task) {
      throw failedPrecondition(`Referenced task '${taskId}' not found`);
    }
    return task.spec?.caseId ?? "";
  }

  const membershipOnWrite: PipelineStep<WriteContext<TaskComment>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const taskId = (ctx.newState as TaskComment).spec?.taskId;
      if (ctx.caller && taskId) {
        await deps.guards.assertCaseContent(ctx.caller, await caseIdOfTask(taskId));
      }
    },
  };

  return defineResource({
    definition: {
      kind: "TaskComment",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cmt",
      schema: TaskCommentSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: TaskCommentService,
    operations: {
      create: createOperation<TaskComment>({
        beforePersist: [
          membershipOnWrite,
          referencesExistStep<TaskComment>(deps.store, [
            { kind: "Task", label: "task", get: (c) => c.spec?.taskId || undefined },
          ]),
        ],
      }),
      list: customOperation<TaskComment, ListTaskCommentsRequest, ListTaskCommentsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          await deps.guards.assertCaseContent(
            ctx.caller,
            await caseIdOfTask(ctx.input.taskId),
          );
          const { items, totalCount } = await deps.store.list("TaskComment", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // Oldest first — a conversation reads top-down (record
            // model, deliberately opposite to case notes).
            orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
            filter: { taskId: ctx.input.taskId },
          });
          return create(ListTaskCommentsResponseSchema, {
            items: items as TaskComment[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No update, no delete: append-only by contract.
    },
  });
}
