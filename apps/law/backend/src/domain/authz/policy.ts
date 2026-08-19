/**
 * THE firm policy module — the single definition of "what may this person
 * do". Every enforcement point consults it: the Connect handlers (via the
 * pipeline's mandatory authorize slot), the plain-HTTP byte routes, and
 * the MCP gate. Policy changes happen here and nowhere else (DD-A5).
 *
 * DENY BY DEFAULT, for real: the module's final answer is deny, and the
 * matrix below enumerates what each role MAY do (DD-001's who-sees-what
 * table is the source; FR-AUTHZ-005 pins every row with a test that
 * proves the DENIAL).
 *
 * THE ENGINE SPLIT (project DD-003): relationship questions — role
 * groups, case membership, the matter's lead, list scoping — are
 * answered by the FGA engine against the model in model.ts, whose
 * tuples are a projection of this app's own rows (tuples.ts).
 * Attribute-shaped rules stay in code: receipts-only ledger creation,
 * notification recipient, deadline owner, and the TaskComment→Task hop.
 * This module remains the one place that decides WHICH question each
 * operation asks.
 *
 * TWO FACTS STILL LOAD FROM THE STORE, deliberately:
 *   1. the caller's FirmMember profile — the LIVENESS gate (D1a):
 *      missing or inactive refuses everything before the engine is even
 *      asked, so deactivation can never depend on tuple sync
 *      (FR-MEMBER-002's every-access-path revocation);
 *   2. a TaskComment's case — reached through its Task (a store hop the
 *      relationship model deliberately does not flatten).
 * A store OR engine failure propagates and fails the request (INTERNAL)
 * — fail-closed by construction, never a silent allow. The pipeline
 * invokes authorize once per operation, so there is deliberately no
 * cross-request cache to go stale.
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
import { idOf, type AuthorizationEngine } from "@stigmer/authorization";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { LedgerEntryKind } from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import type { Task } from "../../gen/stigmer/law/task/v1/task_pb.js";
import { caseRef, FIRM_OBJECT, userRef } from "./tuples.js";

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
  // Denormalized from the immutable Document at extraction time.
  DocumentPage: (r) => r.spec?.caseId,
  // Denormalized from the immutable Document at create time,
  // pipeline-verified against the referenced document (DD-010).
  DocumentAnnotation: (r) => r.spec?.caseId,
  // The reliance trail (FR-CIT-001) — case content of the USING case;
  // the judgment side is verified by the create pipeline's steps.
  CitationUse: (r) => r.spec?.caseId,
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
   * undefined means "unscoped" (partners see the whole firm, and NEVER
   * enumerate: the short-circuit is also what keeps ListObjects clear
   * of its result cap). Non-partners get their ACTIVE membership case
   * ids (possibly empty: an empty scope matches nothing, the honest
   * answer).
   */
  visibleCaseIds(member: FirmMember): Promise<readonly string[] | undefined>;
  /**
   * FR-AUTHZ-003 list-LINE scoping (existence without content): lawyer
   * roles see every list line firm-wide (undefined = unscoped); clerks
   * see only the cases they work. Distinct from visibleCaseIds, which
   * scopes CONTENT — a non-member associate has lines but no content.
   */
  caseListScope(member: FirmMember): Promise<readonly string[] | undefined>;
}

