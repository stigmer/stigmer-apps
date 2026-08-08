/**
 * Resource event publishing — the second capability restored from the Java
 * edition (`ApiResourceEventPublisher`). Notifications and other reactions
 * hang off resource events, never off handler code, so adding a consumer
 * never touches a pipeline.
 *
 * DELIBERATE DIVERGENCE from the Java parent, recorded in the T02 plan: in
 * Java a publish failure after persist fails the whole request — the
 * client sees INTERNAL for a write that already stands, and the event is
 * lost anyway (no outbox exists). Here publish is best-effort: persist
 * succeeded ⇒ the request succeeds; a publish failure is logged loudly and
 * never surfaces. Known limitation (accepted while consumers are
 * inbox-only): a crash between persist and publish loses the event —
 * revisit with a durable dispatcher before events drive external delivery.
 */

import type { ResourceMessage } from "./envelope.js";
import type { CallerPrincipal } from "./principal.js";

export interface ResourceEvent {
  readonly kind: string;
  readonly type: "created" | "updated";
  /** Full new state after the write (the Java payload shape). */
  readonly resource: ResourceMessage;
  /** Old state on updates — what assignee-change-style consumers diff against. */
  readonly previous?: ResourceMessage;
  readonly actor: CallerPrincipal;
}

export interface ResourceEventPublisher {
  publish(event: ResourceEvent): Promise<void>;
}

export type ResourceEventHandler = (event: ResourceEvent) => Promise<void> | void;

/**
 * Synchronous in-process dispatcher — the MVP publisher. The interface is
 * the seam: a durable queue-backed dispatcher replaces this without any
 * pipeline or handler change.
 */
export class InProcessEventDispatcher implements ResourceEventPublisher {
  readonly #handlers = new Map<string, ResourceEventHandler[]>();

  /** Subscribe to events for one kind ("*" for all kinds). */
  subscribe(kind: string, handler: ResourceEventHandler): void {
    const list = this.#handlers.get(kind) ?? [];
    list.push(handler);
    this.#handlers.set(kind, list);
  }

  async publish(event: ResourceEvent): Promise<void> {
    const handlers = [
      ...(this.#handlers.get(event.kind) ?? []),
      ...(this.#handlers.get("*") ?? []),
    ];
    for (const handler of handlers) {
      // One failing subscriber must not starve the others — each failure
      // is contained and reported; none propagates to the request.
      try {
        await handler(event);
      } catch (err) {
        console.error(
          `resource event handler failed (kind=${event.kind}, type=${event.type}, ` +
            `id=${event.resource.metadata?.id}):`,
          err,
        );
      }
    }
  }
}

export const NOOP_PUBLISHER: ResourceEventPublisher = {
  async publish() {},
};
