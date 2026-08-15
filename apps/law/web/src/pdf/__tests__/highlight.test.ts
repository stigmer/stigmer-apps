/**
 * Offset→Range mapping (highlight.ts): the find offsets are computed
 * over concatenated item text, the DOM splits the same text across
 * span-wrapped text nodes — the mapping must agree at every boundary.
 * jsdom has no CSS Custom Highlight API, which itself proves the
 * capability guard (applyFindHighlights must be a safe no-op here).
 *
 * The aligned suite pins the geometry contract: exact highlights only
 * where the run's --scale-x says the browser font reproduced the
 * embedded font's widths; divergent runs widen to the full run box
 * (the live-measured Telugu case: --scale-x 0.456).
 */

import { describe, expect, it } from "vitest";
import { alignedRangeForMatch, applyFindHighlights, rangeForMatch } from "../highlight.js";

/** A TextLayer-shaped container: one span per text item, optionally
 * carrying the per-span --scale-x pdfjs writes. */
function makeContainer(items: readonly (string | { text: string; scaleX: number })[]): HTMLElement {
  const container = document.createElement("div");
  for (const item of items) {
    const span = document.createElement("span");
    if (typeof item === "string") {
      span.textContent = item;
    } else {
      span.textContent = item.text;
      span.style.setProperty("--scale-x", String(item.scaleX));
    }
    container.append(span);
  }
  return container;
}

describe("rangeForMatch", () => {
  it("maps a match inside one text node", () => {
    const container = makeContainer(["next hearing date"]);
    const range = rangeForMatch(container, { start: 5, end: 12 });
    expect(range?.toString()).toBe("hearing");
  });

  it("maps a match spanning two spans (the pdfjs item boundary case)", () => {
    const container = makeContainer(["next hea", "ring date"]);
    const range = rangeForMatch(container, { start: 5, end: 12 });
    expect(range?.toString()).toBe("hearing");
  });

  it("maps a match that IS an entire middle span, boundaries exact", () => {
    const container = makeContainer(["ab", "cd", "ef"]);
    const range = rangeForMatch(container, { start: 2, end: 4 });
    expect(range?.toString()).toBe("cd");
  });

  it("maps Telugu offsets across a span boundary without splitting a cluster", () => {
    const container = makeContainer(["తదుపరి వా", "యిదా తేదీ"]);
    const text = "తదుపరి వాయిదా తేదీ";
    const start = text.indexOf("వాయిదా");
    const range = rangeForMatch(container, { start, end: start + "వాయిదా".length });
    expect(range?.toString()).toBe("వాయిదా");
  });

  it("offsets beyond the rendered text answer null, never a broken Range", () => {
    const container = makeContainer(["short"]);
    expect(rangeForMatch(container, { start: 3, end: 99 })).toBeNull();
    expect(rangeForMatch(container, { start: 99, end: 104 })).toBeNull();
  });
});

describe("alignedRangeForMatch (the geometry contract)", () => {
  it("stays exact when the run declares no --scale-x (the CSS default is 1)", () => {
    const container = makeContainer(["next hearing date"]);
    const range = alignedRangeForMatch(container, { start: 5, end: 12 });
    expect(range?.toString()).toBe("hearing");
  });

  it("stays exact within tolerance (the live-measured Latin case, 1.004)", () => {
    const container = makeContainer([{ text: "next hearing date", scaleX: 1.004 }]);
    const range = alignedRangeForMatch(container, { start: 5, end: 12 });
    expect(range?.toString()).toBe("hearing");
  });

  it("widens to the full run when the run diverges (the live-measured Telugu case, 0.456)", () => {
    const line = "తదుపరి విచారణ తేదీ 2026 సెప్టెంబర్ 2కి వాయిదా వేయబడింది.";
    const container = makeContainer([{ text: line, scaleX: 0.456 }]);
    const start = line.indexOf("వాయిదా");
    const range = alignedRangeForMatch(container, { start, end: start + "వాయిదా".length });
    expect(range?.toString()).toBe(line);
  });

  it("widens across every touched run when ANY of them diverges", () => {
    const container = makeContainer([
      { text: "faithful start ", scaleX: 1.0 },
      { text: "దివర్జెంట్ రన్", scaleX: 0.5 },
    ]);
    // A phrase match spanning both runs: "start దివ..."
    const range = alignedRangeForMatch(container, { start: 9, end: 18 });
    expect(range?.toString()).toBe("faithful start దివర్జెంట్ రన్");
  });

  it("answers null for out-of-text offsets exactly like the exact path", () => {
    const container = makeContainer([{ text: "short", scaleX: 0.5 }]);
    expect(alignedRangeForMatch(container, { start: 99, end: 104 })).toBeNull();
  });
});

describe("applyFindHighlights", () => {
  it("is a safe no-op where the CSS Custom Highlight API is absent (jsdom)", () => {
    const container = makeContainer(["anything"]);
    expect(() =>
      applyFindHighlights(new Map([[1, container]]), [{ page: 1, start: 0, end: 3 }], 0),
    ).not.toThrow();
  });
});
