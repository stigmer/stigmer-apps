/**
 * The credential store — app-owned, deliberately outside the resource
 * store (T03 D7): credentials are an auth concern, not resource state, and
 * keeping them out of the User message makes a hash-in-response leak
 * impossible by construction rather than prevented by redaction.
 *
 * Writers: the operator-only SetPassword operation. Readers: T04's login.
 */

import type pg from "pg";

export interface CredentialStore {
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  getPasswordHash(userId: string): Promise<string | undefined>;
}

export function createPgCredentialStore(pool: pg.Pool): CredentialStore {
  return {
    async setPasswordHash(userId, passwordHash) {
      await pool.query(
        `INSERT INTO user_credentials (user_id, password_hash, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
        [userId, passwordHash],
      );
    },
    async getPasswordHash(userId) {
      const res = await pool.query(
        `SELECT password_hash FROM user_credentials WHERE user_id = $1`,
        [userId],
      );
      return res.rows[0]?.password_hash;
    },
  };
}
