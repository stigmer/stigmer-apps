/**
 * Dev server + production build. The proxy exists ONLY in dev and gives
 * the dev server the production topology (T04b D1): the browser talks to
 * one origin, and API paths — the Connect path space, the document byte
 * routes, health — are forwarded to the backend process. In production
 * the backend itself serves this app's build, so there is no proxy and
 * nothing to keep in sync beyond these three prefixes.
 */

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const BACKEND = process.env.DEV_BACKEND_URL ?? "http://localhost:8080";

/**
 * Publishes pdfjs's CMaps and standard-font data beside the build (T12):
 * the viewer RENDERS glyphs, so PDFs with non-embedded fonts need
 * standardFontDataUrl and CID-encoded ones need cMapUrl — absent
 * assets render wrong or blank text SILENTLY (the missing-worker
 * defect class, in font form; session 14's lesson).
 *
 * The files are copied verbatim (not content-hashed), which is exactly
 * why they must NOT land under assets/: the backend's static handler
 * serves assets/ as immutable-forever (static-routes.ts), and a pdfjs
 * upgrade must be able to refresh these. A top-level pdf-assets/ gets
 * the handler's no-cache revalidation instead. src/pdf/pdfjs.ts is the
 * single consumer of these paths.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const DIRS = ["cmaps", "standard_fonts"] as const;
  const URL_PREFIX = "/pdf-assets/";

  return {
    name: "law:pdfjs-assets",
    // Dev: serve straight from node_modules, same URL space as prod.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(URL_PREFIX)) return next();
        const relative = url.slice(URL_PREFIX.length);
        const resolved = path.resolve(pdfjsRoot, relative);
        const inAllowedDir = DIRS.some((dir) =>
          resolved.startsWith(path.join(pdfjsRoot, dir) + path.sep),
        );
        if (!inAllowedDir || !existsSync(resolved)) {
          res.statusCode = 404;
          return res.end("not found");
        }
        res.setHeader("content-type", "application/octet-stream");
        createReadStream(resolved).pipe(res);
      });
    },
    // Build: copy into dist/pdf-assets/ after the bundle is written.
    async closeBundle() {
      for (const dir of DIRS) {
        const from = path.join(pdfjsRoot, dir);
        const to = path.join(import.meta.dirname, "dist", "pdf-assets", dir);
        await mkdir(to, { recursive: true });
        for (const entry of await readdir(from)) {
          await copyFile(path.join(from, entry), path.join(to, entry));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  server: {
    proxy: {
      // Every Connect service this backend mounts lives under a
      // `stigmer.`-prefixed proto package — the same prefix rule the
      // backend's static handler uses in reverse.
      "^/stigmer\\.": { target: BACKEND },
      "/files/": { target: BACKEND },
      "/healthz": { target: BACKEND },
    },
  },
});