export function createFirmPolicy(
  store: ResourceStore,
  engine: AuthorizationEngine,
): FirmPolicy {
  /** The liveness gate (D1a): a direct row read, never the engine. */
  async function memberOf(caller: CallerPrincipal): Promise<FirmMember | undefined> {
    const member = (await store.getByNaturalKey("FirmMember", caller.id)) as
      | FirmMember
      | undefined;
    if (!member) return undefined;
    // Explicit-presence bool: only true is active (unset means a
    // malformed row, and fail-closed treats it as inactive).
    return member.spec?.active === true ? member : undefined;
  }

  /** A role-group or permission verb on the firm object. */
  function onFirm(member: FirmMember, relation: string): Promise<boolean> {
    return engine.check({
      user: userRef(member.spec?.userId ?? ""),
      relation,
      object: FIRM_OBJECT,
    });
  }

  /** A permission verb on one case object. */
  function onCase(member: FirmMember, relation: string, caseId: string): Promise<boolean> {
    return engine.check({
      user: userRef(member.spec?.userId ?? ""),
      relation,
      object: caseRef(caseId),
    });
  }

  /** Partner, or active member of the case (optionally lawyers-only) —
   * the model's can_work_content / can_enter_deadline verbs. A missing
   * case reference leaves only the partner arm (nothing to be member of). */
  async function canTouchCaseContent(
    member: FirmMember,
    caseId: string | undefined,
    opts?: { clerkAllowed?: boolean },
  ): Promise<boolean> {
    if (!caseId) return onFirm(member, "partners");
    return onCase(
      member,
      opts?.clerkAllowed === false ? "can_enter_deadline" : "can_work_content",
      caseId,
    );
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
    const caseRefOf = CASE_REF[kind];
    const caseId =
      kind === "TaskComment" && resource !== undefined
        ? await caseIdOfTaskComment(resource)
        : resource !== undefined
          ? caseRefOf?.(resource as never)
          : undefined;

    switch (kind) {
      case "User": {
        // Account administration is the managing partner's surface
        // (FR-AUTH-002 as amended by DD-003 D4): create accounts, keep
        // profiles current (email/name/phone — the WhatsApp binding),
        // and issue activation codes. Everyone may read their OWN
        // record. SetPassword stays operator-only break-glass: setting
        // a password FOR someone is a silent-takeover lever; the code
        // path is visible to the account holder.
        switch (operation) {
          case "get": {
            const id = (resource as { metadata?: { id?: string } } | undefined)?.metadata?.id;
            if (id === member.spec?.userId) return ALLOW;
            return (await onFirm(member, "can_manage_firm_members"))
              ? ALLOW
              : deny("Only an operator or the managing partner may view other user accounts");
          }
          case "create":
          case "update":
          case "issueActivationCode":
            return (await onFirm(member, "can_manage_firm_members"))
              ? ALLOW
              : deny("Only an operator or the managing partner may manage user accounts");
          case "setPassword":
            return deny(
              "Only an operator may set a password directly — issue an activation code instead",
            );
          default:
            return deny(`User ${operation} is not permitted`);
        }
      }

      case "FirmMember": {
        if (operation === "create" || operation === "update") {
          // The one in-product account-administration surface (matrix:
          // operator + managing partner). update includes deactivation.
          return (await onFirm(member, "can_manage_firm_members"))
            ? ALLOW
            : deny("Only the managing partner may manage firm members");
        }
        // The roster (names, roles) is firm-visible: pickers need it.
        return ALLOW;
      }

      case "Client": {
        if (operation === "create" || operation === "update") {
          return (await onFirm(member, "can_manage_clients"))
            ? ALLOW
            : deny("Only partners and associates may manage clients");
        }
        // get/list/search: the client register is lawyer-visible; clerks
        // and office staff work through their cases, not the register.
        return (await onFirm(member, "can_view_clients"))
          ? ALLOW
          : deny("The client register is visible to lawyers only");
      }

      case "Citation": {
        // The library shelf (DD-012 D2) — firm-level like Client, but
        // scoped to everyone who works cases: shelf entries describe
        // library documents, and their visibility must equal their
        // papers' (the FR-DOC-005 library arm). Writes are equally
        // wide by design — the shelf compounds because anyone on case
        // work can file, refine, or promote; Promote's source-case
        // membership is the pipeline's own guard, not a role matter.
        return (await onFirm(member, "case_workers"))
          ? ALLOW
          : deny("Office staff do not view case content");
      }

      case "Case": {
        switch (operation) {
          case "create":
            return (await onFirm(member, "can_create_case"))
              ? ALLOW
              : deny("Only partners and associates may open new matters");
          case "update":
          case "updateStatus": {
            // can_edit = lead or partner. An id-less resource (never a
            // loaded one) leaves only the partner arm — the same
            // degradation canTouchCaseContent applies.
            const mayEdit =
              caseId !== undefined
                ? await onCase(member, "can_edit", caseId)
                : await onFirm(member, "partners");
            return mayEdit
              ? ALLOW
              : deny("Only partners or the matter's lead lawyer may edit a case");
          }
          case "get":
            return (await canTouchCaseContent(member, caseId))
              ? ALLOW
              : deny("Only case members and partners may view case content");
          case "list":
            // Summaries are the list line (FR-AUTHZ-003): all lawyer
            // roles see them firm-wide; clerks see their member cases
            // (query-scoped); office staff see no cases at all.
            return (await onFirm(member, "can_list_cases"))
              ? ALLOW
              : deny("Case lists are not visible to office staff");
          default:
            return deny(`Case ${operation} is not permitted`);
        }
      }

      case "CaseMember": {
        if (operation === "create") {
          // Role gate here; partner-or-lead is the guard's create-input
          // check (assertManageMembers in the resource's step).
          return (await onFirm(member, "lawyers"))
            ? ALLOW
            : deny("Only lawyers may manage case members");
        }
        if (operation === "remove") {
          const mayRemove =
            caseId !== undefined
              ? await onCase(member, "can_manage_members", caseId)
              : await onFirm(member, "partners");
          return mayRemove
            ? ALLOW
            : deny("Only partners or the matter's lead lawyer may remove case members");
        }
        if (operation === "list") {
          // Scope-level role gate; the member set is case content, so
          // the list handler's guard carries the membership check the
          // request-blind authorize cannot (module header, rule shapes).
          return (await onFirm(member, "case_workers"))
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
      case "DocumentAnnotation":
      case "CitationUse":
      case "Task": {
        // Case content, clerk included (the clerk records hearings —
        // DD-001's division of labour; a clerk who works the case may
        // mark its documents, DD-010 as decided 2026-08-15). Creates
        // carry their membership check in the guard; loaded-resource
        // operations check here. DocumentAnnotation joins this branch
        // rather than TaskComment's standalone one because its case_id
        // is denormalized on the spec — no store hop needed.
        if (kind === "Document" && operation === "recordExtraction") {
          // The sweep's status report — a person can never write it,
          // membership notwithstanding (the fall-through below would
          // otherwise allow any case member).
          return deny("Extraction status is system-written");
        }
        if (operation === "create") {
          return (await onFirm(member, "case_workers"))
            ? ALLOW
            : deny("Office staff do not work case content");
        }
        if (operation === "list") {
          return (await onFirm(member, "case_workers"))
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        if ((kind === "Document" || kind === "DocumentAnnotation") && !caseId) {
          // The FIRM LIBRARY arm (FR-DOC-005) — the ONE deliberate
          // exception to canTouchCaseContent's fail-closed missing-case
          // default (partners-only): a case-less document is library
          // material BY INVARIANT (the create pipeline refuses
          // case-less rows outside the library category —
          // document-resource.ts libraryIntegrity), public-record and
          // readable by everyone who works cases. A case-less
          // DocumentAnnotation is the FIRM LAYER of a library mark
          // (DD-012 D2) — same invariant chain: its pipeline verifies
          // the empty case is legitimate (library documents only), so
          // the same read rule applies.
          return (await onFirm(member, "case_workers"))
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        return (await canTouchCaseContent(member, caseId))
          ? ALLOW
          : deny("Only case members and partners may work this matter");
      }

      case "TaskComment": {
        if (operation === "create" || operation === "list") {
          return (await onFirm(member, "case_workers"))
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        return (await canTouchCaseContent(member, caseId))
          ? ALLOW
          : deny("Only case members and partners may work this matter");
      }

      case "DocumentPage": {
        // A page is its document's content, written only by the
        // extraction sweep (FR-DOC-003). Reads follow the Document's
        // case-content rule; the handlers' guards carry the scoping
        // (pages are listed per document; search is visibility-filtered
        // inside the store query).
        if (operation === "list" || operation === "search") {
          return (await onFirm(member, "case_workers"))
            ? ALLOW
            : deny("Office staff do not view case content");
        }
        if (operation === "get") {
          if (!caseId) {
            // Library pages inherit their document's case-lessness —
            // the same FR-DOC-005 arm as the Document branch above.
            return (await onFirm(member, "case_workers"))
              ? ALLOW
              : deny("Office staff do not view case content");
          }
          return (await canTouchCaseContent(member, caseId))
            ? ALLOW
            : deny("Only case members and partners may view case content");
        }
        return deny("Document pages are system-written");
      }

      case "Deadline": {
        // Clerks SEE deadlines on their cases (case content) but never
        // enter or resolve them (matrix: enter deadline — lawyers only).
        switch (operation) {
          case "create":
            return (await onFirm(member, "lawyers"))
              ? ALLOW
              : deny("Only lawyers may enter deadlines");
          case "update":
          case "updateStatus": {
            // Owner is an attribute rule (DD-003 D3): a tuple per
            // deadline would project ephemeral rows into the engine.
            const owner = (resource as { spec?: { ownerId?: string } } | undefined)?.spec
              ?.ownerId;
            return (await onFirm(member, "partners")) || owner === member.metadata?.id
              ? ALLOW
              : deny("Only the deadline's owner or a partner may change it");
          }
          case "get":
            return (await canTouchCaseContent(member, caseId))
              ? ALLOW
              : deny("Only case members and partners may view case content");
          case "list":
            return (await onFirm(member, "case_workers"))
              ? ALLOW
              : deny("Office staff do not view case content");
          default:
            return deny(`Deadline ${operation} is not permitted`);
        }
      }

      case "FeeArrangement": {
        // Money is the sharpest boundary (FR-AUTHZ-004): partners only,
        // every operation — including reads.
        return (await onFirm(member, "can_view_money"))
          ? ALLOW
          : deny("Fee arrangements are visible to partners only");
      }

      case "LedgerEntry": {
        if (operation === "create") {
          // Role gate: partners and office staff reach the pipeline; the
          // receipts-only rule needs the entry kind and lives in the
          // guard (assertLedgerCreate).
          return (await onFirm(member, "can_record_ledger"))
            ? ALLOW
            : deny("Only partners and office staff may record ledger entries");
        }
        return (await onFirm(member, "can_view_money"))
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
          // identity — the proto's documented exception). An attribute
          // rule (DD-003 D3), deliberately not a tuple per notification.
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
          return (await onFirm(member, "can_view_audit"))
            ? ALLOW
            : deny("Change history is visible to partners only");
        }
        return deny("Audit entries are system-written");
      }

      default:
        return deny(`${kind} ${operation} is not permitted`);
    }
  }

  /* ------------------- non-person principal branches ---------------- */

  function authorizeOperator(kind: string, operation: string): AuthorizationDecision {
    // The operator key administers ACCOUNTS (FR-AUTH-002), never case
    // work: User fully, FirmMember fully (provisioning binds profiles).
    // Not an identity account — no tuples exist for it (DD-003 D3).
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
    if (kind === "DocumentPage" && operation === "create") return ALLOW; // extraction sweep
    // The sweep's status report — a named mutation that can only touch
    // status (its handler never reads spec), so this allowance cannot
    // widen into editing the record (FR-DOC-003).
    if (kind === "Document" && operation === "recordExtraction") return ALLOW;
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
      if (await onFirm(member, "partners")) return member;
      throw permissionDenied("This is visible to partners only");
    },

    async assertManageMembers(caller, caseId) {
      const member = await guards.requireMember(caller);
      if (await onCase(member, "can_manage_members", caseId)) {
        return member;
      }
      throw permissionDenied(
        "Only partners or the matter's lead lawyer may manage case members",
      );
    },

    async assertLedgerCreate(caller, entryKind) {
      const member = await guards.requireMember(caller);
      if (await onFirm(member, "partners")) return member;
      if (await onFirm(member, "office_staff")) {
        if (entryKind === LedgerEntryKind.RECEIPT) {
          return member;
        }
        throw permissionDenied("Office staff may record receipts only");
      }
      throw permissionDenied("Only partners and office staff may record ledger entries");
    },

    async visibleCaseIds(member) {
      if (await onFirm(member, "partners")) return undefined;
      const objects = await engine.listObjects(
        userRef(member.spec?.userId ?? ""),
        "can_work_content",
        "case",
      );
      return objects.map(idOf);
    },

    async caseListScope(member) {
      if (await onFirm(member, "lawyers")) return undefined;
      return guards.visibleCaseIds(member);
    },
  };

  return { policy, guards };
}
