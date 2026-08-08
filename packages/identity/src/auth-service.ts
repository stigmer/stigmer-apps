/**
 * The AuthService implementation — Login / Refresh / Logout / WhoAmI
 * (contract and security rationale in proto/stigmer/identity/auth/v1).
 *
 * Identity-level by design: Login is necessarily pre-authentication (the
 * caller has no principal yet), and WhoAmI is self-scoped by construction
 * (it can only return the caller's own record) — so the consuming app's
 * policy module governs the User RESOURCE, while this surface answers
 * only "prove who you are" and "who am I".
 *
 * The refresh token rides an httpOnly cookie path-scoped to this service
 * (DD-005 D5): page script cannot read it, and the browser only attaches
 * it to auth RPCs. The access token is body-only and lives in the web
 * app's memory.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import type { CallerExtractor, ResourceStore } from "@stigmer/resource-api";
import type { CredentialStore } from "./credential-store.js";
import {
  AuthService,
  LoginResponseSchema,
  LogoutResponseSchema,
  RefreshResponseSchema,
  type LoginRequest,
} from "./gen/stigmer/identity/auth/v1/auth_pb.js";
import type { User } from "./gen/stigmer/identity/user/v1/user_pb.js";
import { verifyPassword } from "./password.js";
import { createMemoryRateLimiter, type LoginRateLimiter } from "./rate-limit.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  type RefreshTokenStore,
} from "./refresh-token.js";
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from "./token.js";
import { USER_KIND } from "./user-resource.js";

/**
 * The one clerk-facing credential failure (DD-005's recorded exception to
 * the errors-name-the-value rule): wrong email and wrong password answer
 * identically, so a failed attempt teaches an attacker nothing.
 */
const UNIFORM_LOGIN_FAILURE = "Email or password is incorrect";

const REFRESH_COOKIE = "stigmer_refresh";

export interface AuthServiceDeps {
  /** The app's composed store — User lookups resolve through it. */
  readonly store: ResourceStore;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  readonly issuer: AccessTokenIssuer;
  /** The app's caller seam (WhoAmI needs the authenticated principal). */
  readonly caller: CallerExtractor;
  /** Defaults to the in-memory limiter (see rate-limit.ts for why). */
  readonly rateLimiter?: LoginRateLimiter;
}

export function authService(deps: AuthServiceDeps): {
  routes(router: ConnectRouter): void;
} {
  const rateLimiter = deps.rateLimiter ?? createMemoryRateLimiter();
  // Path-scoping ties the cookie to exactly this service's RPCs.
  const cookiePath = `/${AuthService.typeName}/`;

  async function issueSession(user: User, ctx: HandlerContext) {
    const userId = user.metadata?.id as string;
    const accessToken = await deps.issuer.issue(userId);
    const refresh = generateRefreshToken();
    await deps.refreshTokens.insert(
      userId,
      refresh.sha256Hex,
      new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    );
    setRefreshCookie(ctx, refresh.token, cookiePath);
    return accessToken;
  }

  return {
    routes(router) {
      router.service(AuthService, {
        async login(req: LoginRequest, ctx) {
          const email = req.email.trim().toLowerCase();
          if (!email || !req.password) {
            throw new ConnectError("Email and password are required", Code.InvalidArgument);
          }

          const budget = rateLimiter.check(email);
          if (!budget.allowed) {
            const minutes = Math.max(1, Math.ceil((budget.retryAfterSeconds ?? 60) / 60));
            throw new ConnectError(
              `Too many sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
              Code.ResourceExhausted,
            );
          }

          const user = (await deps.store.getByNaturalKey(USER_KIND, email)) as User | undefined;
          // A user without a set password cannot sign in — same uniform
          // answer: which half failed is nobody's business.
          const hash = user
            ? await deps.credentials.getPasswordHash(user.metadata?.id as string)
            : undefined;
          if (!user || !hash || !(await verifyPassword(req.password, hash))) {
            rateLimiter.recordFailure(email);
            throw new ConnectError(UNIFORM_LOGIN_FAILURE, Code.Unauthenticated);
          }

          rateLimiter.recordSuccess(email);
          const accessToken = await issueSession(user, ctx);
          return create(LoginResponseSchema, {
            accessToken,
            expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
            user,
          });
        },

        async refresh(_req, ctx) {
          const presented = refreshCookie(ctx);
          if (!presented) {
            throw new ConnectError("No active session — sign in", Code.Unauthenticated);
          }

          const result = await deps.refreshTokens.consume(hashRefreshToken(presented));
          if (result.outcome !== "ok") {
            clearRefreshCookie(ctx, cookiePath);
            // "reused" already revoked every session (the store's atomic
            // response, D6); both outcomes end the same way for the
            // caller: sign in again.
            throw new ConnectError(
              result.outcome === "reused"
                ? "Your session was ended for security reasons. Sign in again."
                : "Your session has expired. Sign in again.",
              Code.Unauthenticated,
            );
          }

          const user = (await deps.store.getById(USER_KIND, result.userId)) as User | undefined;
          if (!user) {
            clearRefreshCookie(ctx, cookiePath);
            throw new ConnectError("Your session has expired. Sign in again.", Code.Unauthenticated);
          }

          const accessToken = await issueSession(user, ctx);
          return create(RefreshResponseSchema, {
            accessToken,
            expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
          });
        },

        async logout(_req, ctx) {
          const presented = refreshCookie(ctx);
          if (presented) {
            // Consuming (not deleting) leaves the one-time-use tripwire
            // armed: a post-logout replay of this token is theft evidence
            // and revokes everything, exactly like any other reuse.
            await deps.refreshTokens.consume(hashRefreshToken(presented));
          }
          clearRefreshCookie(ctx, cookiePath);
          return create(LogoutResponseSchema, {});
        },

        async whoAmI(_req, ctx) {
          const caller = await deps.caller(ctx);
          if (!caller) {
            throw new ConnectError("Authentication required", Code.Unauthenticated);
          }
          if (caller.kind !== "user") {
            // The operator key and in-process principals have no user row
            // — nothing to bootstrap a web session from.
            throw new ConnectError(
              `The ${caller.kind} credential has no user profile`,
              Code.NotFound,
            );
          }
          const user = (await deps.store.getById(USER_KIND, caller.id)) as User | undefined;
          if (!user) {
            throw new ConnectError(`User '${caller.id}' not found`, Code.NotFound);
          }
          return user;
        },
      });
    },
  };
}

function refreshCookie(ctx: HandlerContext): string | undefined {
  const header = ctx.requestHeader.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REFRESH_COOKIE) {
      return rest.join("=") || undefined;
    }
  }
  return undefined;
}

function setRefreshCookie(ctx: HandlerContext, token: string, path: string): void {
  ctx.responseHeader.set(
    "Set-Cookie",
    `${REFRESH_COOKIE}=${token}; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}; Path=${path}; ` +
      // HttpOnly: page script can never read it (D5). SameSite=Strict:
      // cross-site requests never carry it (assumes app and API share a
      // registrable domain — DD-005 D5's recorded assumption). Secure:
      // HTTPS-only; browsers exempt localhost, so dev still works.
      `HttpOnly; SameSite=Strict; Secure`,
  );
}

function clearRefreshCookie(ctx: HandlerContext, path: string): void {
  ctx.responseHeader.set(
    "Set-Cookie",
    `${REFRESH_COOKIE}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Strict; Secure`,
  );
}
