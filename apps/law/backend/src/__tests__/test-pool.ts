/**
 * Test-only pg.Pool factory with the mandatory idle-client error
 * listener: pg CRASHES THE PROCESS when an idle client errors with no
 * 'error' listener, and container teardown can race a client's graceful
 * close with a FATAL 57P01 — timing-dependent, so it passes locally and
 * detonates on slow CI runners (observed on ts-commons CI, same
 * arrangement). Mid-test connection failures still fail tests through
 * the queries that hit them.
 */

import pg from "pg";

export function createTestPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", (err) => {
    console.warn("idle pool client error (expected during container teardown):", err.message);
  });
  return pool;
}
