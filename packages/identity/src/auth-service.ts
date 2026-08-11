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
import { hashActivationCode, type ActivationCodeStore } from "./activation-code.js";
import type { CredentialStore } from "./credential-store.js";
import {
  AuthService,
  ChangePasswordResponseSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  RedeemActivationCodeResponseSchema,
  RefreshResponseSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type RedeemActivationCodeRequest,
} from "./gen/stigmer/identity/auth/v1/auth_pb.js";
import type { User } from "./gen/stigmer/identity/user/v1/user_pb.js";
import { hashPassword, verifyPassword } from "./password.js";
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

/** The redeem twin of the login rule: unknown, already-used, and expired
 * codes answer identically — which one it was is nobody's business. */
const UNIFORM_REDEEM_FAILURE = "This code is not valid or has expired";

const REFRESH_COOKIE = "stigmer_refresh";

export interface AuthServiceDeps {
  /** The app's composed store — User lookups resolve through it. */
  readonly store: ResourceStore;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  /** The redeem surface (DD-003 D4). */
  readonly activationCodes: ActivationCodeStore;
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

        async redeemActivationCode(req: RedeemActivationCodeRequest) {
          if (!req.code || req.newPassword.length < 8) {
            throw new ConnectError(
              "A code and a password of at least 8 characters are required",
              Code.InvalidArgument,
            );
          }
          // The login limiter, keyed by the presented code: entropy is
          // the real brute-force defense (128 random bits), this bounds
          // per-code retry noise the same way login bounds per-email.
          const budget = rateLimiter.check(`redeem:${req.code}`);
          if (!budget.allowed) {
            const minutes = Math.max(1, Math.ceil((budget.retryAfterSeconds ?? 60) / 60));
            throw new ConnectError(
              `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
              Code.ResourceExhausted,
            );
          }

          const consumed = await deps.activationCodes.consume(hashActivationCode(req.code));
          if (!consumed) {
            rateLimiter.recordFailure(`redeem:${req.code}`);
            throw new ConnectError(UNIFORM_REDEEM_FAILURE, Code.Unauthenticated);
          }

          await deps.credentials.setPasswordHash(
            consumed.userId,
            await hashPassword(req.newPassword),
          );
          // Reset-after-compromise semantics: whatever sessions the OLD
          // credential earned die with it. The person signs in fresh.
          await deps.refreshTokens.revokeAllForUser(consumed.userId);
          return create(RedeemActivationCodeResponseSchema, {});
        },

        async changePassword(req: ChangePasswordRequest, ctx) {
          const caller = await deps.caller(ctx);
          if (!caller || caller.kind !== "user") {
            throw new ConnectError("Authentication required", Code.Unauthenticated);
          }
          if (req.newPassword.length < 8) {
            throw new ConnectError(
              "The new password must be at least 8 characters",
              Code.InvalidArgument,
            );
          }
          // Proof of possession, rate-limited like login (an attacker
          // with a stolen session must not get free guesses at the
          // current password).
          const budget = rateLimiter.check(`change:${caller.id}`);
          if (!budget.allowed) {
            const minutes = Math.max(1, Math.ceil((budget.retryAfterSeconds ?? 60) / 60));
            throw new ConnectError(
              `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
              Code.ResourceExhausted,
            );
          }
          const currentHash = await deps.credentials.getPasswordHash(caller.id);
          if (!currentHash || !(await verifyPassword(req.currentPassword, currentHash))) {
            rateLimiter.recordFailure(`change:${caller.id}`);
            throw new ConnectError("The current password is incorrect", Code.PermissionDenied);
          }
          rateLimiter.recordSuccess(`change:${caller.id}`);

          await deps.credentials.setPasswordHash(caller.id, await hashPassword(req.newPassword));
          // Every session dies — including this one's refresh cookie.
          // The client signs in again with the password it just set.
          await deps.refreshTokens.revokeAllForUser(caller.id);
          clearRefreshCookie(ctx, cookiePath);
          return create(ChangePasswordResponseSchema, {});
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
