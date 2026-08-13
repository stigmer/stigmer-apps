/**
 * The OCR sweep's pure cost-guard helpers (DD-009's argued divergence
 * from the retry-forever rule): the backoff schedule that stops a
 * stuck document from billing all day, and the budget gate's decision
 * table. Time is a parameter throughout — no fake timers, no sleeps.
 * The sweep's store-backed behavior is a later phase's integration
 * suite (the fake-OCR-server plan in DD-009's test strategy).
 */

import { describe, expect, it } from "vitest";
import { WINDOW_PAGES } from "../../../ocr/document-ai.js";
import { chunkPages, createOcrBackoff, decideBudgetGate } from "../ocr-sweep.js";

const INTERVAL_MS = 300_000; // the production default: a 5-minute tick

describe("chunkPages (the window arithmetic, sweep-owned since review F6)", () => {
  it("keeps 15 pages in one window and splits 16 into [1..15] and [16]", () => {
    expect(WINDOW_PAGES).toBe(15);
    const fifteen = Array.from({ length: 15 }, (_, i) => i + 1);
    expect(chunkPages(fifteen, WINDOW_PAGES)).toEqual([fifteen]);

    const sixteen = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(chunkPages(sixteen, WINDOW_PAGES)).toEqual([fifteen, [16]]);
  });

  it("splits 200 pages into 14 windows that partition the input in order", () => {
    const pages = Array.from({ length: 200 }, (_, i) => i + 1);
    const windows = chunkPages(pages, WINDOW_PAGES);
    expect(windows).toHaveLength(14);
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(WINDOW_PAGES);
    }
    expect(windows.flat()).toEqual(pages);
  });

  it("answers one window for one page and none for an empty list", () => {
    expect(chunkPages([7], WINDOW_PAGES)).toEqual([[7]]);
    expect(chunkPages([], WINDOW_PAGES)).toEqual([]);
  });
});

describe("createOcrBackoff", () => {
  it("treats an untracked document as eligible", () => {
    const backoff = createOcrBackoff(INTERVAL_MS);
    expect(backoff.isEligible("doc-1", 0)).toBe(true);
  });

  it("skips a failed document for 2^attempts intervals, growing per failure", () => {
    const backoff = createOcrBackoff(INTERVAL_MS);

    // First failure: eligible again after 2^1 = 2 intervals.
    backoff.recordFailure("doc-1", 0);
    expect(backoff.isEligible("doc-1", 2 * INTERVAL_MS - 1)).toBe(false);
    expect(backoff.isEligible("doc-1", 2 * INTERVAL_MS)).toBe(true);

    // Second failure (recorded at t=0 for arithmetic clarity): 2^2 = 4.
    backoff.recordFailure("doc-1", 0);
    expect(backoff.isEligible("doc-1", 4 * INTERVAL_MS - 1)).toBe(false);
    expect(backoff.isEligible("doc-1", 4 * INTERVAL_MS)).toBe(true);

    // Third: 2^3 = 8.
    backoff.recordFailure("doc-1", 0);
    expect(backoff.isEligible("doc-1", 8 * INTERVAL_MS - 1)).toBe(false);
    expect(backoff.isEligible("doc-1", 8 * INTERVAL_MS)).toBe(true);
  });

  it("caps the skip window at 2^5 = 32 intervals no matter how many failures accrue", () => {
    const backoff = createOcrBackoff(INTERVAL_MS);
    for (let i = 0; i < 10; i++) {
      backoff.recordFailure("doc-1", 0);
    }
    expect(backoff.isEligible("doc-1", 32 * INTERVAL_MS - 1)).toBe(false);
    expect(backoff.isEligible("doc-1", 32 * INTERVAL_MS)).toBe(true);
  });

  it("eviction makes a document immediately eligible and forgets its attempt count", () => {
    const backoff = createOcrBackoff(INTERVAL_MS);
    backoff.recordFailure("doc-1", 0);
    backoff.recordFailure("doc-1", 0);
    backoff.evict("doc-1");
    expect(backoff.isEligible("doc-1", 0)).toBe(true);

    // A fresh failure starts the schedule over at 2^1, not 2^3.
    backoff.recordFailure("doc-1", 0);
    expect(backoff.isEligible("doc-1", 2 * INTERVAL_MS)).toBe(true);
  });

  it("bounds the map at 500 entries by dropping the oldest-eligible one", () => {
    const backoff = createOcrBackoff(INTERVAL_MS);
    // 501 documents failing at strictly increasing times: doc-0 holds
    // the smallest eligibleAt, so the 501st insert must drop it.
    for (let i = 0; i <= 500; i++) {
      backoff.recordFailure(`doc-${i}`, i * 1000);
    }
    // Dropped = untracked = eligible even inside its old skip window.
    expect(backoff.isEligible("doc-0", 0)).toBe(true);
    // Its neighbors survive with their windows intact.
    expect(backoff.isEligible("doc-1", 1000)).toBe(false);
    expect(backoff.isEligible("doc-500", 500_000)).toBe(false);
  });
});

describe("decideBudgetGate", () => {
  it("processes a document that fits the remaining budget, including exactly", () => {
    expect(decideBudgetGate(50, 100, 200)).toBe("process");
    expect(decideBudgetGate(100, 100, 200)).toBe("process");
    expect(decideBudgetGate(200, 200, 200)).toBe("process");
  });

  it("stops the tick when a mid-tick document exceeds what is left — arrival order preserved", () => {
    expect(decideBudgetGate(150, 100, 200)).toBe("stop");
    expect(decideBudgetGate(1, 0, 200)).toBe("stop");
    // One page over, one page short of a full budget: still a stop —
    // only a FULL budget earns the oversized exception.
    expect(decideBudgetGate(200, 199, 200)).toBe("stop");
  });

  it("processes an oversized document whole when it is the tick's first (full budget), or it would never run", () => {
    expect(decideBudgetGate(250, 200, 200)).toBe("process");
    expect(decideBudgetGate(201, 200, 200)).toBe("process");
  });
});
