/**
 * Offset→Range mapping (highlight.ts): the find offsets are computed
 * over concatenated item text, the DOM splits the same text across
 * span-wrapped text nodes — the mapping must agree at every boundary.
 * jsdom has no CSS Custom Highlight API, which itself proves the
 * capability guard (applyFindHighlights must be a safe no-op here).
 */

import { describe, expect, it } from "vitest";
import { applyFindHighlights, rangeForMatch } from "../highlight.js";

/** A TextLayer-shaped container: one span per text item. */
function makeContainer(items: readonly string[]): HTMLElement {
  const container = document.createElement("div");
  for (const item of items) {
    const span = document.createElement("span");
    span.textContent = item;
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

describe("applyFindHighlights", () => {
  it("is a safe no-op where the CSS Custom Highlight API is absent (jsdom)", () => {
    const container = makeContainer(["anything"]);
    expect(() =>
      applyFindHighlights(new Map([[1, container]]), [{ page: 1, start: 0, end: 3 }], 0),
    ).not.toThrow();
  });
});
