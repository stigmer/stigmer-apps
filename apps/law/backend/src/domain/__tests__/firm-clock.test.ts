/**
 * firmDayUtcBounds is the day-feed predicates' foundation
 * (FR-HEAR-007): a firm calendar day as UTC instant bounds, compared as
 * RFC3339 text by both store adapters. Wrong bounds would silently
 * shift "today" by 5½ hours — the class of bug the firm-clock module
 * exists to prevent (its header's midnight lesson).
 */

import { describe, expect, it } from "vitest";
import { addDaysToIsoDate, firmDayUtcBounds } from "../firm-clock.js";

describe("firmDayUtcBounds", () => {
  it("maps an IST calendar day to [previous 18:30 UTC, same-day 18:30 UTC)", () => {
    const bounds = firmDayUtcBounds("2026-08-19");
    expect(bounds.gte).toBe("2026-08-18T18:30:00.000Z");
    expect(bounds.lt).toBe("2026-08-19T18:30:00.000Z");
  });

  it("rolls month and year boundaries through real date math", () => {
    expect(firmDayUtcBounds("2026-01-01").gte).toBe("2025-12-31T18:30:00.000Z");
    expect(firmDayUtcBounds("2026-12-31").lt).toBe("2026-12-31T18:30:00.000Z");
  });

  it("half-open as TEXT, the way the adapters compare: the day's first instant matches, next midnight does not", () => {
    const bounds = firmDayUtcBounds("2026-08-19");
    // Stored proto3-JSON instants render without a forced fraction —
    // these are the exact strings the generated columns hold.
    const dayStart = "2026-08-18T18:30:00Z"; // 2026-08-19 00:00 IST
    const inside = "2026-08-19T10:15:30.123Z"; // mid-afternoon IST
    const nextMidnight = "2026-08-19T18:30:00Z"; // 2026-08-20 00:00 IST
    // A row matches the range iff (value >= gte AND value < lt) under
    // plain string comparison — the adapters' actual predicate.
    const matches = (value: string) => value >= bounds.gte && value < bounds.lt;
    expect(matches(dayStart)).toBe(true);
    expect(matches(inside)).toBe(true);
    expect(matches(nextMidnight)).toBe(false);
  });

  it("adjacent days tile with no gap and no overlap", () => {
    const today = firmDayUtcBounds("2026-08-19");
    const tomorrow = firmDayUtcBounds(addDaysToIsoDate("2026-08-19", 1));
    expect(today.lt).toBe(tomorrow.gte);
  });
});
