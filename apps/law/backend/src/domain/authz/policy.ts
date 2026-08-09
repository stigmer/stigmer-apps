/**
 * THE firm policy module — the single definition of "what may this person
 * do". Both enforcement points consult it: the Connect handlers (via the
 * pipeline's mandatory authorize slot) today, and the MCP gate for
 * WhatsApp callers when T05 lands. Policy changes happen here and nowhere
 * else.
 *
 * MVP policy (scope contract, FR-USER-001): any authenticated firm user
 * may perform any exposed operation, except the branches below. The
 * future seam (FR-USER-002, the client's own OpenFGA-shaped ask): list
 * stays firm-wide, get/mutate becomes per-case-grant gated — swapped in
 * here, without touching any handler, because the authorize slot always
 * runs.
 *
 * Caller KIND is real authentication since T04a (DD-005): bearer tokens
 * verify to user-kind only, the opk_ operator key to operator-kind, and
 * the system kind exists exclusively in-process — so the operator and
 * system branches below are enforced boundaries, not assertions.
 */

import {
  ALLOW,
  deny,
  type AuthorizationPolicy,
} from "@stigmer/resource-api";

export function firmPolicy(): AuthorizationPolicy {
  return {
    authorize({ caller, kind, operation, resource }) {
      if (!caller) {
        return deny("Authentication required");
      }

      // Account provisioning, profile corrections, and password reset are
      // operator actions (FR-ADMIN-001; T01 owner decision 1: no
      // self-registration, reset is an operator action). Update belongs in
      // this branch as a SECURITY boundary, not bookkeeping: User.spec.phone
      // is the WhatsApp channel binding (DD-008), and this policy's MVP
      // default below is ALLOW — without this line, any signed-in firm user
      // could bind their own phone to a partner's account and be that
      // partner to the assistant (wrong-assumptions/001's class of defect).
      if (
        kind === "User" &&
        (operation === "create" || operation === "update" || operation === "setPassword")
      ) {
        return caller.kind === "operator"
          ? ALLOW
          : deny("Only an operator may manage user accounts");
      }

      if (kind === "Notification") {
        // Notifications are system-written (DD-001 operation matrix):
        // only the event handlers, acting as the system principal through
        // the in-process invoker, may create them.
        if (operation === "create") {
          return caller.kind === "system"
            ? ALLOW
            : deny("Notifications are system-written");
        }
        // A notification belongs to its recipient — marking someone
        // else's notification read was the one cross-user surface the
        // permissive MVP policy would have allowed (T03 planning find).
        // Fail-closed: a markRead authorization without a loaded resource
        // (undefined recipient) is denied, never waved through.
        if (operation === "markRead") {
          const recipientId = (resource as { spec?: { recipientId?: string } } | undefined)
            ?.spec?.recipientId;
          return recipientId !== undefined && recipientId === caller.id
            ? ALLOW
            : deny("Only the recipient may mark a notification read");
        }
      }

      return ALLOW;
    },
  };
}
