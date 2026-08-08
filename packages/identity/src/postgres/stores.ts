/**
 * Postgres adapters for the identity ports. Schema lives in
 * `migrations/0001_users.sql` (this package's migration source); these
 * queries must mirror it exactly.
 */

import type pg from "pg";
import type { CredentialStore } from "../credential-store.js";
import type { RefreshConsumeResult, RefreshTokenStore } from "../refresh-token.js";

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

export function createPgRefreshTokenStore(pool: pg.Pool): RefreshTokenStore {
  return {
    async insert(userId, tokenSha256Hex, expiresAt) {
      // Opportunistic purge of EXPIRED rows keeps the table bounded
      // without a scheduled job. Consumed-but-unexpired rows must stay:
      // they are the reuse-detection evidence (see the migration comment).
      await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now()`);
      await pool.query(
        `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [tokenSha256Hex, userId, expiresAt],
      );
    },

    async consume(tokenSha256Hex) {
      // One transaction with a row lock: two concurrent presentations of
      // the same token serialize here, so exactly one gets "ok" and the
      // other is detected as reuse — the property the whole design buys.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const res = await client.query<{
          user_id: string;
          expired: boolean;
          consumed: boolean;
        }>(
          `SELECT user_id,
                  expires_at < now() AS expired,
                  consumed_at IS NOT NULL AS consumed
             FROM refresh_tokens
            WHERE token_hash = $1
            FOR UPDATE`,
          [tokenSha256Hex],
        );

        const row = res.rows[0];
        let result: RefreshConsumeResult;
        if (!row) {
          result = { outcome: "invalid" };
        } else if (row.consumed) {
          // Reuse response is part of consume's atomic contract: revoke
          // everything the affected user holds, in the same transaction
          // as the detection.
          await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [row.user_id]);
          result = { outcome: "reused", userId: row.user_id };
        } else if (row.expired) {
          await client.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [
            tokenSha256Hex,
          ]);
          result = { outcome: "invalid" };
        } else {
          await client.query(
            `UPDATE refresh_tokens SET consumed_at = now() WHERE token_hash = $1`,
            [tokenSha256Hex],
          );
          result = { outcome: "ok", userId: row.user_id };
        }
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async revokeAllForUser(userId) {
      await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
    },
  };
}
