/**
 * The Deadline resource — lawyer-entered, relentlessly surfaced
 * (DD-001). Operation matrix: create, update, updateStatus (explicit
 * human transitions — `missed` is never set by the system), get, list.
 * No computed limitation dates anywhere (FR-DEAD-003).
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
  getOperation,
  invalidArgument,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import {
  DeadlineSchema,
  DeadlineService,
  DeadlineState,
  DeadlineStatusSchema,
  type Deadline,
  type GetDeadlineRequest,
  type ListDeadlinesRequest,
  type ListDeadlinesResponse,
  ListDeadlinesResponseSchema,
  type UpdateDeadlineStatusRequest,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { todayInFirmTimezone } from "../firm-clock.js";
import type { PolicyGuards } from "../authz/policy.js";

const OPEN_TEXT = "DEADLINE_STATE_OPEN";

/** The one overdue rule: due date passed, still open. The list filter
 * and the derivation below both read it — they cannot disagree. */
export function isDeadlineOverdue(
  dueDate: string | undefined,
  state: DeadlineState,
  today: string,
): boolean {
  return !!dueDate && dueDate < today && state === DeadlineState.OPEN;
}

export function deadlineResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<Deadline>(deps.store, [
    { kind: "Case", label: "case", get: (d) => d.spec?.caseId || undefined },
    { kind: "FirmMember", label: "owner", get: (d) => d.spec?.ownerId || undefined },
  ]);

  // Named because the CUSTOM list below must apply it itself (custom
  // operations bypass the automatic derivation).
  const deriveDeadlineStatus = async (deadlines: readonly Deadline[]) => {
    const today = todayInFirmTimezone();
    for (const deadline of deadlines) {
      const state = deadline.status?.state ?? DeadlineState.UNSPECIFIED;
      deadline.status = create(DeadlineStatusSchema, {
        state,
        overdue: isDeadlineOverdue(deadline.spec?.dueDate, state, today),
      });
    }
  };

  /** Deadlines are entered by lawyers ON THEIR CASES (clerks see, never
   * enter — the matrix); the create-input twin of the loaded-resource
   * rule. */
  const lawyerMembershipOnWrite: PipelineStep<WriteContext<Deadline>> = {
    name: "assert-lawyer-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as Deadline).spec?.caseId;
      if (ctx.caller && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId, { clerkAllowed: false });
      }
    },
  };

  const openOnCreateStep: PipelineStep<WriteContext<Deadline>> = {
    name: "initialize-status",
    execute(ctx) {
      (ctx.newState as Deadline).status = create(DeadlineStatusSchema, {
        state: DeadlineState.OPEN,
      });
    },
  };

  return defineResource({
    definition: {
      kind: "Deadline",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "dead",
      schema: DeadlineSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
      deriveStatus: deriveDeadlineStatus,
    },
    service: DeadlineService,
    operations: {
      create: createOperation<Deadline>({
        beforePersist: [openOnCreateStep, lawyerMembershipOnWrite, referenceChecks],
      }),
      update: updateOperation<Deadline>({
        beforePersist: [referenceChecks],
      }),
      updateStatus: customOperation<Deadline, UpdateDeadlineStatusRequest, Deadline>({
        async handler(ctx) {
          // load() authorizes "updateStatus": the owner or a partner.
          const deadline = await ctx.load({ id: ctx.input.id });
          const previous = clone(DeadlineSchema, deadline);
          deadline.status = create(DeadlineStatusSchema, {
            state: ctx.input.state,
            overdue: false, // derived on read; never persisted as truth
          });
          const saved = await ctx.save(deadline);
          await ctx.publish("updated", saved, previous);
          return saved;
        },
      }),
      get: getOperation<Deadline, GetDeadlineRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: customOperation<Deadline, ListDeadlinesRequest, ListDeadlinesResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          let scope: Record<string, string | { in: string[] }> = {};
          if (ctx.input.caseId) {
            await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
            scope = { caseId: ctx.input.caseId };
          } else {
            const member = await deps.guards.requireMember(ctx.caller);
            if (ctx.input.mine) {
              scope = { ownerId: member.metadata?.id ?? "" };
            } else {
              const visible = await deps.guards.visibleCaseIds(member);
              if (visible !== undefined) {
                scope = { caseId: { in: [...visible] } };
              }
            }
          }

          const dueRange = {
            ...(ctx.input.dueFrom ? { gte: ctx.input.dueFrom } : {}),
            ...(ctx.input.dueTo ? { lte: ctx.input.dueTo } : {}),
          };

          const { items, totalCount } = await deps.store.list("Deadline", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            orderBy: { field: "dueDate", direction: "asc", nulls: "last" },
            filter: {
              ...scope,
              ...(ctx.input.openOnly ? { state: OPEN_TEXT } : {}),
              ...(Object.keys(dueRange).length > 0 ? { dueDate: dueRange } : {}),
            },
          });
          const deadlines = items as Deadline[];
          await deriveDeadlineStatus(deadlines);
          return create(ListDeadlinesResponseSchema, {
            items: deadlines,
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
  });
}
