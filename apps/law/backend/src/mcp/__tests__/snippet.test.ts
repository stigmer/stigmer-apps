/**
 * snippetAround (issue #2): windows must open and close on grapheme
 * boundaries — never inside an Indic base+matra pair or a ZWJ emoji
 * sequence — while pure-Latin snippets stay byte-identical to the
 * code-unit predecessor.
 */

import { describe, expect, it } from "vitest";
import { snippetAround } from "../tools/snippet.js";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Every valid cut point of `text`: each cluster start plus the end. */
function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([text.length]);
  for (const { index } of SEGMENTER.segment(text)) boundaries.add(index);
  return boundaries;
}

/** Strips the ellipses the module adds (never part of the source text). */
function core(snippet: string): string {
  return snippet.replace(/^…/, "").replace(/…$/, "");
}

/** Asserts the snippet is a whole-grapheme window of `text`. */
function expectGraphemeAligned(snippet: string, text: string): void {
  const inner = core(snippet);
  const at = text.indexOf(inner);
  expect(at, `snippet not found verbatim in source: "${inner}"`).toBeGreaterThanOrEqual(0);
  const boundaries = graphemeBoundaries(text);
  expect(boundaries.has(at), "snippet starts inside a grapheme cluster").toBe(true);
  expect(
    boundaries.has(at + inner.length),
    "snippet ends inside a grapheme cluster",
  ).toBe(true);
}

/** The predecessor's algorithm, verbatim — the Latin-parity reference. */
function legacySnippet(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - 120);
  const end = Math.min(text.length, at + query.length + 120);
  return (
    (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "")
  );
}

describe("snippetAround", () => {
  it("keeps ASCII snippets byte-identical to the code-unit predecessor", () => {
    const body =
      `The suit is barred by limitation under Article 113. ` +
      `${"lorem ipsum ".repeat(30)}the limitation period expired ${"dolor sit ".repeat(30)}end.`;
    for (const query of ["limitation", "The suit", "end."]) {
      expect(snippetAround(body, query)).toBe(legacySnippet(body, query));
    }
  });

  it("returns a short page whole, no ellipses", () => {
    expect(snippetAround("hello world", "world")).toBe("hello world");
  });

  it("never splits an Indic base+matra cluster at either window edge", () => {
    // "మై" is one grapheme of 2 code units; the 1-unit lead ("క")
    // forces both ±120 edges to land mid-cluster.
    const padding = "మై".repeat(150);
    const text = `క${padding} కేసు ${padding}`;
    const snippet = snippetAround(text, "కేసు");

    expect(core(snippet)).toContain("కేసు");
    expectGraphemeAligned(snippet, text);
    // The user-visible defect this fixes: an orphaned combining mark
    // opening the snippet.
    expect(/^\p{M}/u.test(core(snippet))).toBe(false);
  });

  it("keeps a ZWJ emoji sequence whole when the edge lands inside it", () => {
    const family = "👨‍👩‍👧‍👦"; // 7 code points, 11 code units, ONE grapheme
    const text = `${"x".repeat(115)}${family}${"y".repeat(115)}needle`;
    const snippet = snippetAround(text, "needle");

    // The raw window start (match − 120) lands between the ZWJ joins;
    // outward snapping must keep the whole sequence.
    expect(core(snippet)).toContain(family);
    expectGraphemeAligned(snippet, text);
  });

  it("locates the match case-insensitively beyond ASCII", () => {
    const text = `${"a".repeat(300)} the résumé of arguments follows`;
    const snippet = snippetAround(text, "RÉSUMÉ");

    expect(core(snippet)).toContain("résumé");
    // Windowed around the located match — not the head fallback.
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("treats regex metacharacters in the query as literal text", () => {
    // Unescaped, /1+1/ requires "11" and would MISS this text entirely,
    // collapsing to the head fallback.
    const text = `${"z".repeat(300)} computed under section 1+1 of the schedule`;
    const snippet = snippetAround(text, "1+1");

    expect(core(snippet)).toContain("section 1+1");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("falls back to a grapheme-aligned page head when the match cannot be located", () => {
    // Defensive path: the store matched but local folding disagrees.
    const text = `క${"మై".repeat(200)}`;
    const snippet = snippetAround(text, "zzz");

    expect(snippet.endsWith("…")).toBe(true);
    expectGraphemeAligned(snippet, text);
  });
});
