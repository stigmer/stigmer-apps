/**
 * Password hashing — the ONE place bcrypt is invoked. SetPassword writes
 * through here; Login verifies through here; nothing else touches raw
 * passwords.
 */

import bcrypt from "bcryptjs";

/**
 * bcrypt cost factor: 10 is the bcryptjs default recommendation — ~100ms
 * per hash on current hardware, strong enough for operator-provisioned
 * teams (tens of users) and fast enough that provisioning and login stay
 * interactive. Carried from the first consumer's T03 decision.
 */
const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Constant-time by construction: bcrypt.compare re-derives and compares. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
