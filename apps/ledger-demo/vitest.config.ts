/** The server's and the setup's tests: plain Node, no browser. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "setup/**/*.test.ts", "fixtures/**/*.test.ts"],
    environment: "node",
  },
});
