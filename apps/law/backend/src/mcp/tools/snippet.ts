/**
 * Snippet windowing for search hits (FR-DOC-004): the first match with
 * context either side, ellipsized — the passage a person checks before
 * opening the page.
 *
 * Two Unicode obligations the naive slice gets wrong (issue #2):
 *
 * 1. MATCH LOCATION. `text.toLowerCase().indexOf(query.toLowerCase())`
 *    indexes into the FOLDED string, whose length can differ from the
 *    original's (İ lowers to i + combining dot), silently shifting the
 *    window. A case-insensitive Unicode RegExp reports positions in the
 *    original string.
 * 2. WINDOW EDGES. `slice` counts UTF-16 code units, but what a reader
 *    sees are grapheme clusters (a Telugu base consonant + matra, a
 *    ZWJ emoji). An edge landing inside a cluster orphans a combining
 *    mark (renders mangled) or truncates a syllable into a DIFFERENT
 *    one — a misquote in a legal document. Edges snap OUTWARD to the
 *    nearest grapheme boundary, so the window only ever grows.
 *
 * App-local by the DocumentPage proto's contract ("snippet windows are
 * presentation and belong to the surface rendering them"); the web's
 * search rendering has its own presentation-shaped sibling. Extraction
 * seam: grapheme-safe windowing is business-agnostic — a commons
 * candidate when vertical #2 needs it.
 */

/** Characters of context either side of the first match. */
const SNIPPET_WINDOW = 120;

// Locale-free on purpose: grapheme boundaries are script-intrinsic, and
// the page store holds every language a firm files in.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Escapes RegExp metacharacters so the query matches literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Widens [start, end) to the nearest enclosing grapheme boundaries.
 * Boundaries are segment starts plus the end of the string; one forward
 * pass, stopping at the first boundary at-or-past `end`.
 */
function snapToGraphemeBoundaries(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let snappedStart = 0;
  let snappedEnd = text.length;
  for (const { index } of graphemes.segment(text)) {
    if (index <= start) snappedStart = index;
    if (index >= end) {
      snappedEnd = index;
      break;
    }
  }
  return { start: snappedStart, end: snappedEnd };
}

/** The first match with context either side, ellipsized — grapheme-safe
 * at both window edges. */
export function snippetAround(text: string, query: string): string {
  const match = new RegExp(escapeRegExp(query), "iu").exec(text);
  if (!match) {
    // Defensive: the store matched, so this should not happen (the
    // store's ICU folding and the RegExp's can disagree on exotic
    // case pairs); show the page head rather than nothing.
    const head = snapToGraphemeBoundaries(
      text,
      0,
      Math.min(text.length, SNIPPET_WINDOW * 2),
    );
    return text.slice(0, head.end) + (head.end < text.length ? "…" : "");
  }
  const { start, end } = snapToGraphemeBoundaries(
    text,
    Math.max(0, match.index - SNIPPET_WINDOW),
    Math.min(text.length, match.index + match[0].length + SNIPPET_WINDOW),
  );
  return (
    (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "")
  );
}
