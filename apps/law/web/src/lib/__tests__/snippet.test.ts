/**
 * snippetParts: the search result's structured passage — prefix, the
 * highlighted match, suffix — with every boundary (window edges AND the
 * highlight range) on whole graphemes.
 */

import { describe, expect, it } from "vitest";
import { snippetParts } from "../snippet.js";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([text.length]);
  for (const { index } of SEGMENTER.segment(text)) boundaries.add(index);
  return boundaries;
}

describe("snippetParts", () => {
  it("windows the match with context and ellipses on both clipped sides", () => {
    const text = `${"a".repeat(200)} the limitation period expired ${"b".repeat(200)}`;
    const { prefix, match, suffix } = snippetParts(text, "limitation");

    expect(match).toBe("limitation");
    expect(prefix.startsWith("…")).toBe(true);
    expect(suffix.endsWith("…")).toBe(true);
    // Reassembled, the parts are a verbatim passage of the page.
    const passage = (prefix + match + suffix).replace(/^…/, "").replace(/…$/, "");
    expect(text).toContain(passage);
  });

  it("matches case-insensitively beyond ASCII and highlights the page's own casing", () => {
    const text = "Certified copy of the RÉSUMÉ OF ARGUMENTS follows.";
    const { match } = snippetParts(text, "résumé");
    expect(match).toBe("RÉSUMÉ");
  });

  it("keeps window edges on grapheme boundaries in an Indic script", () => {
    // 2-code-unit clusters with a 1-unit lead force raw ±80 edges
    // mid-cluster.
    const padding = "మై".repeat(120);
    const text = `క${padding} కేసు ${padding}`;
    const { prefix, match, suffix } = snippetParts(text, "కేసు");

    expect(match).toBe("కేసు");
    const passage = (prefix + match + suffix).replace(/^…/, "").replace(/…$/, "");
    const at = text.indexOf(passage);
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.has(at)).toBe(true);
    expect(boundaries.has(at + passage.length)).toBe(true);
    // The visible defect: a snippet opening on an orphaned matra.
    expect(/^\p{M}/u.test(prefix)).toBe(false);
  });

  it("widens a partial-cluster match to the whole character a reader sees", () => {
    // The query hits only the BASE of a base+matra pair; highlighting
    // half a rendered character would mark visual nonsense.
    const text = "పాత కేసు జాబితా";
    const { match } = snippetParts(text, "కేస");
    expect(match).toBe("కేసు");
  });

  it("keeps a ZWJ emoji sequence whole at a window edge", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `${"x".repeat(75)}${family}${"y".repeat(75)}needle`;
    const { prefix } = snippetParts(text, "needle");
    // The raw window start lands inside the ZWJ sequence; outward
    // snapping keeps it whole.
    expect(prefix).toContain(family);
  });

  it("falls back to the page head with no highlight when the match cannot be located", () => {
    const text = `క${"మై".repeat(120)}`;
    const { prefix, match, suffix } = snippetParts(text, "zzz");

    expect(match).toBe("");
    expect(suffix).toBe("");
    expect(prefix.endsWith("…")).toBe(true);
    // Head clip still lands on a grapheme boundary.
    const head = prefix.replace(/…$/, "");
    expect(graphemeBoundaries(text).has(head.length)).toBe(true);
  });

  it("treats regex metacharacters in the query as literal text", () => {
    const text = "computed under section 1+1 of the schedule";
    const { match } = snippetParts(text, "1+1");
    expect(match).toBe("1+1");
  });
});
