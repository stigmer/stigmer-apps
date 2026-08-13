/**
 * Boot-time capability probe for the Postgres adapter.
 *
 * searchText's Unicode case folding rides the ICU collation
 * `"und-x-icu"` (see PostgresResourceStore.searchText). On a server
 * built without ICU — or a database whose encoding cannot carry ICU
 * collations (SQL_ASCII) — that query errors at RUNTIME, which would
 * surface as an opaque failure on the first user search. Deployments
 * call this beside their migration run so a database that cannot honor
 * the store contract refuses the rollout, loudly, while an operator is
 * watching.
 */

import type pg from "pg";

export async function assertStoreCapabilities(pool: pg.Pool): Promise<void> {
  try {
    await pool.query(`SELECT 'capability probe' COLLATE "und-x-icu"`);
  } catch (err) {
    throw new Error(
      `This database cannot honor the store contract: the ICU collation ` +
        `"und-x-icu" is unusable (text search case folding depends on it). ` +
        `Use an ICU-enabled Postgres — every official postgres image is — ` +
        `with a UTF8-encoded database. Underlying error: ${(err as Error).message}`,
    );
  }
}
