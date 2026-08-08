/**
 * The operator key (DD-005 D7): a prefixed opaque credential from
 * per-deployment config, NOT a row in the user table — there is no
 * phishable admin account, and a fresh deployment (zero users) can still
 * bootstrap its first user.
 *
 * The backend holds only the SHA-256 hash; the raw key lives with the
 * operator. Prefix-peeking (`opk_`) follows the platform's `stk_`/`pck_`
 * convention: the prefix routes the credential to this authenticator and
 * makes leaked keys greppable.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CallerPrincipal } from "@stigmer/resource-api";

export const OPERATOR_KEY_PREFIX = "opk_";

/** One operator credential per deployment ⇒ one fixed principal id. */
export const OPERATOR_PRINCIPAL: CallerPrincipal = { id: "operator", kind: "operator" };

/** 32 random bytes = 256 bits — the platform's API-key entropy standard. */
export function generateOperatorKey(): { key: string; sha256Hex: string } {
  const key = OPERATOR_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, sha256Hex: hashOperatorKey(key) };
}

export function hashOperatorKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Constant-time comparison of hashes. Hashing the candidate first also
 * normalizes length, which timingSafeEqual requires.
 */
export function verifyOperatorKey(candidate: string, expectedSha256Hex: string): boolean {
  const candidateHash = Buffer.from(hashOperatorKey(candidate), "hex");
  const expectedHash = Buffer.from(expectedSha256Hex, "hex");
  return (
    candidateHash.length === expectedHash.length &&
    timingSafeEqual(candidateHash, expectedHash)
  );
}
