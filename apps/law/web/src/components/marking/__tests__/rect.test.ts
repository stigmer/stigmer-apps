/**
 * The anchoring model's math (DD-010): normalization against the
 * intrinsic box is what makes anchors zoom- and DPR-independent — the
 * round-trip test proves a mark captured at one zoom renders on the
 * same glyphs at any other.
 */

import { describe, expect, it } from "vitest";
import { clampToUnitBox, normalizeToBox } from "../rect.js";

describe("clampToUnitBox", () => {
  it("keeps an in-bounds rect (up to float re-derivation of the edges)", () => {
    const rect = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
    const clamped = clampToUnitBox(rect);
    expect(clamped?.left).toBe(0.1);
    expect(clamped?.top).toBe(0.2);
    expect(clamped?.width).toBeCloseTo(0.3, 12);
    expect(clamped?.height).toBeCloseTo(0.4, 12);
  });

  it("clips an overflowing rect to the page rather than saving out-of-page coordinates", () => {
    expect(clampToUnitBox({ left: 0.8, top: -0.1, width: 0.5, height: 0.3 })).toEqual({
      left: 0.8,
      top: 0,
      width: expect.closeTo(0.2, 10) as number,
      height: expect.closeTo(0.2, 10) as number,
    });
  });

  it("drops a rect entirely outside the page", () => {
    expect(clampToUnitBox({ left: 1.2, top: 0.5, width: 0.3, height: 0.1 })).toBeUndefined();
  });

  it("drops a zero-area rect — a mark that marks nothing", () => {
    expect(clampToUnitBox({ left: 0.5, top: 0.5, width: 0, height: 0.1 })).toBeUndefined();
  });
});

describe("normalizeToBox (screen → normalized → screen at another zoom)", () => {
  it("round-trips across zoom levels: the anchor is scale-free", () => {
    // The same selection on the same page, seen at two zooms. The page
    // box is intrinsic-size × scale; the selection scales with it.
    const intrinsic = { width: 612, height: 792 };
    const screenRectAt = (scale: number) => ({
      left: 100 + 61.2 * scale,
      top: 200 + 79.2 * scale,
      width: 306 * scale,
      height: 15.84 * scale,
    });
    const boxAt = (scale: number) => ({
      left: 100,
      top: 200,
      width: intrinsic.width * scale,
      height: intrinsic.height * scale,
    });

    const atFit = normalizeToBox(screenRectAt(0.8), boxAt(0.8));
    const atZoomed = normalizeToBox(screenRectAt(2), boxAt(2));
    expect(atFit).toBeDefined();
    expect(atZoomed).toBeDefined();
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(atFit?.[key]).toBeCloseTo(atZoomed?.[key] ?? NaN, 10);
      // And rendering is pure percentage: normalized × box = screen.
      expect((atFit?.[key] ?? NaN) * (key === "left" || key === "width" ? 612 : 792) * 2).toBeCloseTo(
        key === "left"
          ? screenRectAt(2).left - 100
          : key === "top"
            ? screenRectAt(2).top - 200
            : screenRectAt(2)[key],
        6,
      );
    }
  });

  it("refuses a degenerate box (nothing to normalize against)", () => {
    expect(
      normalizeToBox({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 10 }),
    ).toBeUndefined();
  });
});
