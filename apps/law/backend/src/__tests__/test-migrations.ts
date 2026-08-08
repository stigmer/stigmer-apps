/**
 * The app's migration sources for tests: identity first, app second — the
 * exact order main.ts declares (DD-005 D8), against the workspace layout.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { MigrationSource } from "@stigmer/resource-api/postgres";

export function testMigrationSources(): MigrationSource[] {
  const require = createRequire(import.meta.url);
  const identityDir = path.join(
    path.dirname(require.resolve("@stigmer/identity/package.json")),
    "migrations",
  );
  return [
    { source: "identity", dir: identityDir },
    { source: "app", dir: new URL("../../migrations", import.meta.url).pathname },
  ];
}
