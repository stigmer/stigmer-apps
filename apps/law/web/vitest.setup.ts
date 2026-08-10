import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's auto-cleanup rides a global afterEach, which vitest
// only provides with globals:true (off here — imports stay explicit).
// Without this, one test's DOM leaks into the next and stale elements
// satisfy queries — a false pass or a baffling false failure.
afterEach(() => {
  cleanup();
});
