/**
 * The marking kit's rectangle vocabulary: coordinates normalized 0-1
 * against the marked surface's INTRINSIC size (a PDF page's scale-1
 * viewport, an image's natural dimensions). Normalized-by-construction
 * is the anchoring model's load-bearing property (DD-010): a mark can
 * never be accidentally saved in screen pixels, and rendering needs no
 * scale math at all — percentage positioning inside the surface's box
 * is correct at every zoom and every device-pixel ratio.
 *
 * Domain-free: this folder knows rectangles and pointers, never cases,
 * documents, or annotations (the kit-extraction discipline).
 */

export interface MarkRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Clamps a rect into the unit box, dropping it (undefined) when
 * nothing remains — a drag that ends outside the surface still yields
 * the visible intersection, never coordinates outside the page. */
export function clampToUnitBox(rect: MarkRect): MarkRect | undefined {
  const left = Math.min(Math.max(rect.left, 0), 1);
  const top = Math.min(Math.max(rect.top, 0), 1);
  const right = Math.min(Math.max(rect.left + rect.width, 0), 1);
  const bottom = Math.min(Math.max(rect.top + rect.height, 0), 1);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return undefined;
  return { left, top, width, height };
}

/** Normalizes a screen-space rect against a screen-space box (both in
 * the same coordinate space, e.g. getBoundingClientRect values). */
export function normalizeToBox(
  rect: { left: number; top: number; width: number; height: number },
  box: { left: number; top: number; width: number; height: number },
): MarkRect | undefined {
  if (box.width <= 0 || box.height <= 0) return undefined;
  return clampToUnitBox({
    left: (rect.left - box.left) / box.width,
    top: (rect.top - box.top) / box.height,
    width: rect.width / box.width,
    height: rect.height / box.height,
  });
}
