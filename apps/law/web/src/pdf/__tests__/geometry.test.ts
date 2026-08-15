/**
 * The reader's layout math (geometry.ts): pure functions, probed at
 * the edges the scroller will actually hit — empty docs, zero-height
 * viewports (jsdom's reality), scroll positions past the end during a
 * re-layout, and mixed page sizes.
 */

import { describe, expect, it } from "vitest";
import {
  computeLayout,
  currentPage,
  PAGE_GAP,
  scrollOffsetForPage,
  scrollOffsetForRect,
  visiblePageRange,
} from "../geometry.js";

const LETTER = { width: 612, height: 792 };

describe("computeLayout", () => {
  it("stacks pages with the gap and scales them", () => {
    const layout = computeLayout([LETTER, LETTER], 2);
    expect(layout.pages[0]).toEqual({ top: PAGE_GAP, height: 1584, width: 1224 });
    expect(layout.pages[1]?.top).toBe(PAGE_GAP + 1584 + PAGE_GAP);
    expect(layout.totalHeight).toBe(PAGE_GAP + (1584 + PAGE_GAP) * 2);
  });

  it("handles mixed page sizes without drift", () => {
    const layout = computeLayout([LETTER, { width: 1000, height: 100 }, LETTER], 1);
    expect(layout.pages[2]?.top).toBe(PAGE_GAP + 792 + PAGE_GAP + 100 + PAGE_GAP);
  });

  it("an empty document yields an empty layout, not a crash", () => {
    const layout = computeLayout([], 1);
    expect(layout.pages).toEqual([]);
    expect(layout.totalHeight).toBe(PAGE_GAP);
  });
});

describe("visiblePageRange", () => {
  const layout = computeLayout(Array.from({ length: 10 }, () => LETTER), 1);

  it("returns the intersecting pages plus overscan, clamped to the document", () => {
    // Viewport over pages 1–2.
    expect(visiblePageRange(layout, 0, 900, 2)).toEqual({ first: 1, last: 4 });
    // Deep in the middle: a 792px viewport starting exactly at page
    // 5's top shows page 5 alone (page 6 begins after the gap), so
    // overscan 1 mounts 4–6.
    const page5Top = layout.pages[4]!.top;
    expect(visiblePageRange(layout, page5Top, 792, 1)).toEqual({ first: 4, last: 6 });
  });

  it("zero viewport height (jsdom) still anchors on the page at scrollTop", () => {
    const page7Top = layout.pages[6]!.top;
    expect(visiblePageRange(layout, page7Top, 0, 0)).toEqual({ first: 7, last: 7 });
  });

  it("a scroll position past the end (mid-re-layout) clamps to the last page", () => {
    expect(visiblePageRange(layout, layout.totalHeight + 5000, 800, 1)).toEqual({
      first: 9,
      last: 10,
    });
  });

  it("an empty layout answers an empty range", () => {
    expect(visiblePageRange(computeLayout([], 1), 0, 800, 2)).toEqual({ first: 1, last: 0 });
  });
});

describe("currentPage", () => {
  const layout = computeLayout(Array.from({ length: 5 }, () => LETTER), 1);

  it("is the page under the reading line (35% down the viewport)", () => {
    expect(currentPage(layout, 0, 800)).toBe(1);
    // Scrolled so page 3's band contains the reading line.
    const page3Top = layout.pages[2]!.top;
    expect(currentPage(layout, page3Top, 800)).toBe(3);
  });

  it("degrades to the page at scrollTop when viewport height is unknown", () => {
    const page4Top = layout.pages[3]!.top;
    expect(currentPage(layout, page4Top, 0)).toBe(4);
  });

  it("clamps to the last page beyond the end", () => {
    expect(currentPage(layout, layout.totalHeight + 100, 800)).toBe(5);
  });
});

describe("scrollOffsetForPage", () => {
  const layout = computeLayout(Array.from({ length: 3 }, () => LETTER), 1);

  it("round-trips with currentPage: scrolling to page n reads as page n", () => {
    for (const page of [1, 2, 3]) {
      expect(currentPage(layout, scrollOffsetForPage(layout, page), 800)).toBe(page);
    }
  });

  it("page 1 lands at the very top, not a negative offset", () => {
    expect(scrollOffsetForPage(layout, 1)).toBe(0);
  });

  it("an out-of-range page answers 0 rather than NaN", () => {
    expect(scrollOffsetForPage(layout, 99)).toBe(0);
  });
});

describe("scrollOffsetForRect", () => {
  const layout = computeLayout(Array.from({ length: 3 }, () => LETTER), 1);

  it("puts the rect's top at the 35% reading line", () => {
    const page2 = layout.pages[1]!;
    const offset = scrollOffsetForRect(layout, 2, 0.4, 800);
    expect(offset).toBe(page2.top + 0.4 * page2.height - 800 * 0.35);
    // The landing agrees with the indicator: the reading line sits on
    // the target page — a jump must never read as a neighbor.
    expect(currentPage(layout, offset, 800)).toBe(2);
  });

  it("degrades to rect-at-viewport-top when the viewport height is unknown (jsdom)", () => {
    const page2 = layout.pages[1]!;
    expect(scrollOffsetForRect(layout, 2, 0.4, 0)).toBe(page2.top + 0.4 * page2.height);
  });

  it("a rect near the top of page 1 clamps to 0, never a negative offset", () => {
    expect(scrollOffsetForRect(layout, 1, 0, 800)).toBe(0);
  });

  it("an out-of-range page answers 0 rather than NaN", () => {
    expect(scrollOffsetForRect(layout, 99, 0.5, 800)).toBe(0);
  });
});
