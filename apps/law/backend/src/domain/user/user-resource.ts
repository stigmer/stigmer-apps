/**
 * The User resource on the commons pipeline. Operation matrix (DD-001,
 * amended by T03 D7): create (operator-only), get, list, setPassword
 * (operator-only) — no update (profile read-only in MVP), no delete.
 *
 * Credentials never touch this resource: SetPassword bcrypts server-side
 * into the app-owned credential store (see credentials.ts). The policy
 * module owns WHO may call what; this file only declares the operations.
 */

import bcrypt from "bcryptjs";
import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
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
  listOperation,
} from "@stigmer/resource-api";
import { callerFromRequest } from "../../auth/caller.js";
import {
  type GetUserRequest,
  type ListUsersRequest,
  ListUsersResponseSchema,
  type SetPasswordRequest,
  SetPasswordResponseSchema,
  type User,
  UserSchema,
  UserService,
} from "../../gen/stigmer/law/user/v1/user_pb.js";
import type { CredentialStore } from "./credentials.js";

/**
 * bcrypt cost factor: 10 is the bcryptjs default recommendation — ~100ms
 * per hash on current hardware, strong enough for a 15-user firm and fast
 * enough that operator provisioning and T04 login stay interactive.
 */
const BCRYPT_ROUNDS = 10;

const normalizedEmail = (u: User): string => (u.spec?.email ?? "").trim().toLowerCase();

/**
 * Email is stored lowercase so the natural-key unique constraint and every
 * lookup agree by construction (casing is not the user's problem); name
 * defaults to the email local-part (record model). Runs after
 * build-new-state, so it shapes exactly what gets persisted.
 */
const normalizeUserStep: PipelineStep<WriteContext<User>> = {
  name: "normalize-user",
  execute(ctx) {
    const state = ctx.newState as User;
    if (!state.spec) return;
    state.spec.email = normalizedEmail(state);
    if (!state.spec.name) {
      state.spec.name = state.spec.email.split("@")[0] ?? state.spec.email;
    }
  },
};

export function userResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  credentials: CredentialStore;
}) {
  return defineResource({
    definition: {
      kind: "User",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "user",
      schema: UserSchema,
      naturalKey: {
        label: "email",
        // Normalized here too, so the duplicate pre-check catches a
        // re-cased email before the database constraint has to.
        get: normalizedEmail,
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: callerFromRequest,
    },
    service: UserService,
    operations: {
      create: createOperation<User>({ beforePersist: [normalizeUserStep] }),
      get: getOperation<User, GetUserRequest>({
        ref: (req) => ({
          id: req.id || undefined,
          naturalKey: req.email ? req.email.trim().toLowerCase() : undefined,
        }),
      }),
      list: listOperation<User, ListUsersRequest, unknown>({
        orderBy: { field: "email", direction: "asc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
        }),
        respond: (items, totalCount) =>
          create(ListUsersResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      setPassword: customOperation<User, SetPasswordRequest, unknown>({
        async handler(ctx) {
          // load() authorizes "setPassword" against the policy
          // (operator-only) and answers NOT_FOUND naming the reference.
          const user = await ctx.load({
            id: ctx.input.id || undefined,
            naturalKey: ctx.input.email ? ctx.input.email.trim().toLowerCase() : undefined,
          });
          const hash = await bcrypt.hash(ctx.input.password, BCRYPT_ROUNDS);
          await deps.credentials.setPasswordHash(user.metadata?.id as string, hash);
          return create(SetPasswordResponseSchema, {});
        },
      }),
      // No update: profile is read-only in MVP (FR-USER-001 notes) — the
      // service declares no such method, so the contract enforces it.
    },
  });
}
