/**
 * Drag-to-draw a rectangle over a surface — the capture half of the
 * marking kit. Mounted only while the region tool is armed; covers its
 * (relative) parent, owns the pointer for the drag's duration
 * (setPointerCapture), and reports ONE normalized rect on release.
 * The drag is clamped to this surface by construction: coordinates
 * normalize against this layer's own box, so a pointer that wanders
 * off the page still yields the visible intersection (clampToUnitBox)
 * — the single-page contract enforced at capture.
 *
 * Escape is the HOST's concern (the reader owns keyboard state and
 * disarms the tool); this layer only draws and reports. A sub-minimum
 * drag (a stray click) reports nothing rather than a sliver mark.
 */

import { useRef, useState, type PointerEvent } from "react";
import { normalizeToBox, type MarkRect } from "./rect.js";
import "./marking.css";

/** Below this many CSS px in either dimension a drag is a click. */
const MIN_DRAG_PX = 6;

interface DragState {
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  readonly currentX: number;
  readonly currentY: number;
}

function dragBox(drag: DragState) {
  return {
    left: Math.min(drag.originX, drag.currentX),
    top: Math.min(drag.originY, drag.currentY),
    width: Math.abs(drag.currentX - drag.originX),
    height: Math.abs(drag.currentY - drag.originY),
  };
}

export function RegionDrawLayer(props: { onCapture: (rect: MarkRect) => void }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    setDrag((prev) =>
      prev && prev.pointerId === event.pointerId
        ? { ...prev, currentX: event.clientX, currentY: event.clientY }
        : prev,
    );
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDrag(null);
    const layer = layerRef.current;
    if (!layer) return;
    // The RELEASE position is authoritative — the last move event may
    // lag it (or never have fired at all).
    const box = dragBox({ ...drag, currentX: event.clientX, currentY: event.clientY });
    if (box.width < MIN_DRAG_PX || box.height < MIN_DRAG_PX) return;
    const rect = normalizeToBox(box, layer.getBoundingClientRect());
    if (rect) props.onCapture(rect);
  }

  // The preview renders in this layer's own coordinate space.
  const layerBox = layerRef.current?.getBoundingClientRect();
  const preview = drag && layerBox ? dragBox(drag) : null;

  return (
    <div
      ref={layerRef}
      data-region-draw-layer
      className="absolute inset-0 cursor-crosshair"
      style={{ pointerEvents: "auto" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {preview && layerBox && (
        <div
          className="law-mark-region-preview"
          style={{
            position: "absolute",
            left: preview.left - layerBox.left,
            top: preview.top - layerBox.top,
            width: preview.width,
            height: preview.height,
          }}
        />
      )}
    </div>
  );
}
