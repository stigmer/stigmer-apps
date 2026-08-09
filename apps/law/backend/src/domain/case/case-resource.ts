/**
 * The Case resource on the commons pipeline — the first real consumer and
 * the template every T03 resource follows: one declaration stating the
 * operation matrix (create/update/get/list; no delete — a decision, not an
 * omission), the natural key, the fixed list ordering, and the derived
 * status. Everything else (validation, authorization, duplicate checks,
 * envelope stamping, persistence, events, error contract) is the pipeline.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  createOperation,
  defineResource,
  getOperation,
  invalidArgument,
  listOperation,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  type Case,
  CaseSchema,
  CaseService,
  CaseStatusSchema,
  type GetCaseRequest,
  type ListCasesRequest,
  type ListCasesResponse,
  ListCasesResponseSchema,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../firm-clock.js";

export function caseResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  // T03 retrofit (D3): assigned_lawyer_id was mandatory but unvalidated
  // while no user table existed — it now must reference a real User.
  const referenceChecks = referencesExistStep<Case>(deps.store, [
    { kind: "User", label: "assigned lawyer", get: (c) => c.spec?.assignedLawyerId || undefined },
  ]);

  return defineResource({
    definition: {
      kind: "Case",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "case",
      schema: CaseSchema,
      naturalKey: {
        label: "case number",
        get: (c) => c.spec?.caseNumber ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
      // document_count is derived on read, never stored (FR-CASE-005 AC8).
      // Page-shaped (T03 D4): ONE grouped query per response — a 20-case
      // page costs one countBy, never twenty counts.
      deriveStatus: async (cases: readonly Case[]) => {
        const ids = cases
          .map((c) => c.metadata?.id)
          .filter((id): id is string => !!id);
        const counts = await deps.store.countBy("Document", "caseId", ids);
        for (const c of cases) {
          c.status = create(CaseStatusSchema, {
            documentCount: counts.get(c.metadata?.id ?? "") ?? 0,
          });
        }
      },
    },
    service: CaseService,
    operations: {
      create: createOperation<Case>({ beforePersist: [referenceChecks] }),
      update: updateOperation<Case>({ beforePersist: [referenceChecks] }),
      get: getOperation<Case, GetCaseRequest>({
        ref: (req) => ({
          id: req.id || undefined,
          naturalKey: req.caseNumber || undefined,
        }),
      }),
      list: listOperation<Case, ListCasesRequest, ListCasesResponse>({
        // The list contract (FR-CASE-002 AC4/AC5): soonest hearing first,
        // dateless cases last. Fixed server-side; not a client option.
        orderBy: { field: "nextHearingDate", direction: "asc", nulls: "last" },
        query: (req) => {
          if (req.hearingWithinDays > 0 && req.unscheduledOnly) {
            throw invalidArgument(
              "Case: hearing_within_days and unscheduled_only are mutually exclusive " +
                "(a case cannot be both inside a hearing window and unscheduled)",
            );
          }
          // The named predicates (T05), each implemented exactly once.
          // Hearing window: [today, today+N] inclusive, firm clock. A
          // range never matches a dateless case (port contract), and gte
          // excludes the past — "upcoming" means upcoming. Unscheduled:
          // the absent-variant, the one shape a range cannot express.
          const today = todayInFirmTimezone();
          return {
            pageSize: req.pageSize,
            pageOffset: req.pageOffset,
            filter: req.unscheduledOnly
              ? { nextHearingDate: { absent: true } }
              : req.hearingWithinDays > 0
                ? {
                    nextHearingDate: {
                      gte: today,
                      lte: addDaysToIsoDate(today, req.hearingWithinDays),
                    },
                  }
                : undefined,
          };
        },
        respond: (items, totalCount) =>
          create(ListCasesResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // No delete: FR-CASE-004 notes / Appendix C. The service declares no
      // such method, so this absence is enforced by the proto contract
      // itself.
    },
  });
}
