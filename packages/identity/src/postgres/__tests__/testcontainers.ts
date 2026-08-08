/**
 * Shared Postgres container for a test file. One container per suite (not
 * per test) keeps runs fast; tests isolate by creating their own databases.
 * Requires a running Docker daemon — locally and in CI alike; tests never
 * assume a pre-existing database service (tester mandate: "no environment
 * assumptions").
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

// Pinned tag, not `latest`: the test database must not change under us
// between runs. 17 is the current stable major we target in production.
const POSTGRES_IMAGE = "postgres:17-alpine";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Creates a pool onto a freshly created, isolated database. */
  createIsolatedPool(): Promise<pg.Pool>;
  stop(): Promise<void>;
}

/**
 * pg pools CRASH THE PROCESS when an idle client errors with no 'error'
 * listener attached (documented pg behavior). During teardown the
 * container's shutdown can race a client's own graceful close and deliver
 * a FATAL 57P01 ("admin shutdown") — timing-dependent, so it passes
 * locally and detonates on slow CI runners. The listener logs instead of
 * throwing; a mid-test idle-client error still fails the test through
 * the query that hits the broken connection.
 */
function withErrorListener(pool: pg.Pool): pg.Pool {
  pool.on("error", (err) => {
    console.warn("idle pool client error (expected during container teardown):", err.message);
  });
  return pool;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminPool = withErrorListener(
    new pg.Pool({ connectionString: container.getConnectionUri() }),
  );
  let dbCounter = 0;
  const pools: pg.Pool[] = [adminPool];

  return {
    container,
    async createIsolatedPool() {
      dbCounter += 1;
      const dbName = `test_db_${dbCounter}`;
      // Identifier is generated locally (never user input), so simple
      // interpolation is safe here; CREATE DATABASE cannot be parameterized.
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      const pool = withErrorListener(
        new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          user: container.getUsername(),
          password: container.getPassword(),
          database: dbName,
        }),
      );
      pools.push(pool);
      return pool;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end()));
      await container.stop();
    },
  };
}
