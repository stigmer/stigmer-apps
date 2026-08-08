/**
 * THE firm policy module — the single definition of "what may this person
 * do". Both enforcement points consult it: the Connect handlers (via the
 * pipeline's mandatory authorize slot) today, and the MCP gate for
 * WhatsApp callers when T05 lands. Policy changes happen here and nowhere
 * else.
 *
 * MVP policy (scope contract, FR-USER-001): any authenticated firm user
 * may perform any exposed operation. The one exception arrives with the
 * User resource in T03 (User.create is operator-only, FR-ADMIN-001). The
 * future seam (FR-USER-002, the client's own OpenFGA-shaped ask): list
 * stays firm-wide, get/mutate becomes per-case-grant gated — swapped in
 * here, without touching any handler, because the authorize slot always
 * runs.
 */

import {
  ALLOW,
  deny,
  type AuthorizationPolicy,
} from "@stigmer/resource-api";

export function firmPolicy(): AuthorizationPolicy {
  return {
    authorize({ caller }) {
      if (!caller) {
        return deny("Authentication required");
      }
      return ALLOW;
    },
  };
}
