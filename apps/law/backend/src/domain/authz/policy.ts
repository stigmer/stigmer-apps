/**
 * THE firm policy module — the single definition of "what may this person
 * do". Every enforcement point consults it: the Connect handlers (via the
 * pipeline's mandatory authorize slot), the plain-HTTP byte routes, and
 * the MCP gate. Policy changes happen here and nowhere else (DD-A5).
 *
 * DENY BY DEFAULT, for real: the module's final answer is deny, and the
 * matrix below enumerates what each role MAY do (DD-001's who-sees-what
 * table is the source; FR-AUTHZ-005 pins every row with a test that
 * proves the DENIAL). This inverts the MVP module, whose final answer
 * was ALLOW.
 *
 * The policy consults exactly two stored facts (Gate-1 Q1):
 *   1. the caller's FirmMember profile — resolved by user id (the
 *      natural key), refused when missing or inactive;
 *   2. active case membership — resolved by the composed
 *      `{caseId}:{memberId}` natural key.
 * Both loads happen inside authorize; a store failure propagates and
 * fails the request (INTERNAL) — fail-closed by construction, never a
 * silent allow. The pipeline invokes authorize once per operation, so
 * there is deliberately no cross-request cache to go stale.
 *
 * TWO RULE SHAPES, ONE MODULE: the authorize slot sees the loaded
 * resource for update/get/custom operations but NOT the input of a
 * create (the pipeline authorizes creates before building state). Rules
 * that depend on create INPUT — "members may add hearings only to their
 * own cases", "office staff may record receipts only" — are therefore
 * exported as guards that the resources' beforePersist steps invoke.
 * The rules still live here and only here; the steps are enforcement
 * points, not rule owners.
 */

import {
  ALLOW,
  deny,
  permissionDenied,
  type AuthorizationDecision,
  type AuthorizationPolicy,
  type CallerPrincipal,
  type ResourceStore,
} from "@stigmer/resource-api";
import {
  FirmRole,
  type FirmMember,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { LedgerEntryKind } from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";

/** Roles with full firm-wide content and money visibility. */
const PARTNER_ROLES: readonly FirmRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
];

/** Roles that practice — see case list lines and work member cases. */
const LAWYER_ROLES: readonly FirmRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
  FirmRole.ASSOCIATE,
  FirmRole.JUNIOR,
];

/** Roles that work case content when they are members (lawyers + clerk). */
const CASE_WORKER_ROLES: readonly FirmRole[] = [...LAWYER_ROLES, FirmRole.CLERK];

/**
 * Where a loaded resource's case reference lives, per kind — the one
 * registry the matrix's "case content" column compiles to. TaskComment
 * is absent deliberately: its case is reached through the Task, which
 * needs a store hop (see caseIdOfTaskComment).
 */
const CASE_REF: Readonly<
  Record<string, (resource: { metadata?: { id?: string }; spec?: { caseId?: string } }) => string | undefined>
> = {
  Case: (r) => r.metadata?.id,
  CaseMember: (r) => r.spec?.caseId,
  Hearing: (r) => r.spec?.caseId,
  Deadline: (r) => r.spec?.caseId,
  FeeArrangement: (r) => r.spec?.caseId,
  LedgerEntry: (r) => r.spec?.caseId,
  Task: (r) => r.spec?.caseId,
  CaseNote: (r) => r.spec?.caseId,
  Document: (r) => r.spec?.caseId,
};

export interface FirmPolicy {
  /** The authorize-slot implementation every pipeline consults. */
  readonly policy: AuthorizationPolicy;
  /**
   * Create-time and query-time rules for the enforcement points that see
   * what authorize cannot (create input, list scoping). Every guard
   * throws PERMISSION_DENIED with a user-facing reason, or returns.
   */
  readonly guards: PolicyGuards;
}

