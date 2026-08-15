/**
 * Renders marks over a surface from normalized rects — the display half
 * of the marking kit. Pure and presentational: given markers, it emits
 * percentage-positioned boxes inside its (relative) parent. Because
 * anchors are normalized to the surface's intrinsic size and the parent
 * box is that size times the current zoom, percentages ARE the render —
 * no scale math, correct at every zoom and DPR by construction.
 *
 * Two sibling layers with distinct duties:
 *
 * - The RECTS stay pointer-events: none and aria-hidden — they must
 *   never block the text selection or drag happening on the layers
 *   beneath them, and full consumption (author, comment, jump) is the
 *   annotations panel's job.
 * - The BADGES (one numbered chip per labeled marker) are the on-page
 *   identity affordance: real buttons that opt back into pointer
 *   events, so a reader can tell same-page marks apart and select one
 *   to light up its panel row. They live OUTSIDE the aria-hidden
 *   container by necessity — a focusable element inside aria-hidden is
 *   an axe violation — and are deliberately small, so the page stays a
 *   reading surface first.
 *
 * A marker without a label gets no badge (the in-flight draft: its
 * dashed style already distinguishes it, and it has no saved identity
 * to select).
 */

import type { MarkRect } from "./rect.js";
import "./marking.css";

export interface Marker {
  /** Stable identity (the list key; reported by onSelect/onHover). */
  readonly id: string;
  /** One box per marked line for highlights; exactly one for regions. */
  readonly rects: readonly MarkRect[];
  readonly appearance: "highlight" | "region";
  /** The badge's visible text (the mark's number). No label, no badge. */
  readonly label?: string;
  /** The badge button's accessible name (consumer-worded). */
  readonly ariaLabel?: string;
  /** Selected on either surface: rects emphasize, the badge fills. */
  readonly focused?: boolean;
  /** Pointed at on the OTHER surface (a panel row): rects emphasize. */
  readonly hovered?: boolean;
}

/** A badge this close to the surface's left edge (normalized) cannot
 * fit in the margin beside its rect, so it sits inside the rect's
 * corner instead — placement never clips off-surface. */
const BADGE_MARGIN_FLIP = 0.05;

export function MarkerLayer(props: {
  markers: readonly Marker[];
  /** Bumped by the consumer to replay the focused marker's pulse (a
   * re-click must flash again; CSS animations restart only on
   * remount, so the nonce keys the focused rects). */
  focusNonce?: number;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
}) {
  if (props.markers.length === 0) return null;
  const badged = props.markers.filter((marker) => marker.label && marker.rects.length > 0);
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {props.markers.map((marker) =>
          marker.rects.map((rect, index) => (
            <div
              key={
                marker.focused
                  ? `${marker.id}:${index}:${props.focusNonce ?? 0}`
                  : `${marker.id}:${index}`
              }
              data-marker-id={marker.id}
              className={[
                marker.appearance === "highlight" ? "law-mark-highlight" : "law-mark-region",
                marker.focused ? "law-mark-focused" : "",
                marker.hovered ? "law-mark-hovered" : "",
              ]
                .filter(Boolean)
                .join(" ")}
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
      {badged.length > 0 && props.onSelect && (
        <div className="pointer-events-none absolute inset-0">
          {badged.map((marker) => {
            const anchor = marker.rects[0]!;
            const inMargin = anchor.left >= BADGE_MARGIN_FLIP;
            return (
              <button
                key={marker.id}
                type="button"
                aria-label={marker.ariaLabel ?? `Mark ${marker.label}`}
                aria-pressed={marker.focused === true}
                className={`law-mark-badge pointer-events-auto ${
                  inMargin ? "law-mark-badge-margin" : ""
                }`}
                style={{
                  position: "absolute",
                  left: `${anchor.left * 100}%`,
                  top: `${anchor.top * 100}%`,
                }}
                onClick={() => props.onSelect?.(marker.id)}
                onMouseEnter={() => props.onHover?.(marker.id)}
                onMouseLeave={() => props.onHover?.(null)}
              >
                {marker.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
