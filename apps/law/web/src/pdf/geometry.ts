/**
 * Pure layout math for the continuous-scroll reader: page positions,
 * the render window, and the current page — no pdfjs, no DOM, fully
 * unit-testable. Page numbers are 1-based everywhere (the lawyer's
 * citation unit, the DocumentPage convention); arrays index n-1.
 *
 * Sizes arrive at the page's INTRINSIC scale (pdfjs scale-1 viewport)
 * and are multiplied by one document-wide zoom scale. Pages whose true
 * size has not been measured yet borrow page 1's (court filings are
 * uniform in practice); the layout self-corrects as pages enter the
 * render window and report their real size — the scrollbar is
 * approximately honest immediately and exactly honest progressively.
 */

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface PageBand {
  /** Distance from the scroll surface's content top, in CSS px. */
  readonly top: number;
  readonly height: number;
  readonly width: number;
}

export interface ReaderLayout {
  readonly pages: readonly PageBand[];
  readonly totalHeight: number;
}

/** Vertical gap between pages and padding above the first / below the
 * last, in CSS px — one constant so tests and components agree. */
export const PAGE_GAP = 16;

export function computeLayout(sizes: readonly PageSize[], scale: number): ReaderLayout {
  const pages: PageBand[] = [];
  let top = PAGE_GAP;
  for (const size of sizes) {
    const height = size.height * scale;
    pages.push({ top, height, width: size.width * scale });
    top += height + PAGE_GAP;
  }
  return { pages, totalHeight: top };
}

/**
 * The 1-based inclusive range of pages to keep mounted: every page
 * intersecting the viewport plus `overscan` pages on each side, so a
 * gentle scroll never shows a blank band. Everything outside holds no
 * DOM at all — the windowing that keeps a 200-page scanned court file
 * from becoming a memory incident.
 */
export function visiblePageRange(
  layout: ReaderLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { first: number; last: number } {
  const count = layout.pages.length;
  if (count === 0) return { first: 1, last: 0 };
  const viewTop = scrollTop;
  const viewBottom = scrollTop + viewportHeight;
  let first = count;
  let last = 1;
  for (const [index, band] of layout.pages.entries()) {
    const bandBottom = band.top + band.height;
    if (bandBottom > viewTop && band.top < viewBottom) {
      first = Math.min(first, index + 1);
      last = Math.max(last, index + 1);
    }
  }
  if (first > last) {
    // Nothing intersects (zero-height viewport, or scrolled past the
    // end during a re-layout): anchor on the page containing scrollTop.
    const anchor = pageAtLine(layout, viewTop);
    first = anchor;
    last = anchor;
  }
  return {
    first: Math.max(1, first - overscan),
    last: Math.min(count, last + overscan),
  };
}

/**
 * The page "being read": the one containing the reading line, placed
 * 35% down the viewport — matching where the eye rests, and degrading
 * to exactly scrollTop when the viewport height is unknown (jsdom).
 */
export function currentPage(
  layout: ReaderLayout,
  scrollTop: number,
  viewportHeight: number,
): number {
  return pageAtLine(layout, scrollTop + viewportHeight * 0.35);
}

/** The scrollTop that puts page n's top just under the leading gap. */
export function scrollOffsetForPage(layout: ReaderLayout, page: number): number {
  const band = layout.pages[page - 1];
  return band ? Math.max(0, band.top - PAGE_GAP) : 0;
}

/**
 * The scrollTop that puts a point inside page n — given as a normalized
 * (0–1) offset from the page's top, the anchor convention — at the 35%
 * reading line. The SAME line currentPage reads, deliberately: landing
 * a target at the reading line means the page indicator immediately
 * names the target's page, never a neighbor. With an unknown viewport
 * height (jsdom) this degrades to the point at the viewport top.
 */
export function scrollOffsetForRect(
  layout: ReaderLayout,
  page: number,
  rectTop: number,
  viewportHeight: number,
): number {
  const band = layout.pages[page - 1];
  if (!band) return 0;
  return Math.max(0, band.top + rectTop * band.height - viewportHeight * 0.35);
}

function pageAtLine(layout: ReaderLayout, line: number): number {
  const count = layout.pages.length;
  for (const [index, band] of layout.pages.entries()) {
    // A gap belongs to the page BELOW it: scrollOffsetForPage lands in
    // the gap above its target, and the indicator must immediately
    // read the target — attributing gaps upward misreported page n as
    // n-1 exactly at the deep-link landing point.
    if (line < band.top + band.height) return index + 1;
  }
  return count === 0 ? 1 : count;
}
