/**
 * Login rate limiting (DD-005: a must-build, not a nice-to-have — the one
 * brute-force protection a vendor IdP would otherwise provide).
 *
 * Two budgets, both fixed windows:
 * - per-email: caps guessing against one account;
 * - global: caps enumeration across accounts. This replaces a per-IP
 *   budget deliberately — client IP at this layer is either absent or an
 *   attacker-controlled x-forwarded-for header, and a limit keyed on an
 *   attacker-chosen value is decoration. Deployments are single-tenant
 *   and single-replica (DD-001: no Redis), so in-memory process state IS
 *   the deployment's state; the port is the seam if that ever changes.
 *
 * Only FAILURES consume budget: a clerk who signs in successfully five
 * times is not an attack. Success clears the email's window.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Present when denied — clerk-facing "try again in N minutes". */
  readonly retryAfterSeconds?: number;
}

export interface LoginRateLimiter {
  check(email: string): RateLimitDecision;
  recordFailure(email: string): void;
  recordSuccess(email: string): void;
}

interface Window {
  count: number;
  windowStartMs: number;
}

export interface MemoryRateLimiterOptions {
  /** Failures allowed per email per window. Default 5. */
  readonly maxFailuresPerEmail?: number;
  /** Failures allowed across ALL emails per window. Default 50. */
  readonly maxFailuresGlobal?: number;
  /** Window length. Default 15 minutes. */
  readonly windowSeconds?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export function createMemoryRateLimiter(
  options: MemoryRateLimiterOptions = {},
): LoginRateLimiter {
  const maxPerEmail = options.maxFailuresPerEmail ?? 5;
  const maxGlobal = options.maxFailuresGlobal ?? 50;
  const windowMs = (options.windowSeconds ?? 15 * 60) * 1000;
  const now = options.now ?? Date.now;

  const perEmail = new Map<string, Window>();
  const global: Window = { count: 0, windowStartMs: 0 };

  function current(window: Window): Window {
    if (now() - window.windowStartMs >= windowMs) {
      window.count = 0;
      window.windowStartMs = now();
    }
    return window;
  }

  function emailWindow(email: string): Window {
    let w = perEmail.get(email);
    if (!w) {
      w = { count: 0, windowStartMs: now() };
      perEmail.set(email, w);
      // Bound the map: expired entries are dead weight; sweep lazily.
      if (perEmail.size > 10_000) {
        for (const [key, value] of perEmail) {
          if (now() - value.windowStartMs >= windowMs) perEmail.delete(key);
        }
      }
    }
    return current(w);
  }

  const retryAfter = (w: Window) =>
    Math.max(1, Math.ceil((w.windowStartMs + windowMs - now()) / 1000));

  return {
    check(email) {
      const e = emailWindow(email);
      if (e.count >= maxPerEmail) {
        return { allowed: false, retryAfterSeconds: retryAfter(e) };
      }
      const g = current(global);
      if (g.count >= maxGlobal) {
        return { allowed: false, retryAfterSeconds: retryAfter(g) };
      }
      return { allowed: true };
    },
    recordFailure(email) {
      const e = emailWindow(email);
      if (e.count === 0) e.windowStartMs = now();
      e.count += 1;
      const g = current(global);
      if (g.count === 0) g.windowStartMs = now();
      g.count += 1;
    },
    recordSuccess(email) {
      perEmail.delete(email);
    },
  };
}