export interface PolicyGuards {
  /** The caller's FirmMember, refused when missing or deactivated. */
  requireMember(caller: CallerPrincipal): Promise<FirmMember>;
  /**
   * Case-content write/read gate: partners pass; everyone else must be
   * an ACTIVE member of the case. `clerkAllowed: false` narrows to
   * lawyer roles (the deadline rule — clerks see deadlines but never
   * enter them).
   */
  assertCaseContent(
    caller: CallerPrincipal,
    caseId: string,
    opts?: { clerkAllowed?: boolean },
  ): Promise<FirmMember>;
  /** Partner-only gate (money, audit history). */
  assertPartner(caller: CallerPrincipal): Promise<FirmMember>;
  /**
   * Case-membership management (FR-CASE-003): partners, or the case's
   * lead lawyer — the create-input twin of the authorize-slot rule the
   * loaded-resource operations get.
   */
  assertManageMembers(caller: CallerPrincipal, caseId: string): Promise<FirmMember>;
  /**
   * The ledger-create rule (FR-AUTHZ-004): partners record anything;
   * office staff record RECEIPTS ONLY, blind to arrangements and
   * balances; everyone else is refused.
   */
  assertLedgerCreate(caller: CallerPrincipal, entryKind: LedgerEntryKind): Promise<FirmMember>;
  /**
   * The case ids the caller may see content of, for query scoping —
   * undefined means "unscoped" (partners see the whole firm). Non-
   * partners get their ACTIVE membership case ids (possibly empty:
   * an empty scope matches nothing, the honest answer).
   */
  visibleCaseIds(member: FirmMember): Promise<readonly string[] | undefined>;
  /** True when the member's role is partner-level. */
  isPartner(member: FirmMember): boolean;
}

