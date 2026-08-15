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
 * THE GEOMETRY CONTRACT (two modes, decided per match):
 *
 * A DOM Range paints where the BROWSER's font lays those characters
 * out; the glyphs the reader sees are painted on canvas from the PDF's
 * EMBEDDED font. pdfjs reconciles the two only at run granularity: it
 * measures each run with the browser font and writes a per-span
 * `--scale-x` so the run's TOTAL width matches the canvas. When the
 * two fonts distribute widths similarly (Latin text: measured live at
 * --scale-x 1.000–1.004), positions INSIDE the run agree and the exact
 * character highlight is correct. When they diverge (a Telugu run
 * measured live at --scale-x 0.456 — the browser font shapes conjuncts
 * at 2.2× the embedded font's widths), intra-run positions are
 * meaningless: an exact-looking highlight paints over the WRONG words.
 *
 * So: a match whose runs are all near --scale-x 1 keeps the exact
 * highlight; any other match widens to the full run box(es), which
 * pdfjs positions canvas-accurately — the highlight then always covers
 * the right text at run granularity and never lies about position.
 * Glyph-exact highlighting on divergent runs would need per-glyph
 * geometry that pdfjs does not expose (getTextContent is per-run) —
 * a recorded deferral, not an oversight.
 *
 * Browsers without the API (and jsdom) simply get no visual highlight:
 * find still counts and navigates. The capability guard is here, in
 * one place.
 */

import type { PageMatch } from "./find.js";

export const FIND_HIGHLIGHT = "law-pdf-find";
export const FIND_CURRENT_HIGHLIGHT = "law-pdf-find-current";

/** How far a run's --scale-x may sit from 1 before intra-run positions
 * are treated as unreliable. Latin runs measure within ~0.005 of 1;
 * the divergent complex-script case measured 0.456 — the gap is wide,
 * so the exact value is not delicate. 2% of a full page-width run is
 * under a character of drift. */
const SCALE_X_TOLERANCE = 0.02;

function textNodesOf(container: Element): Text[] {
  const nodes: Text[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** The run's --scale-x as pdfjs wrote it on the span (absent = 1, the
 * CSS default in pdf.css). */
function scaleXOf(node: Text): number {
  const raw = node.parentElement?.style.getPropertyValue("--scale-x") ?? "";
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 1;
}

/** The exact-offset walk: the match's Range plus every text node it
 * touches (the geometry decision needs the nodes). */
function resolveMatch(
  container: Element,
  match: { readonly start: number; readonly end: number },
): { range: Range; nodes: Text[] } | null {
  const range = container.ownerDocument.createRange();
  const nodes: Text[] = [];
  let consumed = 0;
  let startSet = false;
  for (const node of textNodesOf(container)) {
    const length = node.data.length;
    if (!startSet && match.start < consumed + length) {
      range.setStart(node, match.start - consumed);
      startSet = true;
    }
    if (startSet) nodes.push(node);
    if (startSet && match.end <= consumed + length) {
      range.setEnd(node, match.end - consumed);
      return { range, nodes };
    }
    consumed += length;
  }
  return null;
}

/** Maps one match's [start, end) to a DOM Range over the container's
 * text nodes; null when offsets fall outside the rendered text. Always
 * exact-offset — the geometry decision lives in alignedRangeForMatch. */
export function rangeForMatch(
  container: Element,
  match: { readonly start: number; readonly end: number },
): Range | null {
  return resolveMatch(container, match)?.range ?? null;
}

/**
 * The Range that is SAFE to paint (the header's geometry contract):
 * exact offsets when every touched run's --scale-x is near 1, else the
 * full run box(es) — never an exact-looking highlight at a wrong
 * position.
 */
export function alignedRangeForMatch(
  container: Element,
  match: { readonly start: number; readonly end: number },
): Range | null {
  const resolved = resolveMatch(container, match);
  if (!resolved) return null;
  const faithful = resolved.nodes.every(
    (node) => Math.abs(scaleXOf(node) - 1) <= SCALE_X_TOLERANCE,
  );
  if (faithful) return resolved.range;
  const first = resolved.nodes[0]!;
  const last = resolved.nodes[resolved.nodes.length - 1]!;
  const widened = container.ownerDocument.createRange();
  widened.setStart(first, 0);
  widened.setEnd(last, last.data.length);
  return widened;
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
    const range = alignedRangeForMatch(container, match);
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
