import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InProcessEventDispatcher } from "@stigmer/resource-api";
import { runMigrations, type MigrationSource } from "@stigmer/resource-api/postgres";
import { createPgCredentialStore, createPgRefreshTokenStore } from "@stigmer/identity/postgres";
import pg from "pg";
import { createAuthKit } from "./auth/auth.js";
import { loadConfigFromEnv } from "./config.js";
import { createS3ObjectStore } from "./objectstore/object-store.js";
import { createFirmServers } from "./server.js";
import { createResourceStore } from "./storage.js";
import { detectWebRoot } from "./web/static-routes.js";

/**
 * Two migration sources, identity first so app tables may reference
 * users(id) (DD-005 D8). Two layouts exist:
 *
 * - Built artifact: build.mjs copies both directories to
 *   `dist/migrations/{identity,app}` because the image carries no
 *   node_modules — detected by that directory existing beside this module.
 * - Dev (`tsx src/main.ts`): the app's own files sit at ../migrations and
 *   identity's resolve through the workspace link.
 */
function migrationSources(): MigrationSource[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledBase = path.join(moduleDir, "migrations");
  if (existsSync(path.join(bundledBase, "app"))) {
    return [
      { source: "identity", dir: path.join(bundledBase, "identity") },
      { source: "app", dir: path.join(bundledBase, "app") },
    ];
  }
  const require = createRequire(import.meta.url);
  const identityDir = path.join(
    path.dirname(require.resolve("@stigmer/identity/package.json")),
    "migrations",
  );
  return [
    { source: "identity", dir: identityDir },
    { source: "app", dir: path.join(moduleDir, "..", "migrations") },
  ];
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  // Either DatabaseConfig shape is a valid PoolConfig subset — the URL
  // is never assembled by hand (see config.ts, DatabaseConfig).
  const pool = new pg.Pool(config.database);

  // Migrate on boot: replicas serialize on the runner's advisory lock, so
  // this is safe under horizontal scaling.
  const migrated = await runMigrations(pool, migrationSources());
  if (migrated.applied.length > 0) {
    console.log(`migrations applied: ${migrated.applied.join(", ")}`);
  }

  const auth = await createAuthKit(config.auth);

  // The event bus: pipelines publish on it, notification handlers
  // subscribe on it (inside createBackendServer) — never inside resource
  // handlers.
  const dispatcher = new InProcessEventDispatcher();

  // The built image carries the web app at dist/public (build.mjs, the
  // migrations-copy precedent); dev serves the front end from Vite
  // instead, so absence just means no static surface (T04b D1).
  const webRoot = detectWebRoot(path.dirname(fileURLToPath(import.meta.url)));

  // One assembly, two listeners (T05): the app on the ingress port, the
  // MCP channel entrance on its own cluster-internal port.
  const { web, mcp } = createFirmServers(
    {
      store: createResourceStore(pool),
      auth,
      credentials: createPgCredentialStore(pool),
      refreshTokens: createPgRefreshTokenStore(pool),
      objectStore: createS3ObjectStore(config.objectStore),
      dispatcher,
      webRoot,
    },
    { sharedSecret: config.mcp.sharedSecret },
  );
  web.listen(config.port, () => {
    console.log(`backend listening on :${config.port}`);
  });
  mcp.listen(config.mcp.port, () => {
    console.log(`mcp listening on :${config.mcp.port}`);
  });

  // Graceful shutdown: stop accepting connections on BOTH listeners,
  // then release the pool. Signals must reach this process directly
  // (exec-form CMD in containers).
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    let remaining = 2;
    const done = () => {
      remaining -= 1;
      if (remaining === 0) {
        void pool.end().then(() => process.exit(0));
      }
    };
    web.close(done);
    mcp.close(done);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
