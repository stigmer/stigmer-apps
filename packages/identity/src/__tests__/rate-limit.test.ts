import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "../rate-limit.js";

function limiterWithClock(options: { maxFailuresPerEmail?: number; maxFailuresGlobal?: number } = {}) {
  let nowMs = 1_000_000;
  const limiter = createMemoryRateLimiter({
    ...options,
    windowSeconds: 900,
    now: () => nowMs,
  });
  return { limiter, advance: (seconds: number) => (nowMs += seconds * 1000) };
}

describe("createMemoryRateLimiter", () => {
  it("only failures consume budget; success clears the email's window", () => {
    const { limiter } = limiterWithClock({ maxFailuresPerEmail: 2 });

    limiter.recordFailure("a@firm.example");
    limiter.recordFailure("a@firm.example");
    expect(limiter.check("a@firm.example").allowed).toBe(false);

    limiter.recordSuccess("a@firm.example");
    expect(limiter.check("a@firm.example").allowed).toBe(true);
  });

  it("denies per email without touching other emails", () => {
    const { limiter } = limiterWithClock({ maxFailuresPerEmail: 1 });

    limiter.recordFailure("a@firm.example");
    expect(limiter.check("a@firm.example").allowed).toBe(false);
    expect(limiter.check("b@firm.example").allowed).toBe(true);
  });

  it("the global budget caps enumeration across many emails", () => {
    const { limiter } = limiterWithClock({ maxFailuresPerEmail: 100, maxFailuresGlobal: 3 });

    limiter.recordFailure("a@firm.example");
    limiter.recordFailure("b@firm.example");
    limiter.recordFailure("c@firm.example");
    expect(limiter.check("d@firm.example").allowed).toBe(false);
  });

  it("windows expire: a denial heals after the window passes, with retry advice", () => {
    const { limiter, advance } = limiterWithClock({ maxFailuresPerEmail: 1 });

    limiter.recordFailure("a@firm.example");
    const denied = limiter.check("a@firm.example");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(900);

    advance(901);
    expect(limiter.check("a@firm.example").allowed).toBe(true);
  });
});
