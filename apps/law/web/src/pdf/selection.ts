/**
 * Text-selection capture for the reader (DD-010): turns a live DOM
 * Selection over a page's text layer into per-line rects normalized to
 * the page box, plus the selected text. Domain-free like the rest of
 * src/pdf/ — it reports geometry and text; what a consumer does with a
 * capture (an annotation, an excerpt, anything) is not this module's
 * business.
 *
 * Per-line: getClientRects() returns one box per rendered fragment;
 * fragments on the same visual line merge into one rect so a
 * multi-line selection renders as a highlight over the glyphs, never a
 * bounding box over the paragraph (the DD-010 per-line amendment).
 *
 * Single-page by contract: a selection whose ends sit on different
 * pages is reported as "cross-page" so the surface can refuse it with
 * an honest message — never silently split or silently clipped.
 *
 * The pure parts (merge, normalize) are exported for unit tests; only
 * captureSelection touches the DOM (jsdom has no layout, so its
 * integration is Playwright's to prove).
 */

import { clampToUnitBox, normalizeToBox, type MarkRect } from "../components/marking/rect.js";

/** A page has finitely many lines; a selection producing more than
 * this is a whole-page sweep — the capture collapses to its bounding
 * box rather than shipping an unbounded rect list (consumers carry a
 * bounded contract) or failing the capture. */
export const MAX_CAPTURE_RECTS = 64;

export interface SelectionCapture {
  readonly kind: "captured";
  /** 1-based page number, read from the page's data-page-number. */
  readonly page: number;
  /** Per-line rects, normalized to the page box. Never empty. */
  readonly rects: readonly MarkRect[];
  /** The selected text as the DOM carries it, whitespace-collapsed.
   * Length bounding is the CONSUMER's contract, not this module's. */
  readonly text: string;
  /** Where an affordance may anchor, in the page box's normalized
   * space: the end of the selection's last line. */
  readonly anchor: { readonly left: number; readonly top: number };
}

export type SelectionCaptureResult = SelectionCapture | { kind: "cross-page" } | undefined;

interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Two fragments share a visual line when their vertical overlap is at
 * least half the shorter one — tolerant of the sub-pixel jitter between
 * a line's differently-styled spans, strict enough that adjacent lines
 * (which at most touch) never merge. */
function sameLine(a: ScreenRect, b: ScreenRect): boolean {
  const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlap >= Math.min(a.height, b.height) / 2;
}

/** Merges fragment rects (document order, as getClientRects yields
 * them) into one rect per visual line; drops degenerate fragments. */
export function mergeRectsPerLine(fragments: readonly ScreenRect[]): ScreenRect[] {
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const fragment of fragments) {
    if (fragment.width < 1 || fragment.height < 1) continue;
    const current = lines[lines.length - 1];
    if (
      current &&
      sameLine(
        { left: current.left, top: current.top, width: 1, height: current.bottom - current.top },
        fragment,
      )
    ) {
      current.left = Math.min(current.left, fragment.left);
      current.right = Math.max(current.right, fragment.left + fragment.width);
      current.top = Math.min(current.top, fragment.top);
      current.bottom = Math.max(current.bottom, fragment.top + fragment.height);
    } else {
      lines.push({
        left: fragment.left,
        top: fragment.top,
        right: fragment.left + fragment.width,
        bottom: fragment.top + fragment.height,
      });
    }
  }
  return lines.map((line) => ({
    left: line.left,
    top: line.top,
    width: line.right - line.left,
    height: line.bottom - line.top,
  }));
}

/** Normalizes merged line rects against the page box; overflowing rect
 * counts collapse to one bounding box (see MAX_CAPTURE_RECTS). */
export function normalizeLineRects(
  lines: readonly ScreenRect[],
  pageBox: ScreenRect,
): MarkRect[] {
  const normalized = lines
    .map((line) => normalizeToBox(line, pageBox))
    .filter((rect): rect is MarkRect => rect !== undefined);
  if (normalized.length <= MAX_CAPTURE_RECTS) return normalized;
  const left = Math.min(...normalized.map((r) => r.left));
  const top = Math.min(...normalized.map((r) => r.top));
  const right = Math.max(...normalized.map((r) => r.left + r.width));
  const bottom = Math.max(...normalized.map((r) => r.top + r.height));
  const bounding = clampToUnitBox({ left, top, width: right - left, height: bottom - top });
  return bounding ? [bounding] : [];
}

function pageOf(node: Node | null): { page: number; pageBox: Element } | undefined {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const pageBox = element?.closest(".law-pdf-page") ?? null;
  const banner = element?.closest("[data-page-number]") ?? null;
  const page = Number(banner?.getAttribute("data-page-number"));
  if (!pageBox || !Number.isInteger(page) || page < 1) return undefined;
  return { page, pageBox };
}

/** Reads the live Selection into a capture, or reports why not. */
export function captureSelection(selection: Selection | null): SelectionCaptureResult {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const start = pageOf(range.startContainer);
  const end = pageOf(range.endContainer);
  if (!start || !end) return undefined;
  if (start.page !== end.page) return { kind: "cross-page" };

  const pageRect = start.pageBox.getBoundingClientRect();
  const lines = mergeRectsPerLine(Array.from(range.getClientRects()));
  const rects = normalizeLineRects(lines, pageRect);
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (rects.length === 0 || text === "") return undefined;

  const last = rects[rects.length - 1] as MarkRect;
  return {
    kind: "captured",
    page: start.page,
    rects,
    text,
    anchor: { left: last.left + last.width, top: last.top + last.height },
  };
}
