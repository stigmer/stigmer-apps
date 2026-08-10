/**
 * The FeeArrangement resource — the agreed-fee half of the money
 * aggregate (session-4 correction: its own partner-gated resource, so
 * case reads never need redaction). One per case: case_id is the
 * natural key; a second arrangement answers ALREADY_EXISTS by
 * construction. The policy grants every operation to partners only.
 */

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
  getOperation,
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  FeeArrangementSchema,
  FeeArrangementService,
  FeeKind,
  type FeeArrangement,
  type GetFeeArrangementRequest,
} from "../../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";

/** The kind names which amount field it carries; the others must stay
 * unset — a lump sum with a retainer amount is a data-entry accident
 * waiting to be misread at the money glance. */
const amountRules: PipelineStep<WriteContext<FeeArrangement>> = {
  name: "check-amount-matches-kind",
  execute(ctx) {
    const spec = (ctx.newState as FeeArrangement).spec;
    if (!spec) return;
    const set = {
      lump: spec.lumpSumPaise !== undefined,
      appearance: spec.perAppearancePaise !== undefined,
      retainer: spec.monthlyRetainerPaise !== undefined,
    };
    const expect = (lump: boolean, appearance: boolean, retainer: boolean) => {
      if (set.lump !== lump || set.appearance !== appearance || set.retainer !== retainer) {
        throw invalidArgument(
          "The amount fields must match the fee kind: lump sum carries " +
            "lump_sum_paise, per-appearance carries per_appearance_paise, " +
            "retainer carries monthly_retainer_paise, and not-set carries none",
        );
      }
    };
    switch (spec.feeKind) {
      case FeeKind.LUMP_SUM:
        return expect(true, false, false);
      case FeeKind.PER_APPEARANCE:
        return expect(false, true, false);
      case FeeKind.RETAINER:
        return expect(false, false, true);
      case FeeKind.NOT_SET:
        return expect(false, false, false);
      default:
        return; // buf.validate already refused UNSPECIFIED
    }
  },
};

export function feeArrangementResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<FeeArrangement>(deps.store, [
    { kind: "Case", label: "case", get: (f) => f.spec?.caseId || undefined },
  ]);

  return defineResource({
    definition: {
      kind: "FeeArrangement",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "fee",
      schema: FeeArrangementSchema,
      naturalKey: {
        label: "case",
        get: (f) => f.spec?.caseId ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: FeeArrangementService,
    operations: {
      create: createOperation<FeeArrangement>({
        beforePersist: [amountRules, referenceChecks],
      }),
      update: updateOperation<FeeArrangement>({
        beforePersist: [amountRules, referenceChecks],
      }),
      get: getOperation<FeeArrangement, GetFeeArrangementRequest>({
        ref: (req) => ({ naturalKey: req.caseId }),
      }),
    },
  });
}
