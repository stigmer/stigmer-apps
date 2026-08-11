/**
 * One-time activation codes (project DD-003 D4) — the no-email
 * onboarding/reset mechanism: an administrator ISSUES a code (shown
 * once, handed over out-of-band), the person REDEEMS it to set their
 * own password. The refresh-token discipline applied to provisioning:
 * hashes at rest, strictly one-time, expiring.
 *
 * 128 bits of entropy is the brute-force defense (codes are random,
 * unlike passwords); the uniform redeem failure is the enumeration
 * defense; the redeem rate limit is belt on top of both.
 */

import { createHash, randomBytes } from "node:crypto";

export const ACTIVATION_CODE_PREFIX = "act_";

/** Three days: long enough to hand over in person or on WhatsApp and
 * redeem after a weekend; short enough that a forgotten code is not a
 * standing credential. */
export const ACTIVATION_CODE_TTL_SECONDS = 3 * 24 * 60 * 60;

export interface GeneratedActivationCode {
  /** The raw code — returned to the issuer once, never stored. */
  readonly code: string;
  /** What the store keeps. */
  readonly sha256Hex: string;
}

export function generateActivationCode(): GeneratedActivationCode {
  const code = `${ACTIVATION_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
  return { code, sha256Hex: hashActivationCode(code) };
}

export function hashActivationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * The storage port. `issue` replaces any earlier code for the user (one
 * live code per user — the table's primary key states it); `consume`
 * atomically deletes and returns the owning user, answering undefined
 * for unknown, already-used, and expired codes alike — the caller
 * cannot tell which, and neither should its client.
 */
export interface ActivationCodeStore {
  issue(userId: string, codeSha256Hex: string, expiresAt: Date): Promise<void>;
  consume(codeSha256Hex: string): Promise<{ userId: string } | undefined>;
}
