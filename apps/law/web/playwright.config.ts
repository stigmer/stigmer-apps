/**
 * The working-day E2E suite (tester role: Playwright for the flows a law
 * firm's day depends on). The web server is the REAL backend serving the
 * REAL build — src/e2e/serve.ts in the backend workspace boots Postgres
 * in a container, seeds fictional users through the operator path, and
 * serves ../web/dist exactly like the deployed image serves dist/public.
 *
 * TWO servers, TWO projects: the main suite runs assistant-DISABLED
 * (the open-source posture — assistant.spec.ts proves the affordance is
 * absent, not broken), while assistant-dock.spec.ts runs against a
 * second server in fake-assistant mode (E2E_FAKE_ASSISTANT=1), where
 * the real dock and the real SDK stylesheet load. Dock-open layout is
 * only testable there — the stigmer/stigmer#454 class of defect was
 * invisible to the assistant-disabled suite by construction.
 *
 * Run via `npm run test:e2e` (builds the app first — the backend serves
 * dist, so a stale build would test yesterday's code).
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8799);
const ASSISTANT_PORT = Number(process.env.E2E_ASSISTANT_PORT ?? 8797);

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
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /assistant-dock\.spec\.ts/,
    },
    {
      name: "assistant-dock",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://localhost:${ASSISTANT_PORT}`,
      },
      testMatch: /assistant-dock\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: "npx tsx ../backend/src/e2e/serve.ts",
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      // First run pulls the postgres image.
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npx tsx ../backend/src/e2e/serve.ts",
      url: `http://localhost:${ASSISTANT_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        E2E_PORT: String(ASSISTANT_PORT),
        E2E_MCP_PORT: "8796",
        E2E_FAKE_ASSISTANT: "1",
      },
    },
  ],
});
