/**
 * The caller identity that flows through every pipeline run. Present from
 * day one — the Go edition hardcodes actor "system" because it has no auth
 * context, and that gap is deliberately not ported: audit fields and the
 * authorize step both need a real principal.
 *
 * How a principal is extracted from a request (JWT, header, MCP gate) is
 * the consuming application's concern; the pipeline only consumes the
 * result.
 */

export interface CallerPrincipal {
  /** Stable identifier recorded in audit fields (e.g. a User resource id). */
  readonly id: string;
  /**
   * - "user": an authenticated end user of the product
   * - "operator": the operating team (e.g. account provisioning)
   * - "system": internal automation (schedulers, event handlers)
   */
  readonly kind: "user" | "operator" | "system";
}

export const SYSTEM_PRINCIPAL: CallerPrincipal = { id: "system", kind: "system" };
