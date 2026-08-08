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
 * Until T04's JWT lands, the caller KIND is asserted by the x-dev-caller-*
 * shim (see auth/caller.ts) — these branches are real policy, but their
 * authentication is only as strong as that seam. Nothing deploys before
 * T04.
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

      // Account provisioning and password reset are operator actions
      // (FR-ADMIN-001; T01 owner decision 1: no self-registration, reset
      // is an operator action).
      if (kind === "User" && (operation === "create" || operation === "setPassword")) {
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
