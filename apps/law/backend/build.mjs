// Bundles the backend into a single Node-runnable file. The deployed image
// carries dist/main.js and no node_modules (isc-assistant precedent), which
// keeps the runtime stage minimal and makes "what ships" testable.
import { build } from "esbuild";

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
