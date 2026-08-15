/**
 * Snippet windowing for document search results (FR-DOC-004). The
 * Search RPC returns whole pages by contract — "snippet windows are
 * presentation and belong to the surface rendering them" (the
 * DocumentPage proto) — so this surface windows its own.
 *
 * Structured parts, not a flat string: the results list highlights the
 * matched text (<mark>), so the window comes back as prefix/match/
 * suffix. The assistant's backend sibling renders a flat line for the
 * model instead — same concept, different presentation shape, which is
 * exactly why the proto assigns ownership per surface. Extraction seam:
 * grapheme-safe windowing is business-agnostic — a commons candidate
 * when a second consumer wants it.
 *
 * Unicode obligations (stigmer-apps#2, same as the backend sibling):
 * the match is located with a case-insensitive Unicode RegExp (indexes
 * into the ORIGINAL string — folding can change lengths), and window
 * edges snap OUTWARD to grapheme boundaries so a Telugu base+matra or
 * a ZWJ emoji is never split into a mangled or misquoted cluster.
 */

/** Characters of context either side of the match. Deliberately
 * tighter than the assistant's 120: a results list shows several hits
 * at once, and a row should read in a glance, not a paragraph. */
const SNIPPET_WINDOW = 80;

// Locale-free on purpose: grapheme boundaries are script-intrinsic.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Widens [start, end) to the nearest enclosing grapheme boundaries. */
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

/**
 * Clips text to at most `max` UTF-16 units WITHOUT splitting a
 * grapheme cluster (the same #2 obligation as the window edges): an
 * over-long capture stores an honest prefix — never a mangled Telugu
 * base+matra at the cut. Snaps INWARD (unlike the window helper, which
 * widens): the result must fit the bound, so the straddling cluster is
 * dropped whole. Used by mark creation to fit quoted text into its
 * proto bound.
 */
export function clipGraphemeSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = 0;
  for (const { index } of graphemes.segment(text)) {
    if (index > max) break;
    cut = index;
  }
  return text.slice(0, cut);
}

export interface SnippetParts {
  /** Context before the match, ellipsized when the page continues. */
  readonly prefix: string;
  /** The highlighted passage AS THE PAGE CARRIES IT (original casing),
   * widened to whole graphemes — a query hitting only the base of a
   * base+matra pair must mark the whole rendered character, never half
   * of one. Empty when the match could not be located locally. */
  readonly match: string;
  /** Context after the match, ellipsized when the page continues. */
  readonly suffix: string;
}

/** Windows the first match of `query` in `text` for highlighting. When
 * the server matched but local folding disagrees (exotic case pairs),
 * answers the page head with no highlight rather than nothing. */
export function snippetParts(text: string, query: string): SnippetParts {
  const found = new RegExp(escapeRegExp(query), "iu").exec(text);
  if (!found) {
    const head = snapToGraphemeBoundaries(
      text,
      0,
      Math.min(text.length, SNIPPET_WINDOW * 2),
    );
    return {
      prefix: text.slice(0, head.end) + (head.end < text.length ? "…" : ""),
      match: "",
      suffix: "",
    };
  }
  // The highlight range itself snaps outward first (whole rendered
  // characters); the context window is measured from the WIDENED range
  // so prefix/match/suffix stay contiguous.
  const match = snapToGraphemeBoundaries(text, found.index, found.index + found[0].length);
  const window = snapToGraphemeBoundaries(
    text,
    Math.max(0, match.start - SNIPPET_WINDOW),
    Math.min(text.length, match.end + SNIPPET_WINDOW),
  );
  return {
    prefix: (window.start > 0 ? "…" : "") + text.slice(window.start, match.start).trimStart(),
    match: text.slice(match.start, match.end),
    suffix: text.slice(match.end, window.end).trimEnd() + (window.end < text.length ? "…" : ""),
  };
}
