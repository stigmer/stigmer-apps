/**
 * The page's build, and its dev server. `npm run dev` serves the page with hot reload and sends
 * `/api` to Acme's server on 3001 (`npm start`); the built page is served by that server itself.
 * Port 5173 is the origin each customer organization's embedding settings allow, so the page is
 * opened at exactly http://localhost:5173.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  // The panel's own chunks (the session view, its virtualized thread) are the SDK's and already
  // load lazily; the default 500 kB warning would only ever name them.
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:3001" } },
});
