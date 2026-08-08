/**
 * The shared User resource on the commons pipeline (moved from the first
 * vertical at T04a — DD-005 D2: users and credentials are identity
 * concerns, defined once, consumed by every vertical).
 *
 * Operation matrix (first consumer's contract, adopted as the commons
 * default): create (operator-only by consumer policy), get, list,
 * setPassword (operator-only) — no update (profile read-only until a
 * vertical needs otherwise), no delete.
 *
 * Credentials never touch this resource: SetPassword bcrypts server-side
 * into the credential store (credential-store.ts). The consuming app's
 * policy module owns WHO may call what; this file only declares the
 * operations.
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
  listOperation,
} from "@stigmer/resource-api";
import type { CredentialStore } from "./credential-store.js";
import {
  type GetUserRequest,
  type ListUsersRequest,
  ListUsersResponseSchema,
  type SetPasswordRequest,
  SetPasswordResponseSchema,
  type User,
  UserSchema,
  UserService,
} from "./gen/stigmer/identity/user/v1/user_pb.js";
import { hashPassword } from "./password.js";
import type { RefreshTokenStore } from "./refresh-token.js";

export const USER_KIND = "User";
export const USER_API_VERSION = "identity.stigmer.ai/v1";

const normalizedEmail = (u: User): string => (u.spec?.email ?? "").trim().toLowerCase();

/**
 * Email is stored lowercase so the natural-key unique constraint and every
 * lookup agree by construction (casing is not the user's problem); name
 * defaults to the email local-part. Runs after build-new-state, so it
 * shapes exactly what gets persisted.
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

export interface UserResourceDeps {
  readonly store: ResourceStore;
  readonly policy: AuthorizationPolicy;
  readonly publisher?: ResourceEventPublisher;
  /** The app's caller seam — typically `createCallerResolver(...).fromConnect`. */
  readonly caller: CallerExtractor;
  readonly credentials: CredentialStore;
  /** Required so SetPassword can revoke sessions (DD-005 D9). */
  readonly refreshTokens: RefreshTokenStore;
}

export function userResource(deps: UserResourceDeps) {
  return defineResource({
    definition: {
      kind: USER_KIND,
      apiVersion: USER_API_VERSION,
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
      caller: deps.caller,
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
          const userId = user.metadata?.id as string;
          await deps.credentials.setPasswordHash(userId, await hashPassword(ctx.input.password));
          // DD-005 D9: with no user delete/disable in the contract, a
          // password reset is the offboarding lever — it must also kill
          // the sessions the old credential earned. The ≤1h access-token
          // tail is the accepted remainder.
          await deps.refreshTokens.revokeAllForUser(userId);
          return create(SetPasswordResponseSchema, {});
        },
      }),
      // No update: profile is read-only until a vertical needs otherwise —
      // the service declares no such method, so the contract enforces it.
    },
  });
}
