import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom because the session kit and screens are browser code; the
    // Playwright suite (e2e/) runs real browsers and is deliberately
    // outside vitest's include.
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
