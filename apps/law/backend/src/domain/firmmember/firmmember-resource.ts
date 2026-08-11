/**
 * The FirmMember resource — the identity profile (DD-001) and the
 * policy's first fact. Operation matrix: create, update, get (by id or
 * user id), list — no delete; deactivation is `active=false` via Update
 * (FR-MEMBER-002), with session revocation riding the resource event
 * (deactivation-handler.ts).
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  createOperation,
  defineResource,
  failedPrecondition,
  getOperation,
  listOperation,
  permissionDenied,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import type { User } from "@stigmer/identity";
import type { AuthorizationEngine } from "@stigmer/authorization";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmMemberStatusSchema,
  FirmRole,
  type FirmMember,
  type GetFirmMemberRequest,
  type ListFirmMembersRequest,
  type ListFirmMembersResponse,
  ListFirmMembersResponseSchema,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { applyTupleDeltaSafely, firmMemberTupleDelta } from "../authz/tuples.js";

/**
 * Explicit presence makes `active: false` a stored VALUE (the
 * Notification.read precedent); an unsent flag means active — a profile
 * is created to grant access, and requiring the operator to say
 * `active: true` out loud would make the common path noisy.
 */
const activeDefaultStep: PipelineStep<WriteContext<FirmMember>> = {
  name: "default-active",
  execute(ctx) {
    const spec = (ctx.newState as FirmMember).spec;
    if (spec && spec.active === undefined) {
      spec.active = true;
    }
  },
};

export function firmMemberResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  authz: AuthorizationEngine;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<FirmMember>(deps.store, [
    { kind: "User", label: "user", get: (m) => m.spec?.userId || undefined },
  ]);

  /**
   * The lockout guards (DD-003 D4): a firm must never be able to
   * administer itself into a state only the operator can undo.
   *
   * 1. Nobody deactivates their OWN account — the managing partner
   *    included; a second administrator (or the operator) does it.
   * 2. The last active managing partner can be neither demoted nor
   *    deactivated — data invariant, so it binds the operator too
   *    (FAILED_PRECONDITION, not a permission answer): the recovery
   *    path is creating another managing partner first, never a
   *    firm with zero administrators.
   */
  const lockoutGuards: PipelineStep<WriteContext<FirmMember>> = {
    name: "protect-firm-administration",
    async execute(ctx) {
      const previous = ctx.existing;
      if (!previous) return; // create cannot lock anyone out
      const next = ctx.newState as FirmMember;
      const wasActive = previous.spec?.active === true;
      const staysActive = next.spec?.active === true;

      if (
        ctx.caller?.kind === "user" &&
        previous.spec?.userId === ctx.caller.id &&
        wasActive &&
        !staysActive
      ) {
        throw permissionDenied("You cannot deactivate your own account");
      }

      const wasActingManagingPartner =
        wasActive && previous.spec?.role === FirmRole.MANAGING_PARTNER;
      const staysActingManagingPartner =
        staysActive && next.spec?.role === FirmRole.MANAGING_PARTNER;
      if (wasActingManagingPartner && !staysActingManagingPartner) {
        const { items } = await deps.store.list("FirmMember", {
          limit: 2,
          offset: 0,
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          filter: { role: "FIRM_ROLE_MANAGING_PARTNER", active: "true" },
        });
        const others = items.filter(
          (m) => (m as FirmMember).metadata?.id !== previous.metadata?.id,
        );
        if (others.length === 0) {
          throw failedPrecondition(
            "The firm must keep at least one active managing partner — " +
              "assign another managing partner before changing this one",
          );
        }
      }
    },
  };

  /** Role/active → engine tuple, in the SAME request (DD-003 D1a — the
   * event bus is best-effort and authorization facts must not ride it).
   * Contained: a sync failure logs and the reconcile heals it. */
  const syncTuples: PipelineStep<WriteContext<FirmMember>> = {
    name: "sync-authz-tuples",
    async execute(ctx) {
      await applyTupleDeltaSafely(
        deps.authz,
        firmMemberTupleDelta(ctx.existing, ctx.newState as FirmMember),
        `FirmMember ${(ctx.newState as FirmMember).metadata?.id ?? "(new)"}`,
      );
    },
  };

  return defineResource({
    definition: {
      kind: "FirmMember",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "fmem",
      schema: FirmMemberSchema,
      naturalKey: {
        label: "user id",
        get: (m) => m.spec?.userId ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
      // Names and emails come from the referenced User, one bulk lookup
      // per page (T04b D9) — never stored here, so an identity
      // correction on User can never leave a stale copy behind.
      deriveStatus: async (members: readonly FirmMember[]) => {
        const userIds = [
          ...new Set(members.map((m) => m.spec?.userId).filter((id): id is string => !!id)),
        ];
        const users = await deps.store.getByIds("User", userIds);
        for (const member of members) {
          const user = users.get(member.spec?.userId ?? "") as User | undefined;
          member.status = create(FirmMemberStatusSchema, {
            userName: user?.spec?.name ?? "",
            userEmail: user?.spec?.email ?? "",
          });
        }
      },
    },
    service: FirmMemberService,
    operations: {
      create: createOperation<FirmMember>({
        beforePersist: [activeDefaultStep, referenceChecks],
        afterPersist: [syncTuples],
      }),
      update: updateOperation<FirmMember>({
        beforePersist: [activeDefaultStep, lockoutGuards, referenceChecks],
        afterPersist: [syncTuples],
      }),
      get: getOperation<FirmMember, GetFirmMemberRequest>({
        ref: (req) => ({ id: req.id || undefined, naturalKey: req.userId || undefined }),
      }),
      list: listOperation<FirmMember, ListFirmMembersRequest, ListFirmMembersResponse>({
        // Joining order — stable and explainable. Seniority grouping is
        // presentation (the web app groups by role client-side over one
        // page); enum-name text ordering is an accident, not a rule.
        orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          // Active only unless the historical register is asked for.
          filter: req.includeInactive ? undefined : { active: "true" },
        }),
        respond: (items, totalCount) =>
          create(ListFirmMembersResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
    },
  });
}
