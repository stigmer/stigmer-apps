/**
 * Refresh tokens (DD-005 D6): opaque — never JWTs — stored ONLY as
 * SHA-256 hashes, one-time-use with reuse detection.
 *
 * Why one-time-use: a refresh token is the long-lived credential (7-day
 * rolling window, T01 owner decision 1). Rotating it on every use means a
 * stolen copy is caught the moment BOTH copies refresh: the second
 * arrival of a consumed hash is proof of theft, and the store responds by
 * revoking the whole user's sessions (contract below), not just the
 * token. Without rotation, theft is silent for the full window.
 */

import { createHash, randomBytes } from "node:crypto";

export const REFRESH_TOKEN_PREFIX = "rft_";

/** T01 owner decision 1: refresh 7-day rolling window (= inactivity expiry). */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 32 random bytes = 256 bits — the platform's API-key entropy standard. */
export function generateRefreshToken(): { token: string; sha256Hex: string } {
  const token = REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, sha256Hex: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type RefreshConsumeResult =
  /** Valid, unconsumed, unexpired — now marked consumed; rotate and go. */
  | { readonly outcome: "ok"; readonly userId: string }
  /**
   * The hash was already consumed: someone replayed a rotated-out token.
   * The store has ALREADY revoked every session of the affected user —
   * detection and response are one atomic act, so no caller can forget
   * the response half.
   */
  | { readonly outcome: "reused"; readonly userId: string }
  /** Unknown or expired — plain invalid, nothing to react to. */
  | { readonly outcome: "invalid" };

export interface RefreshTokenStore {
  /** Records a newly issued token (hash only). */
  insert(userId: string, tokenSha256Hex: string, expiresAt: Date): Promise<void>;
  /** One-time consumption with atomic reuse response; see the result type. */
  consume(tokenSha256Hex: string): Promise<RefreshConsumeResult>;
  /** Kills every session: logout-everywhere, SetPassword (DD-005 D9), reuse response. */
  revokeAllForUser(userId: string): Promise<void>;
}
