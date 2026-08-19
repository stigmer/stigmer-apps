/**
 * The Hearing resource — the diary's append-only heartbeat (DD-001).
 * Operation matrix: create (schedule), update (scheduled only),
 * recordOutcome (once, immutable), get, list — no delete, ever: the
 * diary does not get rewritten.
 *
 * recordOutcome performs the cycle's two writes SEQUENTIALLY (Gate-1
 * Q3): complete this hearing, then run the FULL create pipeline for the
 * next one when a next date is given. The store deliberately has no
 * cross-write transactions; both crash residues surface loudly through
 * the product's own views ("no next date" / the unrecorded-outcome nag)
 * and recover through Create.
 */

import { clone, create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  CallerPrincipal,
  FilterValue,
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
  getOperation,
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  HearingSchema,
  HearingService,
  HearingStatusSchema,
  OutcomeKind,
  type GetHearingRequest,
  type Hearing,
  type ListHearingsRequest,
  type ListHearingsResponse,
  ListHearingsResponseSchema,
  type RecordOutcomeRequest,
  type RecordOutcomeResponse,
  RecordOutcomeResponseSchema,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { firmDayUtcBounds, todayInFirmTimezone } from "../firm-clock.js";
import type { PolicyGuards } from "../authz/policy.js";

export function hearingResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<Hearing>(deps.store, [
    { kind: "Case", label: "case", get: (h) => h.spec?.caseId || undefined },
  ]);

  /** Create-input membership check (module header of policy.ts: the
   * authorize slot never sees create input). Clerks included — the
   * clerk records hearings. */
  const membershipOnWrite: PipelineStep<WriteContext<Hearing>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as Hearing).spec?.caseId;
      if (ctx.caller && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId);
      }
    },
  };

  /** A completed hearing's record is frozen — including its listing
   * details (FR-HEAR-006's freeze clause). */
  const scheduledOnly: PipelineStep<WriteContext<Hearing>> = {
    name: "refuse-completed-edit",
    execute(ctx) {
      const outcome = (ctx.existing as Hearing | undefined)?.status?.outcomeKind;
      if (outcome !== undefined && outcome !== OutcomeKind.UNSPECIFIED) {
        throw failedPrecondition(
          "This hearing's outcome is recorded — the appearance record is frozen",
        );
      }
    },
  };

  // Late-bound handle to the resource's own create pipeline (the
  // recordOutcome handler schedules the next hearing through it);
  // TypeScript cannot infer a type that references itself.
  const pipeline: {
    create?: (input: Hearing, caller: CallerPrincipal) => Promise<Hearing>;
  } = {};

  const resource = defineResource({
    definition: {
      kind: "Hearing",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "hear",
      schema: HearingSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: HearingService,
    operations: {
      create: createOperation<Hearing>({
        beforePersist: [membershipOnWrite, referenceChecks],
      }),
      update: updateOperation<Hearing>({
        beforePersist: [scheduledOnly, membershipOnWrite, referenceChecks],
      }),
      recordOutcome: customOperation<Hearing, RecordOutcomeRequest, RecordOutcomeResponse>({
        async handler(ctx) {
          // load() authorizes "recordOutcome": members (clerk included)
          // and partners.
          const hearing = await ctx.load({ id: ctx.input.id });
          const current = hearing.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED;
          if (current !== OutcomeKind.UNSPECIFIED) {
            throw failedPrecondition(
              "An outcome is already recorded for this hearing. To schedule the " +
                "next appearance, create a new hearing on the case",
            );
          }
          if (ctx.input.nextDate !== undefined && ctx.input.nextDate <= hearing.spec!.date) {
            throw invalidArgument("The next date must be after this hearing's date");
          }
          // Attendees must be real firm members — the same
          // FAILED_PRECONDITION contract the reference step gives specs.
          for (const attendee of ctx.input.attendedBy) {
            if (!(await deps.store.getById("FirmMember", attendee))) {
              throw failedPrecondition(`Referenced attendee '${attendee}' not found`);
            }
          }

          const previous = clone(HearingSchema, hearing);
          hearing.status = create(HearingStatusSchema, {
            outcomeKind: ctx.input.outcomeKind,
            outcomeNotes: ctx.input.outcomeNotes,
            attendedBy: ctx.input.attendedBy,
            nextDate: ctx.input.nextDate,
            // Stamped here, once — the write that freezes the record is
            // the write that timestamps it (FR-HEAR-007).
            recordedAt: timestampNow(),
          });
          const saved = await ctx.save(hearing);
          await ctx.publish("updated", saved, previous);

          // Write two of the cycle: the next scheduled hearing, through
          // the FULL create pipeline as the same caller. Not atomic with
          // the save above, deliberately (Gate-1 Q3) — a crash here
          // leaves the case surfacing "no next date", loud and
          // recoverable by direct Create.
          let nextHearing: Hearing | undefined;
          if (ctx.input.nextDate !== undefined && ctx.caller) {
            nextHearing = await pipeline.create!(
              create(HearingSchema, {
                spec: {
                  caseId: saved.spec?.caseId ?? "",
                  date: ctx.input.nextDate,
                  purpose: ctx.input.nextPurpose ?? "",
                },
              }),
              ctx.caller,
            );
          }

          return create(RecordOutcomeResponseSchema, {
            hearing: saved,
            nextHearing,
          });
        },
      }),
      get: getOperation<Hearing, GetHearingRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: customOperation<Hearing, ListHearingsRequest, ListHearingsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          let scope: Record<string, string | { in: string[] }> = {};
          if (ctx.input.caseId) {
            // The diary: one case, membership-gated.
            await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
            scope = { caseId: ctx.input.caseId };
          } else {
            // The day board / nag list: firm-wide for partners,
            // member-cases-only for everyone else (FR-HEAR-004).
            const member = await deps.guards.requireMember(ctx.caller);
            const visible = await deps.guards.visibleCaseIds(member);
            if (visible !== undefined) {
              scope = { caseId: { in: [...visible] } };
            }
          }

          const dateRange = {
            ...(ctx.input.dateFrom ? { gte: ctx.input.dateFrom } : {}),
            ...(ctx.input.dateTo ? { lte: ctx.input.dateTo } : {}),
          };

          // The predicate shapes are mutually exclusive by contract;
          // the day-feed shapes (FR-HEAR-007) read newest-first because
          // they answer "what just happened", not the board's
          // chronological order.
          const shape: {
            orderBy: NonNullable<Parameters<typeof deps.store.list>[1]["orderBy"]>;
            filter: Record<string, FilterValue>;
          } = ctx.input.recordedOn
            ? {
                orderBy: { field: "recordedAt", direction: "desc", nulls: "last" },
                filter: { recordedAt: firmDayUtcBounds(ctx.input.recordedOn) },
              }
            : ctx.input.scheduledOn
              ? {
                  orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
                  filter: { createdAt: firmDayUtcBounds(ctx.input.scheduledOn) },
                }
              : {
                  orderBy: { field: "date", direction: "asc", nulls: "last" },
                  filter: ctx.input.unrecordedOnly
                    ? {
                        outcomeKind: { absent: true },
                        date: { lt: todayInFirmTimezone() },
                      }
                    : Object.keys(dateRange).length > 0
                      ? { date: dateRange }
                      : {},
                };

          const { items, totalCount } = await deps.store.list("Hearing", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            orderBy: shape.orderBy,
            filter: { ...scope, ...shape.filter },
          });
          return create(ListHearingsResponseSchema, {
            items: items as Hearing[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
  });

  pipeline.create = resource.invoke.create;
  return resource;
}
