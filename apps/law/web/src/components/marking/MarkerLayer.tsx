/**
 * Renders marks over a surface from normalized rects — the display half
 * of the marking kit. Pure and presentational: given markers, it emits
 * percentage-positioned boxes inside its (relative) parent. Because
 * anchors are normalized to the surface's intrinsic size and the parent
 * box is that size times the current zoom, percentages ARE the render —
 * no scale math, correct at every zoom and DPR by construction.
 *
 * pointer-events: none throughout — marks must never block the text
 * selection or drag happening on the layers beneath them. Consumption
 * with affordances (author, comment, jump) is the annotations panel's
 * job; this layer is the visual on the page.
 */

import type { MarkRect } from "./rect.js";
import "./marking.css";

export interface Marker {
  /** Stable identity (the list key). */
  readonly id: string;
  /** One box per marked line for highlights; exactly one for regions. */
  readonly rects: readonly MarkRect[];
  readonly appearance: "highlight" | "region";
}

export function MarkerLayer(props: { markers: readonly Marker[] }) {
  if (props.markers.length === 0) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {props.markers.map((marker) =>
        marker.rects.map((rect, index) => (
          <div
            key={`${marker.id}:${index}`}
            className={
              marker.appearance === "highlight" ? "law-mark-highlight" : "law-mark-region"
            }
            style={{
              position: "absolute",
              left: `${rect.left * 100}%`,
              top: `${rect.top * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        )),
      )}
    </div>
  );
}
