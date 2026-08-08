/**
 * The TaskComment resource on the commons pipeline. Append-only (DD-001
 * operation matrix): create and list, nothing else — the proto declares
 * no other method, so the absence is the contract. Author and timestamp
 * are the envelope's created_by/created_at.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  createOperation,
  defineResource,
  listOperation,
  referencesExistStep,
} from "@stigmer/resource-api";
import { callerFromRequest } from "../../auth/caller.js";
import {
  type ListTaskCommentsRequest,
  ListTaskCommentsResponseSchema,
  type TaskComment,
  TaskCommentSchema,
  TaskCommentService,
} from "../../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";

export function taskCommentResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
}) {
  return defineResource({
    definition: {
      kind: "TaskComment",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cmt",
      schema: TaskCommentSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: callerFromRequest,
    },
    service: TaskCommentService,
    operations: {
      create: createOperation<TaskComment>({
        beforePersist: [
          referencesExistStep<TaskComment>(deps.store, [
            { kind: "Task", label: "task", get: (c) => c.spec?.taskId || undefined },
          ]),
        ],
      }),
      list: listOperation<TaskComment, ListTaskCommentsRequest, unknown>({
        // Oldest first — a conversation reads top-down (record model,
        // deliberately opposite to case notes).
        orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: { taskId: req.taskId },
        }),
        respond: (items, totalCount) =>
          create(ListTaskCommentsResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // No update, no delete: append-only by contract.
    },
  });
}
