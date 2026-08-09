// Bundles the backend into a single Node-runnable file. The deployed image
// carries dist/main.js and no node_modules (isc-assistant precedent), which
// keeps the runtime stage minimal and makes "what ships" testable.
//
// Migration SQL cannot ride a JS bundle, and the image has no node_modules
// to resolve @stigmer/identity's files from — so the build copies BOTH
// migration sources beside the bundle (DD-005 D8's packaging rule);
// main.ts detects `dist/migrations/app` and uses this layout.
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const identityMigrations = path.join(
  path.dirname(require.resolve("@stigmer/identity/package.json")),
  "migrations",
);
await cp(identityMigrations, "dist/migrations/identity", { recursive: true });
await cp("migrations", "dist/migrations/app", { recursive: true });

// The web app's built SPA rides the same image at dist/public (T04b D1) —
// same mechanism as the migrations above. The root build script builds
// @law/web before this package; a missing dist (a backend-only local
// build) just yields a server without the static surface.
if (existsSync("../web/dist/index.html")) {
  await cp("../web/dist", "dist/public", { recursive: true });
}

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // pg optionally requires the native binding; it is absent on purpose
  // (pure-JS driver), so keep esbuild from trying to resolve it.
  external: ["pg-native"],
  // Bundled CJS dependencies (pg) still call require() at runtime; ESM
  // output needs a require shim for them.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
