// Bundles the backend into a single Node-runnable file. The deployed image
// carries dist/main.js and no node_modules (isc-assistant precedent), which
// keeps the runtime stage minimal and makes "what ships" testable.
//
// Migration SQL cannot ride a JS bundle, and the image has no node_modules
// to resolve @stigmer/identity's files from — so the build copies BOTH
// migration sources beside the bundle (DD-005 D8's packaging rule);
// main.ts detects `dist/migrations/app` and uses this layout.
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

// dist is REBUILT, never accreted: a stale workspace must not ship
// ghost files — a retired migration lingering in dist/migrations would
// apply schema the source tree no longer contains (caught live when the
// rebuild renumbered the baseline and the old 0001_cases.sql survived a
// dirty dist).
await rm("dist", { recursive: true, force: true });

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

// pdfjs's "fake worker" (the workerless mode text extraction runs in)
// dynamically imports pdf.worker.mjs BESIDE the importing module at
// runtime — a computed path esbuild cannot inline, and the dev tree's
// node_modules masks its absence from every source-level test. The
// worker module rides beside the bundle like the migrations do; the
// bundle suite asserts it shipped. (Found live: the image extracted
// nothing, and the miss was misclassified as unreadable documents.)
const pdfjsBuild = path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")),
  "legacy/build",
);
await cp(path.join(pdfjsBuild, "pdf.worker.mjs"), "dist/pdf.worker.mjs");

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
  // output needs a require shim for them. The import is aliased because
  // the banner is spliced in VERBATIM, outside esbuild's scope analysis:
  // main.ts imports createRequire itself, and the un-aliased form
  // collides with the bundle's own emitted import — a SyntaxError that
  // only `node dist/main.js` can surface (bundle.integration.test.ts
  // exists to catch exactly this class of defect).
  banner: {
    js:
      "import { createRequire as bannerCreateRequire } from 'node:module'; " +
      "const require = bannerCreateRequire(import.meta.url);",
  },
});
