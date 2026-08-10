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
  getOperation,
  listOperation,
  referencesExistStep,
  updateOperation,
} from "@stigmer/resource-api";
import type { User } from "@stigmer/identity";
import {
  FirmMemberSchema,
  FirmMemberService,
  FirmMemberStatusSchema,
  type FirmMember,
  type GetFirmMemberRequest,
  type ListFirmMembersRequest,
  type ListFirmMembersResponse,
  ListFirmMembersResponseSchema,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";

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
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  const referenceChecks = referencesExistStep<FirmMember>(deps.store, [
    { kind: "User", label: "user", get: (m) => m.spec?.userId || undefined },
  ]);

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
      }),
      update: updateOperation<FirmMember>({
        beforePersist: [activeDefaultStep, referenceChecks],
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
