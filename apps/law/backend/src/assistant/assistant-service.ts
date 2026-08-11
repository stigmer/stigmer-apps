/**
 * The AssistantService implementation — GetConfig / MintToken (contract
 * and security rationale in proto/stigmer/law/assistant/v1).
 *
 * Identity-level by design, mounted beside AuthService: nothing here is
 * persisted and both RPCs are self-scoped by construction, so the
 * commons pipeline and the resource policy matrix are the wrong shape
 * for it. The one policy rule it DOES enforce is the liveness gate —
 * MintToken runs through the policy module's requireMember, so
 * deactivation closes the assistant the same instant it closes every
 * resource operation (FR-MEMBER-002's every-access-path revocation).
 *
 * Extraction seam: vertical #2 embedding the assistant will want this
 * service and its proto verbatim; it stays app-owned until that
 * consumer exists (the no-premature-extraction rule), because the
 * active-membership gate it composes is the app's.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import type { CallerExtractor, CallerPrincipal, ResourceStore } from "@stigmer/resource-api";
import { USER_KIND, type User } from "@stigmer/identity";
import type { AssistantConfig } from "../config.js";
import type { PolicyGuards } from "../domain/authz/policy.js";
import {
  AssistantService,
  GetAssistantConfigResponseSchema,
  MintAssistantTokenResponseSchema,
} from "../gen/stigmer/law/assistant/v1/assistant_pb.js";
import type { AssistantTokenMinter } from "./minter.js";

/** The configured integration: config + its minter, present together. */
export interface AssistantRuntime {
  readonly config: AssistantConfig;
  readonly minter: AssistantTokenMinter;
}

export interface AssistantServiceDeps {
  /** Absent = this deployment has no assistant (GetConfig says so). */
  readonly assistant?: AssistantRuntime;
  readonly store: ResourceStore;
  /** The app's caller seam — both RPCs require an authenticated user. */
  readonly caller: CallerExtractor;
  /** The policy module's liveness gate (one definition of "active member"). */
  readonly requireMember: PolicyGuards["requireMember"];
}

export function assistantService(deps: AssistantServiceDeps): {
  routes(router: ConnectRouter): void;
} {
  async function requireUserCaller(ctx: HandlerContext): Promise<CallerPrincipal> {
    const caller = await deps.caller(ctx);
    if (!caller) {
      throw new ConnectError("Authentication required", Code.Unauthenticated);
    }
    if (caller.kind !== "user") {
      // The operator key has no user row and no platform identity —
      // there is nobody to mint for (the WhoAmI rule).
      throw new ConnectError(
        `The ${caller.kind} credential has no user profile`,
        Code.NotFound,
      );
    }
    return caller;
  }

  return {
    routes(router) {
      router.service(AssistantService, {
        async getConfig(_req, ctx) {
          // Authenticated but deliberately NOT membership-gated: this
          // read has no side effects and grants nothing — MintToken is
          // the enforcement point, and keeping this one cheap means the
          // shell can ask on every load without a policy round trip.
          await requireUserCaller(ctx);
          if (!deps.assistant) {
            return create(GetAssistantConfigResponseSchema, { enabled: false });
          }
          const { config } = deps.assistant;
          return create(GetAssistantConfigResponseSchema, {
            enabled: true,
            apiBaseUrl: config.apiBaseUrl,
            org: config.org,
            agentInstanceId: config.agentInstanceId,
            consoleUrl: config.consoleUrl,
          });
        },

        async mintToken(_req, ctx) {
          const caller = await requireUserCaller(ctx);
          if (!deps.assistant) {
            throw new ConnectError(
              "The assistant is not configured for this deployment",
              Code.FailedPrecondition,
            );
          }
          // The liveness gate: refused when missing or deactivated,
          // with the policy's own sentence (PERMISSION_DENIED).
          await deps.requireMember(caller);

          const user = (await deps.store.getById(USER_KIND, caller.id)) as User | undefined;
          if (!user?.spec?.email) {
            throw new ConnectError(`User '${caller.id}' not found`, Code.NotFound);
          }

          try {
            const minted = await deps.assistant.minter({
              userId: caller.id,
              // Pipeline-normalized lowercase — the exact value the MCP
              // entrance's stigmer_user resolver will match against.
              userEmail: user.spec.email,
              userName: user.spec.name || undefined,
            });
            return create(MintAssistantTokenResponseSchema, {
              accessToken: minted.accessToken,
              expiresInSeconds: minted.expiresInSeconds,
            });
          } catch (err) {
            // Every mint failure is a platform/deployment problem, never
            // the caller's: credentials, origin policy, and reachability
            // are all server-side concerns whose details belong in the
            // log, not in a chat-adjacent error surface.
            console.error(`assistant token mint failed (user=${caller.id}):`, err);
            throw new ConnectError(
              "The assistant is unavailable right now — try again shortly",
              Code.Unavailable,
            );
          }
        },
      });
    },
  };
}
