/**
 * The find contract (find.ts): literal, case-insensitive,
 * whitespace-flexible — and offset-identical to the TextLayer DOM.
 * The multilingual cases matter most: session 21's lesson is that
 * ASCII-only fixtures encode ASCII-only assumptions.
 */

import { describe, expect, it } from "vitest";
import { buildPageText, compileFindQuery, findMatchesOnPage } from "../find.js";

describe("buildPageText", () => {
  it("concatenates item strings with NOTHING between them (the DOM identity)", () => {
    expect(buildPageText([{ str: "next " }, { str: "hearing" }])).toBe("next hearing");
    expect(buildPageText([{ str: "next" }, { str: "hearing" }])).toBe("nexthearing");
  });
});

describe("compileFindQuery", () => {
  it("whitespace-only or empty queries compile to null (find stays idle)", () => {
    expect(compileFindQuery("")).toBeNull();
    expect(compileFindQuery("   ")).toBeNull();
  });

  it("escapes regex metacharacters — a query is text, never a pattern", () => {
    const regex = compileFindQuery("CS/2026/041 (mention)");
    expect(regex).not.toBeNull();
    expect(findMatchesOnPage(regex!, 1, "before CS/2026/041 (mention) after")).toHaveLength(1);
    expect(findMatchesOnPage(regex!, 1, "CSX2026X041 XmentionX")).toHaveLength(0);
  });
});

describe("findMatchesOnPage", () => {
  it("matches case-insensitively with correct offsets", () => {
    const regex = compileFindQuery("Hearing")!;
    const matches = findMatchesOnPage(regex, 3, "hearing… next HEARING");
    expect(matches).toEqual([
      { page: 3, start: 0, end: 7 },
      { page: 3, start: 14, end: 21 },
    ]);
  });

  it("query whitespace matches ZERO-or-more text whitespace (pdfjs item boundaries)", () => {
    const regex = compileFindQuery("next hearing")!;
    // A visual space that never made it into the text layer…
    expect(findMatchesOnPage(regex, 1, "thenexthearingdate")).toHaveLength(1);
    // …and one that did, even doubled.
    expect(findMatchesOnPage(regex, 1, "the next  hearing date")).toHaveLength(1);
  });

  it("matches Telugu and Hindi text with correct code-unit offsets", () => {
    const telugu = "తదుపరి వాయిదా తేదీ";
    const matches = findMatchesOnPage(compileFindQuery("వాయిదా")!, 2, telugu);
    expect(matches).toHaveLength(1);
    expect(telugu.slice(matches[0]!.start, matches[0]!.end)).toBe("వాయిదా");

    const hindi = "अगली तारीख नहीं दी गई";
    expect(findMatchesOnPage(compileFindQuery("तारीख")!, 1, hindi)).toHaveLength(1);
  });

  it("finds every occurrence, including back-to-back ones", () => {
    const regex = compileFindQuery("aa")!;
    // Non-overlapping semantics, the native-find convention.
    expect(findMatchesOnPage(regex, 1, "aaaa")).toEqual([
      { page: 1, start: 0, end: 2 },
      { page: 1, start: 2, end: 4 },
    ]);
  });

  it("an absent term answers an empty list, not an error", () => {
    expect(findMatchesOnPage(compileFindQuery("vakalatnama")!, 1, "")).toEqual([]);
  });
});
