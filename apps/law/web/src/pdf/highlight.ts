/**
 * Find-match highlighting via the CSS Custom Highlight API: DOM Ranges
 * over the TextLayer's text nodes, registered under two highlight
 * names (all matches / the current one) and styled in pdf.css. Chosen
 * over span-splitting because Ranges cross element boundaries for free
 * (a phrase spanning two positioned runs is one Range, two rects) and
 * the TextLayer DOM is never mutated — pdfjs owns it.
 *
 * Offsets arrive from find.ts over the page's concatenated item text,
 * which is byte-for-byte the text-node content of the TextLayer
 * container (find.ts's header records that identity) — so mapping an
 * offset to (node, nodeOffset) is a single cumulative walk.
 *
 * Browsers without the API (and jsdom) simply get no visual highlight:
 * find still counts and navigates. The capability guard is here, in
 * one place.
 */

import type { PageMatch } from "./find.js";

export const FIND_HIGHLIGHT = "law-pdf-find";
export const FIND_CURRENT_HIGHLIGHT = "law-pdf-find-current";

function textNodesOf(container: Element): Text[] {
  const nodes: Text[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** Maps one match's [start, end) to a DOM Range over the container's
 * text nodes; null when offsets fall outside the rendered text. */
export function rangeForMatch(
  container: Element,
  match: { readonly start: number; readonly end: number },
): Range | null {
  const range = container.ownerDocument.createRange();
  let consumed = 0;
  let startSet = false;
  for (const node of textNodesOf(container)) {
    const length = node.data.length;
    if (!startSet && match.start < consumed + length) {
      range.setStart(node, match.start - consumed);
      startSet = true;
    }
    if (startSet && match.end <= consumed + length) {
      range.setEnd(node, match.end - consumed);
      return range;
    }
    consumed += length;
  }
  return null;
}

/**
 * Rebuilds both highlight registrations from the matches whose pages
 * currently have a rendered text layer. Called whenever matches, the
 * current match, or the set of rendered pages changes — a full rebuild
 * is simpler than diffing and cheap at find-result scale.
 */
export function applyFindHighlights(
  textLayers: ReadonlyMap<number, Element>,
  matches: readonly PageMatch[],
  currentIndex: number,
): void {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return;
  }
  const all: Range[] = [];
  const current: Range[] = [];
  for (const [index, match] of matches.entries()) {
    const container = textLayers.get(match.page);
    if (!container) continue;
    const range = rangeForMatch(container, match);
    if (!range) continue;
    (index === currentIndex ? current : all).push(range);
  }
  CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all));
  CSS.highlights.set(FIND_CURRENT_HIGHLIGHT, new Highlight(...current));
}

/** Removes both registrations — the viewer is closing or find is. */
export function clearFindHighlights(): void {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete(FIND_HIGHLIGHT);
  CSS.highlights.delete(FIND_CURRENT_HIGHLIGHT);
}
