/**
 * The Notification resource on the commons pipeline. Operation matrix
 * (DD-001): create is SYSTEM-only — declared as a systemOperation, so no
 * Create RPC exists on the wire at all and event handlers reach the full
 * pipeline through `invoke` (T03 D1); list and markRead/markAllRead are
 * the wire surface, recipient-scoped (policy + D2 caller-scoped list).
 *
 * Dedup is owned by the dedup_key unique constraint: a producer racing
 * itself gets ALREADY_EXISTS and treats it as "already notified". No
 * other sent-state exists anywhere (scope contract).
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  customOperation,
  defineResource,
  listOperation,
  MAX_PAGE_SIZE,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { CallerExtractor } from "@stigmer/resource-api";
import {
  type ListNotificationsRequest,
  type ListNotificationsResponse,
  ListNotificationsResponseSchema,
  type MarkAllNotificationsReadRequest,
  MarkAllNotificationsReadResponseSchema,
  type MarkNotificationReadRequest,
  type Notification,
  NotificationSchema,
  NotificationService,
  NotificationStatusSchema,
} from "../../gen/stigmer/law/notification/v1/notification_pb.js";

/**
 * Every notification starts unread — with `read` EXPLICITLY false:
 * NotificationStatus.read is a presence-tracked bool precisely so that
 * false serializes into the stored JSON and the unread filter
 * (read = 'false') can see it. An absent key would be invisible.
 */
const unreadOnCreateStep: PipelineStep<WriteContext<Notification>> = {
  name: "initialize-status",
  execute(ctx) {
    (ctx.newState as Notification).status = create(NotificationStatusSchema, { read: false });
  },
};

export function notificationResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "Notification",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "ntf",
      schema: NotificationSchema,
      naturalKey: {
        label: "dedup key",
        get: (n) => n.spec?.dedupKey ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: NotificationService,
    operations: {
      list: listOperation<Notification, ListNotificationsRequest, ListNotificationsResponse>({
        // Newest first (metadata-backed column, D5).
        orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
        // ALWAYS the caller's own — recipient scoping is server-side, not
        // a client option (the D2 seam).
        query: (req, caller) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: {
            recipientId: caller.id,
            ...(req.unreadOnly ? { read: "false" } : {}),
          },
        }),
        respond: (items, totalCount) =>
          create(ListNotificationsResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      markRead: customOperation<Notification, MarkNotificationReadRequest, Notification>({
        async handler(ctx) {
          // load() hands the resource to the policy, whose recipient-only
          // branch denies marking anyone else's notification (fail-closed
          // when no resource reaches it).
          const notification = await ctx.load({ id: ctx.input.id });
          notification.status = create(NotificationStatusSchema, { read: true });
          return ctx.save(notification);
        },
      }),
      markAllRead: customOperation<
        Notification,
        MarkAllNotificationsReadRequest,
        unknown
      >({
        async handler(ctx) {
          // Scope-level authorization; recipient scoping below is by
          // construction (the query is pinned to the caller), so there is
          // no cross-user surface to police per-resource.
          await ctx.authorize();
          const callerId = ctx.caller?.id as string;
          const unread = await deps.store.list("Notification", {
            // One page per call, documented on the RPC: bounded work per
            // request; callers with >100 unread call again.
            limit: MAX_PAGE_SIZE,
            offset: 0,
            orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
            filter: { recipientId: callerId, read: "false" },
          });
          for (const item of unread.items) {
            const notification = item as Notification;
            notification.status = create(NotificationStatusSchema, { read: true });
            await ctx.save(notification);
          }
          return create(MarkAllNotificationsReadResponseSchema, {
            markedCount: unread.items.length,
          });
        },
      }),
      // No Get, no delete: absences declared by the proto itself.
    },
    systemOperations: {
      // The system-written seam (D1): reachable only through invoke, and
      // the policy additionally requires a system principal.
      create: {
        beforePersist: [
          unreadOnCreateStep,
          referencesExistStep<Notification>(deps.store, [
            { kind: "User", label: "recipient", get: (n) => n.spec?.recipientId || undefined },
          ]),
        ],
      },
    },
  });
}
