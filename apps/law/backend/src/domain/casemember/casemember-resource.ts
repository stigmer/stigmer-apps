/**
 * The CaseMember resource — the membership fact the policy consults
 * (DD-001). Operation matrix: create (add), remove (close the period),
 * list (case-scoped).
 *
 * A membership is a PERIOD, not a mutable flag: Remove sets
 * status.active=false and the row stays as history; re-adding someone
 * opens a NEW row. The natural key `{caseId}:{memberId}` exists only
 * while ACTIVE (the generated column goes NULL on removal), so a
 * duplicate active membership is impossible by construction while the
 * historical record accumulates freely — and Create stays the plain
 * pipeline operation, no special cases.
 */

import { clone, create } from "@bufbuild/protobuf";
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
  customOperation,
  defineResource,
  failedPrecondition,
  invalidArgument,
  referencesExistStep,
} from "@stigmer/resource-api";
import {
  CaseMemberSchema,
  CaseMemberService,
  CaseMemberStatusSchema,
  type CaseMember,
  type ListCaseMembersRequest,
  type ListCaseMembersResponse,
  ListCaseMembersResponseSchema,
  type RemoveCaseMemberRequest,
} from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import type { AuthorizationEngine } from "@stigmer/authorization";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { PolicyGuards } from "../authz/policy.js";
import { applyTupleDeltaSafely, caseMemberTupleDelta } from "../authz/tuples.js";

export function membershipKey(caseId: string, memberId: string): string {
  return `${caseId}:${memberId}`;
}

/** Every membership period opens active (explicit presence — the stored
 * JSON must carry the value so the store can filter and key on it). */
const activeOnCreateStep: PipelineStep<WriteContext<CaseMember>> = {
  name: "initialize-status",
  execute(ctx) {
    (ctx.newState as CaseMember).status = create(CaseMemberStatusSchema, { active: true });
  },
};

export function caseMemberResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  authz: AuthorizationEngine;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<CaseMember>(deps.store, [
    { kind: "Case", label: "case", get: (m) => m.spec?.caseId || undefined },
    { kind: "FirmMember", label: "member", get: (m) => m.spec?.memberId || undefined },
  ]);

  /** Membership → engine tuple, in the SAME request (DD-003 D1a). */
  const syncTuplesOnCreate: PipelineStep<WriteContext<CaseMember>> = {
    name: "sync-authz-tuples",
    async execute(ctx) {
      await applyTupleDeltaSafely(
        deps.authz,
        caseMemberTupleDelta(deps.store, undefined, ctx.newState as CaseMember),
        `CaseMember ${(ctx.newState as CaseMember).metadata?.id ?? "(new)"}`,
      );
    },
  };

  /** Partner-or-lead (FR-CASE-003) — the create-input twin of the
   * remove rule the authorize slot applies to loaded resources. Skipped
   * for the system principal: lead materialization IS the invariant. */
  const manageMembersOnCreate: PipelineStep<WriteContext<CaseMember>> = {
    name: "assert-manage-members",
    async execute(ctx) {
      const caseId = (ctx.newState as CaseMember).spec?.caseId;
      if (ctx.caller && ctx.caller.kind === "user" && caseId) {
        await deps.guards.assertManageMembers(ctx.caller, caseId);
      }
    },
  };

  return defineResource({
    definition: {
      kind: "CaseMember",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cmem",
      schema: CaseMemberSchema,
      naturalKey: {
        label: "membership",
        // The composed key from the spec; the ADAPTERS scope it to
        // ACTIVE periods (the conditional generated column in the
        // migration), so the friendly pre-check here finds only a live
        // membership and a removed one never blocks a new period.
        get: (m) => (m.spec ? membershipKey(m.spec.caseId, m.spec.memberId) : ""),
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: CaseMemberService,
    operations: {
      create: createOperation<CaseMember>({
        // Status initializes FIRST so the duplicate backstop keys on the
        // active form the row will actually persist with.
        beforePersist: [activeOnCreateStep, manageMembersOnCreate, referenceChecks],
        afterPersist: [syncTuplesOnCreate],
      }),
      remove: customOperation<CaseMember, RemoveCaseMemberRequest, CaseMember>({
        async handler(ctx) {
          // load() authorizes "remove": partners or the case's lead.
          const membership = await ctx.load({ id: ctx.input.id });
          if (membership.status?.active !== true) {
            throw failedPrecondition("This membership is already removed");
          }
          // The lead's membership is load-bearing (it IS how "mine" and
          // the policy see the lead): change the lead first, then remove.
          const theCase = (await deps.store.getById(
            "Case",
            membership.spec?.caseId ?? "",
          )) as Case | undefined;
          if (theCase?.spec?.leadLawyerId === membership.spec?.memberId) {
            throw failedPrecondition(
              "This person is the matter's lead lawyer — assign a new lead before removing them",
            );
          }
          const previous = clone(CaseMemberSchema, membership);
          membership.status = create(CaseMemberStatusSchema, { active: false });
          const saved = await ctx.save(membership);
          // Same-request tuple revocation (DD-003 D1a) — before publish,
          // mirroring the pipeline operations' afterPersist slot.
          await applyTupleDeltaSafely(
            deps.authz,
            caseMemberTupleDelta(deps.store, previous, saved),
            `CaseMember ${saved.metadata?.id ?? ""} remove`,
          );
          await ctx.publish("updated", saved, previous);
          return saved;
        },
      }),
      list: customOperation<CaseMember, ListCaseMembersRequest, ListCaseMembersResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate; membership below
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          // Member sets are case content — the guard carries the
          // membership check the scope-level authorize cannot.
          await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
          const { items, totalCount } = await deps.store.list("CaseMember", {
            // A member set is one working team, not a paged register —
            // the port's max page is a deliberate ceiling, not a page.
            limit: 100,
            offset: 0,
            orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
            filter: {
              caseId: ctx.input.caseId,
              ...(ctx.input.includeRemoved ? {} : { active: "true" }),
            },
          });
          return create(ListCaseMembersResponseSchema, {
            items: items as CaseMember[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
  });
}
