/**
 * The Case resource — the matter (DD-001). Operation matrix: create,
 * update, updateStatus (lifecycle — the single write path), get, list —
 * no delete; closure is lifecycle.
 *
 * Two deliberate shapes carried from the Gate-1 analysis:
 *
 * - `status.next_hearing_date` is STORED-DERIVED (the app's one
 *   documented DD-A6 exception): the recompute step below is its ONLY
 *   writer, running on every case write — including the system refresh
 *   the hearing event handler triggers — so the fact recomputes from
 *   source and self-heals; nothing increments it.
 * - List answers CaseSummary, not Case (the list line IS what
 *   FR-AUTHZ-003 lets a non-member lawyer see), and is a custom
 *   operation because its scoping facts (a clerk's member cases) load
 *   asynchronously.
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
  alreadyExists,
  createOperation,
  customOperation,
  defineResource,
  getOperation,
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  CaseLifecycle,
  CaseSchema,
  CaseService,
  CaseStatusSchema,
  CaseSummarySchema,
  ForumKind,
  type Case,
  type GetCaseRequest,
  type ListCasesRequest,
  type ListCasesResponse,
  ListCasesResponseSchema,
  type UpdateCaseStatusRequest,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { AuthorizationEngine } from "@stigmer/authorization";
import type { Client } from "../../gen/stigmer/law/client/v1/client_pb.js";
import type { Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { addDaysToIsoDate, todayInFirmTimezone } from "../firm-clock.js";
import type { PolicyGuards } from "../authz/policy.js";
import { applyTupleDeltaSafely, caseTupleDelta } from "../authz/tuples.js";

/** Lifecycle enum names as the store's text rendering (proto3 JSON). */
const ACTIVE_TEXT = "CASE_LIFECYCLE_ACTIVE";

export interface CaseResourceDeps {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  authz: AuthorizationEngine;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}

/**
 * The single writer of status.next_hearing_date: the earliest FUTURE
 * scheduled hearing, recomputed from the Hearings table on every case
 * write. Runs after build-new-state (create cleared status; update
 * copied it), so it composes with lifecycle initialization/preservation
 * instead of fighting it.
 */
function recomputeNextHearingStep(store: ResourceStore): PipelineStep<WriteContext<Case>> {
  return {
    name: "recompute-next-hearing",
    async execute(ctx) {
      const state = ctx.newState as Case;
      const caseId = state.metadata?.id;
      if (!caseId) return;
      const { items } = await store.list("Hearing", {
        limit: 1,
        offset: 0,
        orderBy: { field: "date", direction: "asc", nulls: "last" },
        filter: {
          caseId,
          outcomeKind: { absent: true },
          date: { gte: todayInFirmTimezone() },
        },
      });
      const next = (items[0] as Hearing | undefined)?.spec?.date;
      state.status = create(CaseStatusSchema, {
        lifecycle: state.status?.lifecycle ?? CaseLifecycle.ACTIVE,
        nextHearingDate: next,
        // Derived-on-read fields stay off the stored row; deriveStatus
        // fills them per response.
      });
    },
  };
}

/**
 * Court numbers are unique WHEN PRESENT (FR-CASE-001) but are not the
 * natural key. This friendly pre-check answers ALREADY_EXISTS; the
 * partial unique index in the migration is the race backstop (its rare
 * concurrent violation surfaces as INTERNAL — a recorded acceptance).
 */
function courtNumberUniqueStep(store: ResourceStore): PipelineStep<WriteContext<Case>> {
  return {
    name: "check-court-number-unique",
    async execute(ctx) {
      const state = ctx.newState as Case;
      const courtNumber = state.spec?.courtCaseNumber;
      if (!courtNumber) return;
      const { items } = await store.list("Case", {
        limit: 1,
        offset: 0,
        filter: { courtCaseNumber: courtNumber },
      });
      const clash = items[0] as Case | undefined;
      if (clash && clash.metadata?.id !== state.metadata?.id) {
        throw alreadyExists("Case", "court case number", courtNumber);
      }
    },
  };
}

