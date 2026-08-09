/**
 * The working-day E2E suite (tester role: Playwright for the flows a law
 * firm's day depends on). The web server is the REAL backend serving the
 * REAL build — src/e2e/serve.ts in the backend workspace boots Postgres
 * in a container, seeds fictional users through the operator path, and
 * serves ../web/dist exactly like the deployed image serves dist/public.
 *
 * Run via `npm run test:e2e` (builds the app first — the backend serves
 * dist, so a stale build would test yesterday's code).
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: "./e2e",
  // Container-backed backend: generous per-test budget, generous boot.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx ../backend/src/e2e/serve.ts",
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    // First run pulls the postgres image.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
