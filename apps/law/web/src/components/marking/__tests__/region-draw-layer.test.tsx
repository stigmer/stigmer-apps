/**
 * The drag lifecycle: press → preview → release reports ONE normalized
 * rect against the layer's own box (the page clamp by construction);
 * a sub-minimum drag is a click, not a sliver mark. jsdom has no
 * pointer capture — stubbed, like its other missing layout surfaces.
 */

import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RegionDrawLayer } from "../RegionDrawLayer.js";

const LAYER_BOX = { left: 100, top: 50, width: 400, height: 800, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };

beforeAll(() => {
  // jsdom implements neither; the layer calls both on real browsers.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});
afterAll(() => vi.restoreAllMocks());

function renderLayer(onCapture: (rect: unknown) => void) {
  const { container } = render(<RegionDrawLayer onCapture={onCapture} />);
  const layer = container.querySelector("[data-region-draw-layer]") as HTMLElement;
  layer.getBoundingClientRect = () => LAYER_BOX as DOMRect;
  return layer;
}

describe("RegionDrawLayer", () => {
  it("a drag reports the normalized rect of its screen box", () => {
    const onCapture = vi.fn();
    const layer = renderLayer(onCapture);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 200, clientY: 250 });
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 300, clientY: 450 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 300, clientY: 450 });

    expect(onCapture).toHaveBeenCalledTimes(1);
    const rect = onCapture.mock.calls[0]?.[0] as Record<string, number>;
    expect(rect.left).toBeCloseTo((200 - 100) / 400, 10);
    expect(rect.top).toBeCloseTo((250 - 50) / 800, 10);
    expect(rect.width).toBeCloseTo(100 / 400, 10);
    expect(rect.height).toBeCloseTo(200 / 800, 10);
  });

  it("a backwards drag (up-left) yields the same normalized box", () => {
    const onCapture = vi.fn();
    const layer = renderLayer(onCapture);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 300, clientY: 450 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 200, clientY: 250 });

    const rect = onCapture.mock.calls[0]?.[0] as Record<string, number>;
    expect(rect.left).toBeCloseTo(0.25, 10);
    expect(rect.top).toBeCloseTo(0.25, 10);
  });

  it("a drag that wanders off the layer clamps to the visible intersection", () => {
    const onCapture = vi.fn();
    const layer = renderLayer(onCapture);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 450, clientY: 800 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 700, clientY: 950 });

    const rect = onCapture.mock.calls[0]?.[0] as { left: number; top: number; width: number; height: number };
    expect(rect.left + rect.width).toBeLessThanOrEqual(1);
    expect(rect.top + rect.height).toBeLessThanOrEqual(1);
  });

  it("a stray click (sub-minimum drag) reports nothing", () => {
    const onCapture = vi.fn();
    const layer = renderLayer(onCapture);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 200, clientY: 250 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 203, clientY: 252 });

    expect(onCapture).not.toHaveBeenCalled();
  });

  it("pointer cancel abandons the drag", () => {
    const onCapture = vi.fn();
    const layer = renderLayer(onCapture);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 200, clientY: 250 });
    fireEvent.pointerCancel(layer, { pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 300, clientY: 450 });

    expect(onCapture).not.toHaveBeenCalled();
  });
});