export function caseResource(deps: CaseResourceDeps) {
  const referenceChecks = referencesExistStep<Case>(deps.store, [
    { kind: "Client", label: "client", get: (c) => c.spec?.clientId || undefined },
    { kind: "FirmMember", label: "lead lawyer", get: (c) => c.spec?.leadLawyerId || undefined },
  ]);
  const recompute = recomputeNextHearingStep(deps.store);
  const courtNumberUnique = courtNumberUniqueStep(deps.store);

  /** Firm link + lead transition → engine tuples, in the SAME request
   * (DD-003 D1a). The system's next-hearing refresh rides update too —
   * its lead is unchanged, so the delta is a no-op there. */
  const syncTuples: PipelineStep<WriteContext<Case>> = {
    name: "sync-authz-tuples",
    async execute(ctx) {
      await applyTupleDeltaSafely(
        deps.authz,
        caseTupleDelta(deps.store, ctx.existing, ctx.newState as Case),
        `Case ${(ctx.newState as Case).metadata?.id ?? "(new)"}`,
      );
    },
  };

  /** The membership case-id set for the `mine` predicate (lead included
   * by construction: leads are materialized as members). */
  async function membershipCaseIds(memberId: string): Promise<string[]> {
    const memberships = await deps.store.list("CaseMember", {
      limit: 100,
      offset: 0,
      orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
      filter: { memberId, active: "true" },
    });
    return memberships.items.map(
      (m) => (m as { spec?: { caseId?: string } }).spec?.caseId ?? "",
    );
  }

  async function buildSummaries(cases: readonly Case[]) {
    const clientIds = [
      ...new Set(cases.map((c) => c.spec?.clientId).filter((id): id is string => !!id)),
    ];
    const clients = await deps.store.getByIds("Client", clientIds);
    return cases.map((c) => {
      const clientName =
        (clients.get(c.spec?.clientId ?? "") as Client | undefined)?.spec?.displayName ?? "";
      const firstParty = c.spec?.opposingParties[0]?.name;
      return create(CaseSummarySchema, {
        id: c.metadata?.id ?? "",
        fileNumber: c.spec?.fileNumber ?? "",
        caption: firstParty ? `${clientName} vs ${firstParty}` : clientName,
        forumKind: c.spec?.forum?.forumKind ?? ForumKind.UNSPECIFIED,
        forumName: c.spec?.forum?.name ?? "",
        nextHearingDate: c.status?.nextHearingDate,
        lifecycle: c.status?.lifecycle ?? CaseLifecycle.UNSPECIFIED,
      });
    });
  }

  return defineResource({
    definition: {
      kind: "Case",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "case",
      schema: CaseSchema,
      naturalKey: {
        label: "file number",
        get: (c) => c.spec?.fileNumber ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
      // Page-shaped derived counts (T03 D4): documents per case, OPEN
      // deadlines per case (the filtered-count seam) — computed on
      // read, never stored.
      deriveStatus: async (cases: readonly Case[]) => {
        const ids = cases
          .map((c) => c.metadata?.id)
          .filter((id): id is string => !!id);
        const [documentCounts, openDeadlineCounts] = await Promise.all([
          deps.store.countBy("Document", "caseId", ids),
          deps.store.countBy("Deadline", "caseId", ids, {
            state: "DEADLINE_STATE_OPEN",
          }),
        ]);
        for (const c of cases) {
          const id = c.metadata?.id ?? "";
          c.status = create(CaseStatusSchema, {
            lifecycle: c.status?.lifecycle ?? CaseLifecycle.UNSPECIFIED,
            nextHearingDate: c.status?.nextHearingDate,
            documentCount: documentCounts.get(id) ?? 0,
            openDeadlineCount: openDeadlineCounts.get(id) ?? 0,
          });
        }
      },
    },
    service: CaseService,
    operations: {
      create: createOperation<Case>({
        beforePersist: [recompute, courtNumberUnique, referenceChecks],
        afterPersist: [syncTuples],
      }),
      update: updateOperation<Case>({
        beforePersist: [recompute, courtNumberUnique, referenceChecks],
        afterPersist: [syncTuples],
      }),
      updateStatus: customOperation<Case, UpdateCaseStatusRequest, Case>({
        async handler(ctx) {
          // load() authorizes "updateStatus" — partners or the lead.
          const theCase = await ctx.load({ id: ctx.input.id });
          const previous = clone(CaseSchema, theCase);
          theCase.status = create(CaseStatusSchema, {
            lifecycle: ctx.input.lifecycle,
            nextHearingDate: theCase.status?.nextHearingDate,
          });
          const saved = await ctx.save(theCase);
          await ctx.publish("updated", saved, previous);
          return saved;
        },
      }),
      get: getOperation<Case, GetCaseRequest>({
        ref: (req) => ({ id: req.id || undefined, naturalKey: req.fileNumber || undefined }),
      }),
      // Custom rather than the list flavor: the scoping facts (a
      // non-partner's member cases) load asynchronously, and the
      // response is summary-shaped (Gate-1 Q2).
      list: customOperation<Case, ListCasesRequest, ListCasesResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            // authorize() above already refused; this narrows the type.
            throw invalidArgument("caller required");
          }
          if (ctx.input.hearingWithinDays > 0 && ctx.input.noNextDate) {
            throw invalidArgument(
              "hearing_within_days and no_next_date cannot be combined: a case " +
                "cannot both have a hearing inside a window and have no next date",
            );
          }
          const member = await deps.guards.requireMember(ctx.caller);

          // The summary list is the LIST LINE (FR-AUTHZ-003): lawyer
          // roles see it firm-wide — existence without content — while
          // clerks see only the cases they work (their non-member
          // visibility is none, not a list line). The scope rule lives
          // in the policy guard (engine-backed); `mine` is a preference
          // predicate over the same membership rows. Intersected when
          // both apply; an empty intersection matches nothing — never a
          // silent widening.
          const idSets: string[][] = [];
          const listScope = await deps.guards.caseListScope(member);
          if (listScope !== undefined) {
            idSets.push([...listScope]);
          }
          if (ctx.input.mine) idSets.push(await membershipCaseIds(member.metadata?.id ?? ""));
          const scoped =
            idSets.length === 0
              ? undefined
              : idSets.reduce((a, b) => a.filter((id) => b.includes(id)));

          const today = todayInFirmTimezone();
          const { items, totalCount } = await deps.store.list("Case", {
            limit:
              ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            orderBy: { field: "nextHearingDate", direction: "asc", nulls: "last" },
            filter: {
              ...(scoped !== undefined ? { id: { in: scoped } } : {}),
              ...(ctx.input.hearingWithinDays > 0
                ? {
                    nextHearingDate: {
                      gte: today,
                      lte: addDaysToIsoDate(today, ctx.input.hearingWithinDays),
                    },
                  }
                : {}),
              ...(ctx.input.noNextDate ? { nextHearingDate: { absent: true } } : {}),
              ...(ctx.input.clientId ? { clientId: ctx.input.clientId } : {}),
              ...(ctx.input.forumKind !== ForumKind.UNSPECIFIED
                ? { forumKind: enumText(ctx.input.forumKind) }
                : {}),
              // Working default: active matters; the archive is asked
              // for by name.
              lifecycle:
                ctx.input.lifecycle !== CaseLifecycle.UNSPECIFIED
                  ? lifecycleText(ctx.input.lifecycle)
                  : ACTIVE_TEXT,
            },
          });

          return create(ListCasesResponseSchema, {
            items: await buildSummaries(items as Case[]),
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
  });
}

/** proto3-JSON enum name for ForumKind — what the generated column stores. */
function enumText(kind: ForumKind): string {
  return `FORUM_KIND_${ForumKind[kind]}`;
}

function lifecycleText(lifecycle: CaseLifecycle): string {
  return `CASE_LIFECYCLE_${CaseLifecycle[lifecycle]}`;
}
