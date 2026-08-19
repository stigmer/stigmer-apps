/**
 * The CaseAct resource (FR-ACT-001) — the matter's statutory frame on
 * the commons pipeline. Operation matrix: create, update (the
 * corrections model — a wrong entry is edited, never deleted; owner
 * decision session 27), get, list. Facts only: nothing here computes a
 * legal consequence from an act (FR-DEAD-003's boundary extended).
 *
 * Entry audience is the DIARY precedent, not the deadline one: case
 * members including clerks, plus partners (owner decision session 27 —
 * the frame is registry data entry, the clerk's documented work).
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
  customOperation,
  defineResource,
  getOperation,
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  type CaseAct,
  CaseActSchema,
  CaseActService,
  type GetCaseActRequest,
  type ListCaseActsRequest,
  type ListCaseActsResponse,
  ListCaseActsResponseSchema,
} from "../../gen/stigmer/law/caseact/v1/caseact_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

export function caseActResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<CaseAct>(deps.store, [
    { kind: "Case", label: "case", get: (a) => a.spec?.caseId || undefined },
  ]);

  /** Create-input membership (policy.ts module header: the authorize
   * slot never sees create input). Clerks included — the frame is
   * registry entry, the diary precedent. */
  const membershipOnWrite: PipelineStep<WriteContext<CaseAct>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as CaseAct).spec?.caseId;
      if (ctx.caller && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId);
      }
    },
  };

  return defineResource({
    definition: {
      kind: "CaseAct",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cact",
      schema: CaseActSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: CaseActService,
    operations: {
      create: createOperation<CaseAct>({
        beforePersist: [membershipOnWrite, referenceChecks],
      }),
      update: updateOperation<CaseAct>({
        beforePersist: [membershipOnWrite, referenceChecks],
      }),
      get: getOperation<CaseAct, GetCaseActRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: customOperation<CaseAct, ListCaseActsRequest, ListCaseActsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          // The frame is case content — membership-gated like the diary.
          await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);

          const { items, totalCount } = await deps.store.list("CaseAct", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // A register, not a diary: sorted by act name (contract).
            orderBy: { field: "act", direction: "asc", nulls: "last" },
            filter: { caseId: ctx.input.caseId },
          });
          return create(ListCaseActsResponseSchema, {
            items: items as CaseAct[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No delete: corrections are updates (module header).
    },
  });
}
