/**
 * Dev server + production build. The proxy exists ONLY in dev and gives
 * the dev server the production topology (T04b D1): the browser talks to
 * one origin, and API paths — the Connect path space, the document byte
 * routes, health — are forwarded to the backend process. In production
 * the backend itself serves this app's build, so there is no proxy and
 * nothing to keep in sync beyond these three prefixes.
 */

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const BACKEND = process.env.DEV_BACKEND_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
