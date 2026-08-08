/**
 * Authorization is a mandatory pipeline slot with a pluggable policy —
 * the capability the Go edition dropped and this edition restores. One
 * policy module serves every enforcement point (Connect handlers here; an
 * MCP gate consults the same module), so "what may this person do" has
 * exactly one definition per product.
 *
 * Deliberate simplification vs the Java parent: Java drives authorization
 * from proto method options (permission enum, FGA tuple checks). A simple
 * function interface covers the products' MVP policies; proto-option
 * config and FGA-shaped grants swap in later behind this same slot without
 * touching handlers — the slot existing is the point.
 */

import type { ResourceMessage } from "./envelope.js";
import type { CallerPrincipal } from "./principal.js";

export interface AuthorizationRequest {
  /** Undefined when the caller presented no (valid) identity. */
  readonly caller: CallerPrincipal | undefined;
  readonly kind: string;
  /** Operation name as declared on the resource (create/update/get/list/…). */
  readonly operation: string;
  /**
   * The loaded resource for operations that target one (update/get/custom
   * after load); undefined for create/list. This is what future per-case
   * grant policies will inspect.
   */
  readonly resource?: ResourceMessage;
}

export type AuthorizationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface AuthorizationPolicy {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> | AuthorizationDecision;
}

export const ALLOW: AuthorizationDecision = { allow: true };

export function deny(reason: string): AuthorizationDecision {
  return { allow: false, reason };
}

/**
 * MVP policy shape: any authenticated caller may perform any operation.
 * Products layer exceptions on top (e.g. "User.create is operator-only")
 * in their own policy module.
 */
export function allowAnyAuthenticated(): AuthorizationPolicy {
  return {
    authorize({ caller }) {
      // The unauthenticated case is handled by the authorize step itself
      // (UNAUTHENTICATED, not PERMISSION_DENIED); reaching here with a
      // caller means: allowed.
      return caller ? ALLOW : deny("Authentication required");
    },
  };
}
