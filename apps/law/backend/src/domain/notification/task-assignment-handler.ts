/**
 * TASK_ASSIGNMENT: the first real subscriber on the resource event
 * dispatcher — notifications hang off resource events, never off handler
 * code (Design Position 3), so the Task pipeline knows nothing about
 * notifications and adding this consumer touched no pipeline.
 *
 * Fires only when the new assignee differs from the old, is set, and is
 * not the actor (no self-assign notify — scope contract). Delivery in
 * MVP is the inbox; WhatsApp delivery is a config-gated fast-follow
 * (T01 owner decision 3).
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  CallerPrincipal,
  InProcessEventDispatcher,
  ResourceStore,
} from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import {
  type Notification,
  NotificationSchema,
  NotificationType,
} from "../../gen/stigmer/law/notification/v1/notification_pb.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";

export function registerTaskAssignmentHandler(
  dispatcher: InProcessEventDispatcher,
  store: ResourceStore,
  createNotification: (input: Notification, caller: CallerPrincipal) => Promise<Notification>,
): void {
  dispatcher.subscribe("Task", async (event) => {
    const task = event.resource as Task;
    const previous = event.previous as Task | undefined;

    const assigneeId = task.spec?.assigneeId;
    if (!assigneeId) return;
    // Unchanged assignee (including status-only updates) never notifies;
    // assignment at creation does (previous is undefined there).
    if (previous?.spec?.assigneeId === assigneeId) return;

    // The assignee is a FirmMember; the inbox is the login identity —
    // resolve the profile to its user (the notification proto's
    // documented exception). No profile or deactivated ⇒ nothing to
    // deliver to.
    const assignee = (await store.getById("FirmMember", assigneeId)) as
      | FirmMember
      | undefined;
    const recipientUserId = assignee?.spec?.active === true ? assignee.spec.userId : undefined;
    if (!recipientUserId) return;
    // No self-assign notify (scope contract): the actor id is a USER id.
    if (event.actor.id === recipientUserId) return;

    // Dedup owner: the Notification unique constraint — this key is the
    // only sent-state that exists. The task VERSION is part of the key
    // (the HEARING_REMINDER analogue, T03 plan): re-assigning A→B→A
    // composes a new key and legitimately notifies A again, while a
    // duplicate delivery of the same event cannot notify twice.
    const dedupKey = `task_assignment:${task.metadata?.id}:${assigneeId}:v${task.metadata?.version}`;

    try {
      await createNotification(
        create(NotificationSchema, {
          spec: {
            recipientId: recipientUserId,
            type: NotificationType.TASK_ASSIGNMENT,
            title: "New task assigned to you",
            body: `You have been assigned: "${task.spec?.title ?? ""}"`,
            target: { kind: "Task", id: task.metadata?.id ?? "" },
            dedupKey,
          },
        }),
        SYSTEM_PRINCIPAL,
      );
    } catch (err) {
      if (ConnectError.from(err).code === Code.AlreadyExists) {
        return; // already notified for this exact event — by design
      }
      throw err; // dispatcher contains and logs; the write already stands
    }
  });
}
