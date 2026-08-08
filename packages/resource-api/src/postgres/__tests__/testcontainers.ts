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

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminPool = new pg.Pool({ connectionString: container.getConnectionUri() });
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
      const pool = new pg.Pool({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getPassword(),
        database: dbName,
      });
      pools.push(pool);
      return pool;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end()));
      await container.stop();
    },
  };
}