export function createFirmPolicy(store: ResourceStore): FirmPolicy {
  async function memberOf(caller: CallerPrincipal): Promise<FirmMember | undefined> {
    const member = (await store.getByNaturalKey("FirmMember", caller.id)) as
      | FirmMember
      | undefined;
    if (!member) return undefined;
    // Explicit-presence bool: only true is active (unset means a
    // malformed row, and fail-closed treats it as inactive).
    return member.spec?.active === true ? member : undefined;
  }

  function hasRole(member: FirmMember, roles: readonly FirmRole[]): boolean {
    return member.spec !== undefined && roles.includes(member.spec.role);
  }

  const isPartner = (member: FirmMember) => hasRole(member, PARTNER_ROLES);

  async function isActiveMemberOfCase(caseId: string, member: FirmMember): Promise<boolean> {
    const membership = await store.getByNaturalKey(
      "CaseMember",
      `${caseId}:${member.metadata?.id}`,
    );
    return (
      (membership as { status?: { active?: boolean } } | undefined)?.status?.active === true
    );
  }

  /** Partner, or active member of the case (optionally lawyers-only). */
  async function canTouchCaseContent(
    member: FirmMember,
    caseId: string | undefined,
    opts?: { clerkAllowed?: boolean },
  ): Promise<boolean> {
    const roles = opts?.clerkAllowed === false ? LAWYER_ROLES : CASE_WORKER_ROLES;
    if (!hasRole(member, roles)) return false;
    if (isPartner(member)) return true;
    if (!caseId) return false; // no case reference ⇒ nothing to be member of
    return isActiveMemberOfCase(caseId, member);
  }

  /** Partner, or the case's lead lawyer — the case-management rule. */
  function isLead(member: FirmMember, resource: unknown): boolean {
    const lead = (resource as { spec?: { leadLawyerId?: string } } | undefined)?.spec
      ?.leadLawyerId;
    return lead !== undefined && lead === member.metadata?.id;
  }

  async function caseIdOfTaskComment(resource: unknown): Promise<string | undefined> {
    const taskId = (resource as { spec?: { taskId?: string } } | undefined)?.spec?.taskId;
    if (!taskId) return undefined;
    const task = (await store.getById("Task", taskId)) as Task | undefined;
    return task?.spec?.caseId;
  }

  /* ----------------------- the user-role matrix --------------------- */

  async function authorizeUser(
    member: FirmMember,
    kind: string,
    operation: string,
    resource: unknown,
  ): Promise<AuthorizationDecision> {
    const caseRef = CASE_REF[kind];
    const caseId =
      kind === "TaskComment" && resource !== undefined
        ? await caseIdOfTaskComment(resource)
        : resource !== undefined
          ? caseRef?.(resource as never)
          : undefined;

    switch (kind) {
      case "User": {
        // Account administration stays operator-only (FR-AUTH-002); a
        // signed-in person may read their own identity record.
        if (operation === "get") {
          const id = (resource as { metadata?: { id?: string } } | undefined)?.metadata?.id;
          return id === member.spec?.userId
            ? ALLOW
            : deny("Only an operator may view other user accounts");
        }
        return deny("Only an operator may manage user accounts");
      }

      case "FirmMember": {
        if (operation === "create" || operation === "update") {
          // The one in-product account-administration surface (matrix:
          // operator + managing partner). update includes deactivation.
          return hasRole(member, [FirmRole.MANAGING_PARTNER])
            ? ALLOW
            : deny("Only the managing partner may manage firm members");
        }
        // The roster (names, roles) is firm-visible: pickers need it.
        return ALLOW;
      }

      case "Client": {
        if (operation === "create" || operation === "update") {
          return hasRole(member, [FirmRole.MANAGING_PARTNER, FirmRole.PARTNER, FirmRole.ASSOCIATE])
            ? ALLOW
            : deny("Only partners and associates may manage clients");
        }
        // get/list/search: the client register is lawyer-visible; clerks
        // and office staff work through their cases, not the register.
        return hasRole(member, LAWYER_ROLES)
          ? ALLOW
          : deny("The client register is visible to lawyers only");
      }

      case "Case": {
        switch (operation) {
          case "create":
            return hasRole(member, [FirmRole.MANAGING_PARTNER, FirmRole.PARTNER, FirmRole.ASSOCIATE])
              ? ALLOW
              : deny("Only partners and associates may open new matters");
          case "update":
          case "updateStatus":
            return isPartner(member) || isLead(member, resource)
              ? ALLOW
              : deny("Only partners or the matter's lead lawyer may edit a case");
          case "get":
            return (await canTouchCaseContent(member, caseId))
              ? ALLOW
              : deny("Only case members and partners may view case content");
          case "list":
            // Summaries are the list line (FR-AUTHZ-003): all lawyer
            // roles see them firm-wide; clerks see their member cases
            // (query-scoped); office staff see no cases at all.
            return hasRole(member, CASE_WORKER_ROLES)
              ? ALLOW
              : deny("Case lists are not visible to office staff");
          default:
            return deny(`Case ${operation} is not permitted`);
        }
      }

      case "CaseMember": {
        if (operation === "create") {
          // Role gate here; partner-or-lead is the guard's create-input
          // check (assertCaseMemberManage in the resource's step).
          return hasRole(member, LAWYER_ROLES)
            ? ALLOW
            : deny("Only lawyers may manage case members");
        }
        if (operation === "remove") {
          return isPartner(member) || (caseId !== undefined && (await isLeadOfCase(caseId, member)))
            ? ALLOW
            : deny("Only partners or the matter's lead lawyer may remove case members");
        }
        if (operation === "list") {
          // Scope-level role gate; the member set is case content, so
          // the list handler's guard carries the membership check the
          // request-blind authorize cannot (module header, rule shapes).
          return hasRole(member, CASE_WORKER_ROLES)
            ? ALLOW
            : deny("Only case members and partners may view a case's member set");
        }
        return (await canTouchCaseContent(member, caseId))
          ? ALLOW
          : deny("Only case members and partners may view a case's member set");
      }

      case "Hearing":
      case "CaseNote":
      case "Document":
      case "Task": {
        // Case content, clerk included (the clerk records hearings —
        // DD-001's division of labour). Creates carry their membership
        // check in the guard; loaded-resource operations check here.
        if (operation === "create") {
          return hasRole(member, CASE_WORKER_ROLES)
            ? ALLOW
            : deny("Office staff do not work case content");
        }
        if (operation === "list") {
          return hasRole(member, CASE_WORKER_ROLES)
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        return (await canTouchCaseContent(member, caseId))
          ? ALLOW
          : deny("Only case members and partners may work this matter");
      }

      case "TaskComment": {
        if (operation === "create" || operation === "list") {
          return hasRole(member, CASE_WORKER_ROLES)
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        return (await canTouchCaseContent(member, caseId))
          ? ALLOW
          : deny("Only case members and partners may work this matter");
      }

      case "Deadline": {
        // Clerks SEE deadlines on their cases (case content) but never
        // enter or resolve them (matrix: enter deadline — lawyers only).
        switch (operation) {
          case "create":
            return hasRole(member, LAWYER_ROLES)
              ? ALLOW
              : deny("Only lawyers may enter deadlines");
          case "update":
          case "updateStatus": {
            const owner = (resource as { spec?: { ownerId?: string } } | undefined)?.spec
              ?.ownerId;
            return isPartner(member) || owner === member.metadata?.id
              ? ALLOW
              : deny("Only the deadline's owner or a partner may change it");
          }
          case "get":
            return (await canTouchCaseContent(member, caseId))
              ? ALLOW
              : deny("Only case members and partners may view case content");
          case "list":
            return hasRole(member, CASE_WORKER_ROLES)
              ? ALLOW
              : deny("Office staff do not view case content");
          default:
            return deny(`Deadline ${operation} is not permitted`);
        }
      }

      case "FeeArrangement": {
        // Money is the sharpest boundary (FR-AUTHZ-004): partners only,
        // every operation — including reads.
        return isPartner(member)
          ? ALLOW
          : deny("Fee arrangements are visible to partners only");
      }

      case "LedgerEntry": {
        if (operation === "create") {
          // Role gate: partners and office staff reach the pipeline; the
          // receipts-only rule needs the entry kind and lives in the
          // guard (assertLedgerCreate).
          return hasRole(member, [...PARTNER_ROLES, FirmRole.OFFICE_STAFF])
            ? ALLOW
            : deny("Only partners and office staff may record ledger entries");
        }
        return isPartner(member)
          ? ALLOW
          : deny("The ledger is visible to partners only");
      }

      case "Notification": {
        if (operation === "create") {
          return deny("Notifications are system-written");
        }
        if (operation === "markRead") {
          // A notification belongs to its recipient — fail-closed when
          // the recipient cannot be read off the loaded resource. The
          // recipient is a USER id (the inbox belongs to the login
          // identity — the proto's documented exception).
          const recipient = (resource as { spec?: { recipientId?: string } } | undefined)
            ?.spec?.recipientId;
          return recipient !== undefined && recipient === member.spec?.userId
            ? ALLOW
            : deny("Only the recipient may mark a notification read");
        }
        // list/markAllRead are recipient-scoped in their handlers.
        return ALLOW;
      }

      case "AuditEntry": {
        if (operation === "list") {
          return isPartner(member)
            ? ALLOW
            : deny("Change history is visible to partners only");
        }
        return deny("Audit entries are system-written");
      }

      default:
        return deny(`${kind} ${operation} is not permitted`);
    }
  }

  async function isLeadOfCase(caseId: string, member: FirmMember): Promise<boolean> {
    const theCase = await store.getById("Case", caseId);
    return isLead(member, theCase);
  }

  /* ------------------- non-person principal branches ---------------- */

  function authorizeOperator(kind: string, operation: string): AuthorizationDecision {
    // The operator key administers ACCOUNTS (FR-AUTH-002), never case
    // work: User fully, FirmMember fully (provisioning binds profiles).
    if (kind === "User" || kind === "FirmMember") {
      return ALLOW;
    }
    return deny("The operator credential administers accounts, not case work");
  }

  function authorizeSystem(kind: string, operation: string): AuthorizationDecision {
    // The system principal exists only in-process. Each allowance below
    // is one named seam; anything else is a bug surfacing as a denial.
    if (kind === "Notification" && operation === "create") return ALLOW; // event handlers + sweep
    if (kind === "AuditEntry" && operation === "create") return ALLOW; // audit subscriber
    if (kind === "Case" && operation === "update") return ALLOW; // next-hearing refresh (Q6)
    if (kind === "CaseMember" && operation === "create") return ALLOW; // lead materialization
    return deny(`System automation may not ${operation} ${kind}`);
  }

  /* ------------------------------ wiring ---------------------------- */

  const policy: AuthorizationPolicy = {
    async authorize({ caller, kind, operation, resource }) {
      if (!caller) {
        return deny("Authentication required");
      }
      if (caller.kind === "operator") {
        return authorizeOperator(kind, operation);
      }
      if (caller.kind === "system") {
        return authorizeSystem(kind, operation);
      }
      const member = await memberOf(caller);
      if (!member) {
        // Covers both "no profile" and "deactivated" — FR-MEMBER-002's
        // every-access-path revocation is exactly this line.
        return deny("No active firm membership for this account");
      }
      return authorizeUser(member, kind, operation, resource);
    },
  };

  const guards: PolicyGuards = {
    async requireMember(caller) {
      if (caller.kind !== "user") {
        throw permissionDenied("Only firm members may perform this action");
      }
      const member = await memberOf(caller);
      if (!member) {
        throw permissionDenied("No active firm membership for this account");
      }
      return member;
    },

    async assertCaseContent(caller, caseId, opts) {
      const member = await guards.requireMember(caller);
      if (await canTouchCaseContent(member, caseId, opts)) {
        return member;
      }
      throw permissionDenied(
        opts?.clerkAllowed === false
          ? "Only lawyers on this matter (or partners) may do this"
          : "Only case members and partners may work this matter",
      );
    },

    async assertPartner(caller) {
      const member = await guards.requireMember(caller);
      if (isPartner(member)) return member;
      throw permissionDenied("This is visible to partners only");
    },

    async assertManageMembers(caller, caseId) {
      const member = await guards.requireMember(caller);
      if (isPartner(member) || (await isLeadOfCase(caseId, member))) {
        return member;
      }
      throw permissionDenied(
        "Only partners or the matter's lead lawyer may manage case members",
      );
    },

    async assertLedgerCreate(caller, entryKind) {
      const member = await guards.requireMember(caller);
      if (isPartner(member)) return member;
      if (
        hasRole(member, [FirmRole.OFFICE_STAFF]) &&
        entryKind === LedgerEntryKind.RECEIPT
      ) {
        return member;
      }
      throw permissionDenied(
        hasRole(member, [FirmRole.OFFICE_STAFF])
          ? "Office staff may record receipts only"
          : "Only partners and office staff may record ledger entries",
      );
    },

    async visibleCaseIds(member) {
      if (isPartner(member)) return undefined;
      const memberships = await store.list("CaseMember", {
        // A working set, not a page: bounded by how many matters one
        // person can actually be on. The cap is the port's max and a
        // deliberate ceiling — beyond it, scoping questions belong to a
        // different product tier.
        limit: 100,
        offset: 0,
        orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
        filter: {
          memberId: member.metadata?.id ?? "",
          active: "true",
        },
      });
      return memberships.items.map(
        (m) => (m as { spec?: { caseId?: string } }).spec?.caseId ?? "",
      );
    },

    isPartner,
  };

  return { policy, guards };
}
