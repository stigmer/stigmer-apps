/**
 * The LedgerEntry resource — the moved-money half of the money
 * aggregate. APPEND-ONLY (FR-MONEY-002): create + list + the derived
 * outstanding view; corrections are contra entries. Amounts are integer
 * paise; balances derive through the store's sumBy in one grouped round
 * trip per page (Gate-1 Q7) — never stored, so they can never drift.
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
  invalidArgument,
  listOperation,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseOutstandingSchema,
  LedgerEntrySchema,
  LedgerEntryService,
  type LedgerEntry,
  type ListLedgerEntriesRequest,
  type ListLedgerEntriesResponse,
  ListLedgerEntriesResponseSchema,
  type ListOutstandingRequest,
  type ListOutstandingResponse,
  ListOutstandingResponseSchema,
} from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

/** Stored enum-name renderings — what the entry_kind column holds. */
const CHARGE = "LEDGER_ENTRY_KIND_CHARGE";
const RECEIPT = "LEDGER_ENTRY_KIND_RECEIPT";
const EXPENSE = "LEDGER_ENTRY_KIND_EXPENSE";

export function ledgerEntryResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<LedgerEntry>(deps.store, [
    { kind: "Case", label: "case", get: (e) => e.spec?.caseId || undefined },
  ]);

  /** The receipts-only rule for office staff (FR-AUTHZ-004) — the
   * create-input check the authorize slot cannot make; the rule itself
   * lives in the policy module's guard. */
  const ledgerCreateRule: PipelineStep<WriteContext<LedgerEntry>> = {
    name: "assert-ledger-create",
    async execute(ctx) {
      const spec = (ctx.newState as LedgerEntry).spec;
      if (ctx.caller && spec) {
        await deps.guards.assertLedgerCreate(ctx.caller, spec.entryKind);
      }
    },
  };

  return defineResource({
    definition: {
      kind: "LedgerEntry",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "ledg",
      schema: LedgerEntrySchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: LedgerEntryService,
    operations: {
      create: createOperation<LedgerEntry>({
        beforePersist: [ledgerCreateRule, referenceChecks],
      }),
      list: listOperation<LedgerEntry, ListLedgerEntriesRequest, ListLedgerEntriesResponse>({
        // How a partner reads a ledger: newest value date first.
        orderBy: { field: "date", direction: "desc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: { caseId: req.caseId },
        }),
        respond: (items, totalCount) =>
          create(ListLedgerEntriesResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      listOutstanding: customOperation<
        LedgerEntry,
        ListOutstandingRequest,
        ListOutstandingResponse
      >({
        async handler(ctx) {
          await ctx.authorize(); // partners only (the policy's money rule)
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          // Page over the matters, then ONE grouped sum per entry kind
          // for exactly that page — the countBy shape applied to money.
          const { items: cases, totalCount } = await deps.store.list("Case", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
            filter: ctx.input.clientId ? { clientId: ctx.input.clientId } : {},
          });
          const caseIds = cases
            .map((c) => c.metadata?.id)
            .filter((id): id is string => !!id);

          const [charges, receipts, expenses] = await Promise.all([
            deps.store.sumBy("LedgerEntry", "caseId", "amountPaise", caseIds, {
              entryKind: CHARGE,
            }),
            deps.store.sumBy("LedgerEntry", "caseId", "amountPaise", caseIds, {
              entryKind: RECEIPT,
            }),
            deps.store.sumBy("LedgerEntry", "caseId", "amountPaise", caseIds, {
              entryKind: EXPENSE,
            }),
          ]);

          const lines = (cases as Case[]).map((c) => {
            const id = c.metadata?.id ?? "";
            const charge = charges.get(id) ?? 0;
            const receipt = receipts.get(id) ?? 0;
            const expense = expenses.get(id) ?? 0;
            return create(CaseOutstandingSchema, {
              caseId: id,
              fileNumber: c.spec?.fileNumber ?? "",
              clientId: c.spec?.clientId ?? "",
              chargesPaise: BigInt(charge),
              receiptsPaise: BigInt(receipt),
              expensesPaise: BigInt(expense),
              outstandingPaise: BigInt(charge + expense - receipt),
            });
          });
          // Within the page, the biggest number first (the contract's
          // documented page-local ordering).
          lines.sort((a, b) => Number(b.outstandingPaise - a.outstandingPaise));

          return create(ListOutstandingResponseSchema, {
            items: lines,
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
  });
}
