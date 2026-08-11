/**
 * @stigmer/identity — shared identity for Stigmer vertical apps.
 *
 * Owns the authentication seam (DD-005): a pluggable authenticator chain
 * producing the commons CallerPrincipal, the smallest correct issuer
 * behind it (bcrypt password → locally-signed RS256 tokens), the shared
 * User resource, and credential/refresh-session storage. Authorization
 * stays per-app — this package answers "who is calling", never "what may
 * they do".
 *
 * Postgres adapters live under `@stigmer/identity/postgres`.
 */

// The authenticator seam
export type { Authenticator } from "./authenticator.js";
export {
  bearerTokenAuthenticator,
  composeAuthenticators,
  operatorKeyAuthenticator,
} from "./authenticator.js";
export type { CallerResolver } from "./transport.js";
export { createCallerResolver } from "./transport.js";

// Channel identity (T05): verified channel sender → user-kind principal.
// A separate seam, deliberately NOT part of the authenticator chain —
// consumed only behind a channel entrance's own gate (see the module doc).
export type {
  ChannelIdentity,
  ChannelIdentityResolver,
  ChannelResolution,
} from "./channel-identity.js";
export { createChannelIdentityResolver, WHATSAPP_PHONE_KIND } from "./channel-identity.js";

// Tokens & keys
export type { AccessTokenIssuer } from "./token.js";
export { ACCESS_TOKEN_TTL_SECONDS, TOKEN_ISSUER, createAccessTokenIssuer } from "./token.js";
export type { SigningKeyConfig, SigningKeys } from "./keys.js";
export {
  SIGNING_ALGORITHM,
  generateEphemeralSigningKeys,
  loadSigningKeys,
} from "./keys.js";

// Credentials
export type { CredentialStore } from "./credential-store.js";
export { hashPassword, verifyPassword } from "./password.js";

// Activation codes (DD-003 D4): the no-email onboarding/reset path
export type { ActivationCodeStore, GeneratedActivationCode } from "./activation-code.js";
export {
  ACTIVATION_CODE_PREFIX,
  ACTIVATION_CODE_TTL_SECONDS,
  generateActivationCode,
  hashActivationCode,
} from "./activation-code.js";
export {
  OPERATOR_KEY_PREFIX,
  OPERATOR_PRINCIPAL,
  generateOperatorKey,
  hashOperatorKey,
  verifyOperatorKey,
} from "./operator-key.js";

// Refresh sessions
export type { RefreshConsumeResult, RefreshTokenStore } from "./refresh-token.js";
export {
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
} from "./refresh-token.js";

// The User resource
export type { UserResourceDeps } from "./user-resource.js";
export { USER_API_VERSION, USER_KIND, userResource } from "./user-resource.js";

// The auth surface (Login/Refresh/Logout/WhoAmI)
export type { AuthServiceDeps } from "./auth-service.js";
export { authService } from "./auth-service.js";
export type {
  LoginRateLimiter,
  MemoryRateLimiterOptions,
  RateLimitDecision,
} from "./rate-limit.js";
export { createMemoryRateLimiter } from "./rate-limit.js";

// Generated contracts (apps never deep-import another package's gen/)
export {
  GetUserRequestSchema,
  IssueActivationCodeRequestSchema,
  IssueActivationCodeResponseSchema,
  ListUsersRequestSchema,
  ListUsersResponseSchema,
  SetPasswordRequestSchema,
  SetPasswordResponseSchema,
  UserSchema,
  UserService,
  UserSpecSchema,
} from "./gen/stigmer/identity/user/v1/user_pb.js";
export type {
  GetUserRequest,
  IssueActivationCodeRequest,
  IssueActivationCodeResponse,
  ListUsersRequest,
  ListUsersResponse,
  SetPasswordRequest,
  SetPasswordResponse,
  User,
  UserSpec,
} from "./gen/stigmer/identity/user/v1/user_pb.js";
export {
  AuthService,
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  RedeemActivationCodeRequestSchema,
  RedeemActivationCodeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  WhoAmIRequestSchema,
} from "./gen/stigmer/identity/auth/v1/auth_pb.js";
export type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  LogoutResponse,
  RedeemActivationCodeRequest,
  RedeemActivationCodeResponse,
  RefreshRequest,
  RefreshResponse,
  WhoAmIRequest,
} from "./gen/stigmer/identity/auth/v1/auth_pb.js";
