/**
 * Selection capture (DD-010): the per-line merge, the normalization,
 * the overflow collapse, and captureSelection's page discipline —
 * cross-page selections refused, single-page selections captured with
 * whitespace-collapsed text. jsdom computes no layout, so client rects
 * and boxes are hand-built; the REAL selection geometry is Playwright's
 * assertion (the session-21 lesson).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  captureSelection,
  MAX_CAPTURE_RECTS,
  mergeRectsPerLine,
  normalizeLineRects,
} from "../selection.js";

const PAGE_BOX = { left: 100, top: 50, width: 612, height: 792 };

describe("mergeRectsPerLine", () => {
  it("merges fragments sharing a visual line into one rect", () => {
    // Two spans on one line (differently styled), slight vertical jitter.
    const merged = mergeRectsPerLine([
      { left: 10, top: 100, width: 80, height: 14 },
      { left: 92, top: 101, width: 60, height: 13 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ left: 10, top: 100, width: 142, height: 14 });
  });

  it("keeps separate lines separate", () => {
    const merged = mergeRectsPerLine([
      { left: 10, top: 100, width: 200, height: 14 },
      { left: 10, top: 118, width: 150, height: 14 },
      { left: 10, top: 136, width: 90, height: 14 },
    ]);
    expect(merged).toHaveLength(3);
  });

  it("drops degenerate fragments (collapsed carets, zero-width spans)", () => {
    const merged = mergeRectsPerLine([
      { left: 10, top: 100, width: 0.4, height: 14 },
      { left: 10, top: 118, width: 150, height: 14 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.top).toBe(118);
  });
});

describe("normalizeLineRects", () => {
  it("normalizes each line against the page box", () => {
    const rects = normalizeLineRects([{ left: 253, top: 248, width: 306, height: 15.84 }], PAGE_BOX);
    expect(rects).toHaveLength(1);
    expect(rects[0]?.left).toBeCloseTo((253 - 100) / 612, 10);
    expect(rects[0]?.top).toBeCloseTo((248 - 50) / 792, 10);
    expect(rects[0]?.width).toBeCloseTo(306 / 612, 10);
    expect(rects[0]?.height).toBeCloseTo(15.84 / 792, 10);
  });

  it("collapses an over-long line list to one bounding box (the bounded contract)", () => {
    const lines = Array.from({ length: MAX_CAPTURE_RECTS + 5 }, (_, i) => ({
      left: 110,
      top: 60 + i * 11,
      width: 500,
      height: 10,
    }));
    const rects = normalizeLineRects(lines, PAGE_BOX);
    expect(rects).toHaveLength(1);
    // The bounding box spans first line's top to last line's bottom.
    expect(rects[0]?.top).toBeCloseTo(10 / 792, 10);
    expect(rects[0]?.height).toBeCloseTo((lines.length * 11 - 1) / 792, 10);
  });
});

describe("captureSelection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** Builds the reader's page DOM shape: [data-page-number] band →
   * .law-pdf-page box → text layer text node. Returns the text node. */
  function makePage(page: number): { pageBox: HTMLElement; textNode: Text } {
    const band = document.createElement("div");
    band.setAttribute("data-page-number", String(page));
    const pageBox = document.createElement("div");
    pageBox.className = "law-pdf-page";
    pageBox.getBoundingClientRect = () => ({ ...PAGE_BOX, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    const textLayer = document.createElement("div");
    const textNode = document.createTextNode("The suit is barred   by limitation.");
    textLayer.appendChild(textNode);
    pageBox.appendChild(textLayer);
    band.appendChild(pageBox);
    document.body.appendChild(band);
    return { pageBox, textNode };
  }

  function fakeSelection(range: Partial<Range> & { startContainer: Node; endContainer: Node }, text: string) {
    return {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range as Range,
      toString: () => text,
    } as unknown as Selection;
  }

  it("captures page, per-line rects, collapsed text, and an anchor", () => {
    const { textNode } = makePage(3);
    const selection = fakeSelection(
      {
        startContainer: textNode,
        endContainer: textNode,
        getClientRects: () =>
          [
            { left: 253, top: 248, width: 100, height: 15 },
            { left: 355, top: 249, width: 80, height: 14 },
          ] as unknown as DOMRectList,
      },
      "The suit is barred   by limitation.",
    );

    const result = captureSelection(selection);
    expect(result?.kind).toBe("captured");
    if (result?.kind !== "captured") return;
    expect(result.page).toBe(3);
    expect(result.rects).toHaveLength(1); // one visual line
    expect(result.text).toBe("The suit is barred by limitation.");
    expect(result.anchor.left).toBeCloseTo(result.rects[0]!.left + result.rects[0]!.width, 10);
  });

  it("refuses a cross-page selection honestly, never silently splitting", () => {
    const pageA = makePage(1);
    const pageB = makePage(2);
    const selection = fakeSelection(
      {
        startContainer: pageA.textNode,
        endContainer: pageB.textNode,
        getClientRects: () => [] as unknown as DOMRectList,
      },
      "spans two pages",
    );
    expect(captureSelection(selection)).toEqual({ kind: "cross-page" });
  });

  it("answers undefined for no selection, a collapsed one, or one outside a page", () => {
    expect(captureSelection(null)).toBeUndefined();
    expect(
      captureSelection({ isCollapsed: true, rangeCount: 1 } as unknown as Selection),
    ).toBeUndefined();

    const orphan = document.createTextNode("not in a page");
    document.body.appendChild(orphan.ownerDocument.createElement("div")).appendChild(orphan);
    const selection = fakeSelection(
      {
        startContainer: orphan,
        endContainer: orphan,
        getClientRects: () => [] as unknown as DOMRectList,
      },
      "not in a page",
    );
    expect(captureSelection(selection)).toBeUndefined();
  });
});
