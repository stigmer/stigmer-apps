import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "@stigmer/resource-api/postgres";
import pg from "pg";
import { loadConfigFromEnv } from "./config.js";
import { createBackendServer } from "./server.js";

/**
 * Migrations live beside the source tree (`backend/migrations`). The
 * default resolves relative to this module so it works under both `tsx
 * src/main.ts` (src/../migrations) and the bundled `dist/main.js`
 * (dist/../migrations). Containers set MIGRATIONS_DIR explicitly.
 */
function migrationsDir(): string {
  return (
    process.env.MIGRATIONS_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations")
  );
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });

  // Migrate on boot: replicas serialize on the runner's advisory lock, so
  // this is safe under horizontal scaling.
  const migrated = await runMigrations(pool, migrationsDir());
  if (migrated.applied.length > 0) {
    console.log(`migrations applied: ${migrated.applied.join(", ")}`);
  }

  const server = createBackendServer({ pool });
  server.listen(config.port, () => {
    console.log(`backend listening on :${config.port}`);
  });

  // Graceful shutdown: stop accepting connections, then release the pool.
  // Signals must reach this process directly (exec-form CMD in containers).
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
