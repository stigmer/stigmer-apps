/**
 * One rendered PDF page: a canvas painted at device-pixel-ratio
 * resolution (crisp on high-DPI screens — OutputScale, the pdfjs
 * contract for it) under a pdfjs TextLayer (real selectable text
 * positioned over the paint — what makes selection, find, and the
 * T13 annotation overlay possible).
 *
 * Memoized: the parent re-renders on every scroll (its window state
 * changed), but a page whose own props are unchanged must not — DD-
 * 010's reference-stability doctrine. The expensive work (the paint
 * effect) additionally keys on paint inputs ONLY, so a layout nudge
 * (top/width/height while another page reports its measured size)
 * costs a style diff, never a re-paint. The two stable callbacks are
 * the parent's obligation (useCallback there, asserted by the effect
 * deps here).
 *
 * Renders and text layers are cancelled on unmount or zoom change
 * (renderTask.cancel() / textLayer.cancel()); cancellation rejections
 * are expected and MUST not surface as page errors — a real paint
 * failure, by contrast, shows an honest inline message instead of a
 * silent blank page.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { OutputScale, TextLayer, type PDFDocumentProxy } from "./pdfjs.js";
import type { PageSize } from "./geometry.js";

export interface PdfPageProps {
  readonly doc: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly scale: number;
  /** Layout band, in CSS px (geometry.ts). Position-only changes must
   * not re-paint — the comparator below excludes top. */
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Reports the page's intrinsic (scale-1) size once known; the
   * parent must make this referentially stable. */
  readonly onMeasured: (page: number, size: PageSize) => void;
  /** Registers the rendered text layer for find-highlighting
   * (null on teardown); referentially stable like onMeasured. */
  readonly registerTextLayer: (page: number, container: Element | null) => void;
  /** Optional per-page overlay (the T13 annotation seam): rendered
   * inside the page box ABOVE canvas and text layer, in a
   * pointer-events-none wrapper (an overlay that wants pointer events
   * opts back in itself). MUST be referentially stable like the two
   * callbacks above — the parent re-renders on every scroll, and an
   * unstable identity here would re-render every mounted page per
   * scroll tick. Deliberately EXCLUDED from the paint effect: overlay
   * changes cost a render, never a re-paint. */
  readonly renderOverlay?: (page: number) => ReactNode;
}

function PdfPageImpl(props: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const { doc, pageNumber, scale, onMeasured, registerTextLayer } = props;
  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel(): void } | undefined;
    let textLayer: { cancel(): void } | undefined;
    setFailed(false);

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const intrinsic = page.getViewport({ scale: 1 });
      onMeasured(pageNumber, { width: intrinsic.width, height: intrinsic.height });

      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!canvas || !textDiv) return;
      const viewport = page.getViewport({ scale });

      // Paint at device-pixel resolution: the canvas backing store is
      // DPR× the CSS size, the transform maps pdfjs's CSS-px drawing
      // onto it — crisp glyphs on high-DPI screens (OutputScale is the
      // pdfjs contract for exactly this).
      const output = new OutputScale();
      canvas.width = Math.floor(viewport.width * output.sx);
      canvas.height = Math.floor(viewport.height * output.sy);
      renderTask = page.render({
        canvas,
        viewport,
        transform: output.scaled ? [output.sx, 0, 0, output.sy, 0, 0] : undefined,
      });
      await (renderTask as unknown as { promise: Promise<unknown> }).promise;
      if (cancelled) return;

      textDiv.replaceChildren();
      // The TextLayer's spans position themselves with calc() over this
      // variable — without it every span collapses to the top-left.
      textDiv.style.setProperty("--scale-factor", String(viewport.scale));
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      await (textLayer as unknown as { render(): Promise<void> }).render();
      if (cancelled) return;
      registerTextLayer(pageNumber, textDiv);
    })().catch(() => {
      // cancel() rejects the in-flight promises by design; only a
      // still-mounted page has genuinely failed to paint.
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      registerTextLayer(pageNumber, null);
    };
  }, [doc, pageNumber, scale, onMeasured, registerTextLayer]);

  return (
    <div
      role="group"
      aria-label={`Page ${props.pageNumber} of ${props.pageCount}`}
      data-page-number={props.pageNumber}
      className="absolute inset-x-0 flex justify-center"
      style={{ top: props.top }}
    >
      <div
        className="law-pdf-page relative bg-white shadow-sm"
        style={{ width: props.width, height: props.height }}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="size-full" />
        <div ref={textRef} className="law-pdf-text-layer" />
        {props.renderOverlay && (
          <div className="pointer-events-none absolute inset-0">
            {props.renderOverlay(props.pageNumber)}
          </div>
        )}
        {failed && (
          <p role="alert" className="absolute inset-x-0 top-1/2 px-4 text-center text-sm text-danger">
            This page could not be displayed. Download the document to read it.
          </p>
        )}
      </div>
    </div>
  );
}

export const PdfPage = memo(PdfPageImpl);
