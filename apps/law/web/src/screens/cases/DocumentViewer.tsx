/**
 * The in-app reading frame (T09.2): a document opens ON the case —
 * `?doc=<id>` swaps the whole detail frame (the edit-mode precedent),
 * and Close/Back land on the Documents tab. Reading papers is the
 * heart of the practice; it must not eject the lawyer into a bare
 * browser tab.
 *
 * PDFs render through the app's own pdfjs reader (src/pdf/, T12 —
 * DD-010 fired the T09.2 named deferral): the earlier native-iframe
 * rendering was a sealed frame with no geometry access, so the T13
 * annotation overlay was physically impossible on it, and its chrome
 * read as a browser plugin rather than the product. The reader carries
 * selection, in-viewer find, zoom, and page navigation itself; `page`
 * is app-controlled scroll-to-page now, not a #page= fragment hint.
 * KNOWINGLY DEGRADED: the native viewer's print is gone — Download
 * covers the need (recorded owner trade-off, T12).
 *
 * MARKS (T13, DD-010): this file is where the reader's generic marking
 * seams meet the DocumentAnnotation domain — select text → highlight
 * with per-line rects + quoted text; drag → region (the workhorse on
 * a scan-heavy corpus: scans and images carry no text geometry, so
 * the highlight affordance is structurally absent there — a selection
 * cannot exist without a text layer). A capture becomes a DRAFT; the
 * panel (AnnotationsPanel) takes the required comment and creates.
 * Marks render through the kit's MarkerLayer on both surfaces.
 *
 * MARK IDENTITY: every saved mark carries a stable NUMBER — its
 * position in creation order, derived per render, never stored. Sound
 * because the resource is append-only (create + list, oldest-first by
 * server contract): the third mark ever made is Mark 3 forever. The
 * number is what lets two same-page marks be told apart, and this
 * component owns the linking state both surfaces share: the focused
 * mark (selected on either side — the panel row lights up AND the
 * on-page rects pulse) and the hovered mark (pointed at on one side,
 * emphasized on the other). Jumps land ON the mark's rect at the
 * reading line, not at the page top.
 *
 * Images still render as a plain img on a blob object URL — now inside
 * a relative box so the same marking kit covers them (an image is one
 * page: page = 1). Download rides the same URL for both kinds; the URL
 * exists exactly as long as the viewer does (created when the bytes
 * arrive, revoked on close) — the tested pairing invariant.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { MarkerLayer, type Marker } from "../../components/marking/MarkerLayer.js";
import { RegionDrawLayer } from "../../components/marking/RegionDrawLayer.js";
import type { MarkRect } from "../../components/marking/rect.js";
import { AnnotationKind, type DocumentAnnotation } from "../../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import { documentCategoryLabel } from "../../lib/format.js";
import { clipGraphemeSafe } from "../../lib/snippet.js";
import type { PdfReaderController } from "../../pdf/PdfReader.js";
import type { SelectionCapture } from "../../pdf/selection.js";
import { AnnotationsPanel, type MarkDraft } from "./AnnotationsPanel.js";
import { useDocument, useDocumentAnnotations, useDocumentBytes } from "./queries.js";

// pdfjs costs the main bundle nothing: the reader chunk loads on the
// first PDF open (the AssistantConversation precedent).
const PdfReader = lazy(() => import("../../pdf/PdfReader.js"));

/** The proto bound on quoted_text; the clip keeps an over-long
 * selection an honest prefix instead of a failed create. */
const QUOTED_TEXT_MAX = 1000;

/** One object URL per blob, revoked when the blob or viewer goes away. */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(undefined);
    };
  }, [blob]);
  return url;
}

/**
 * The shell's `main` is the app's ONE scroll container (DD-019); the
 * document surface gets a bounded viewport-relative height so pages
 * scroll INSIDE their frame — an unsized surface would grow the page
 * and leak scrolling back to `main`.
 */
const SURFACE_CLASS =
  "h-[calc(100dvh-11rem)] w-full rounded-card border border-line bg-surface";

/** The mark selected on either surface. The nonce makes a re-selection
 * observable (it keys the pulsing rects, so clicking the same row
 * again replays the flash — CSS animations restart only on remount). */
interface MarkFocus {
  readonly id: string;
  readonly nonce: number;
}

/** Saved marks + the pending draft, as the kit renders them. The draft
 * previews in place so what gets saved is what was seen.
 *
 * Numbers are assigned over the FULL list before the page filter —
 * a mark's number is its position in the document's creation order
 * (the panel's row order), not its position on the page. */
function markersForPage(
  annotations: readonly DocumentAnnotation[],
  draft: MarkDraft | null,
  page: number,
  focusedId: string | null,
  hoveredId: string | null,
): Marker[] {
  const markers: Marker[] = [];
  annotations.forEach((mark, index) => {
    if (mark.spec?.page !== page) return;
    const id = mark.metadata?.id ?? "";
    markers.push({
      id,
      rects: (mark.spec?.rects ?? []).map((rect) => ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      })),
      appearance:
        mark.spec?.annotationKind === AnnotationKind.REGION ? "region" : "highlight",
      label: String(index + 1),
      ariaLabel: `Mark ${index + 1} on page ${page}`,
      focused: focusedId === id,
      hovered: hoveredId === id,
    });
  });
  if (draft && draft.page === page) {
    markers.push({ id: "draft", rects: draft.rects, appearance: draft.kind });
  }
  return markers;
}

export function DocumentViewer(props: {
  documentId: string;
  /** 1-based page to open at (the assistant's citation unit). */
  page?: number;
  onClose: () => void;
}) {
  const doc = useDocument(props.documentId);
  const bytes = useDocumentBytes(props.documentId);
  const objectUrl = useObjectUrl(bytes.data);
  const annotations = useDocumentAnnotations(props.documentId);
  const [draft, setDraft] = useState<MarkDraft | null>(null);
  /** The linking state both surfaces share (see the header). */
  const [focusedMark, setFocusedMark] = useState<MarkFocus | null>(null);
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null);
  const readerController = useRef<PdfReaderController | null>(null);

  const fileName = doc.data?.spec?.fileName ?? "Document";
  const caseId = doc.data?.spec?.caseId ?? "";
  const isPdf = doc.data?.spec?.mimeType === "application/pdf";
  const annotationItems = annotations.data?.items;

  // ---- the reader's marking seams (stability contract: PdfReaderProps) ----

  const onSelectMark = useCallback((id: string) => {
    setFocusedMark((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const onHoverMark = useCallback((id: string | null) => setHoveredMarkId(id), []);

  const renderPageOverlay = useCallback(
    (page: number) => (
      <MarkerLayer
        markers={markersForPage(
          annotationItems ?? [],
          draft,
          page,
          focusedMark?.id ?? null,
          hoveredMarkId,
        )}
        focusNonce={focusedMark?.nonce}
        onSelect={onSelectMark}
        onHover={onHoverMark}
      />
    ),
    [annotationItems, draft, focusedMark, hoveredMarkId, onSelectMark, onHoverMark],
  );

  const selectionAction = useMemo(
    () => ({
      label: "Add mark",
      onCapture: (capture: SelectionCapture) =>
        setDraft({
          page: capture.page,
          kind: "highlight",
          rects: capture.rects,
          quotedText: clipGraphemeSafe(capture.text, QUOTED_TEXT_MAX),
        }),
    }),
    [],
  );

  const regionTool = useMemo(
    () => ({
      label: "Mark region",
      onCapture: (page: number, rect: MarkRect) =>
        setDraft({ page, kind: "region", rects: [rect], quotedText: "" }),
    }),
    [],
  );

  // Jump lands ON the mark (its first rect at the reading line) and
  // focuses it, so the landing is unambiguous even among same-page
  // marks. On the image surface no controller exists — ImageSurface
  // scrolls its own (unwindowed) box to the focused mark itself.
  const onJumpToMark = useCallback((mark: DocumentAnnotation) => {
    const id = mark.metadata?.id ?? "";
    setFocusedMark((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
    const page = mark.spec?.page ?? 1;
    const rect = mark.spec?.rects[0];
    if (rect) readerController.current?.scrollToRect(page, rect);
    else readerController.current?.scrollToPage(page);
  }, []);

  function onDownload() {
    if (!objectUrl) return;
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
  }

  return (
    <section aria-label={`Document ${fileName}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{fileName}</h1>
        {doc.data?.spec && <Badge>{documentCategoryLabel(doc.data.spec.category)}</Badge>}
        <Button onClick={onDownload} disabled={!objectUrl}>
          Download
        </Button>
        <Button onClick={props.onClose}>Close</Button>
      </div>

      {(doc.isPending || bytes.isPending) && <Loading label="Opening the document…" />}
      {doc.isError && <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />}
      {doc.isSuccess && bytes.isError && (
        <ErrorState error={bytes.error} onRetry={() => void bytes.refetch()} />
      )}

      {doc.isSuccess && bytes.data && (
        <div className="lg:flex lg:items-start lg:gap-4">
          <div className="min-w-0 lg:flex-1">
            {isPdf ? (
              <Suspense fallback={<Loading label="Opening the document…" />}>
                <PdfReader
                  blob={bytes.data}
                  label={fileName}
                  initialPage={props.page}
                  className={SURFACE_CLASS}
                  controllerRef={readerController}
                  renderPageOverlay={renderPageOverlay}
                  selectionAction={selectionAction}
                  regionTool={regionTool}
                />
              </Suspense>
            ) : (
              objectUrl && (
                <ImageSurface
                  src={objectUrl}
                  alt={fileName}
                  markers={markersForPage(
                    annotationItems ?? [],
                    draft,
                    1,
                    focusedMark?.id ?? null,
                    hoveredMarkId,
                  )}
                  focus={focusedMark}
                  onSelectMark={onSelectMark}
                  onHoverMark={onHoverMark}
                  onRegion={(rect) =>
                    setDraft({ page: 1, kind: "region", rects: [rect], quotedText: "" })
                  }
                />
              )
            )}
          </div>
          <aside className="mt-4 lg:mt-0 lg:w-80 lg:shrink-0">
            <div className="lg:flex lg:max-h-[calc(100dvh-11rem)] lg:flex-col">
              <AnnotationsPanel
                documentId={props.documentId}
                caseId={caseId}
                draft={draft}
                onDraftDone={() => setDraft(null)}
                focusedMark={focusedMark}
                onJumpToMark={onJumpToMark}
                onHoverMark={onHoverMark}
              />
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

/**
 * The image surface with marks: one page by definition (page = 1), the
 * box sized by the image itself so the kit's percentage-positioned
 * marks land on the pixels (intrinsic size = natural dimensions —
 * max-w-full only ever scales proportionally). No highlight affordance
 * exists here and none is faked: an image has no text to select
 * (DD-010's capability matrix); the region tool is the mark.
 *
 * Jump-to-mark here is DOM-native scrollIntoView on the focused rect
 * (the kit stamps data-marker-id): this box is one unwindowed scroller,
 * so no layout math is warranted — the reader's scrollToRect exists
 * because ITS pages mount and unmount under windowing.
 */
function ImageSurface(props: {
  src: string;
  alt: string;
  markers: readonly Marker[];
  focus: { readonly id: string; readonly nonce: number } | null;
  onSelectMark: (id: string) => void;
  onHoverMark: (id: string | null) => void;
  onRegion: (rect: MarkRect) => void;
}) {
  const [regionArmed, setRegionArmed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const { focus } = props;
  useEffect(() => {
    if (!focus) return;
    const rect = boxRef.current?.querySelector(`[data-marker-id="${CSS.escape(focus.id)}"]`);
    // Guarded: jsdom implements no scrollIntoView.
    rect?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  return (
    <div className={`${SURFACE_CLASS} flex flex-col overflow-hidden`}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
        <Button
          onClick={() => setRegionArmed((armed) => !armed)}
          aria-pressed={regionArmed}
          title="Drag a rectangle on the image (Esc cancels)"
        >
          Mark region
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto p-2"
        onKeyDown={(event) => {
          if (event.key === "Escape" && regionArmed) {
            event.preventDefault();
            setRegionArmed(false);
          }
        }}
      >
        <div ref={boxRef} className="relative mx-auto w-fit">
          <img src={props.src} alt={props.alt} className="block max-w-full" />
          <MarkerLayer
            markers={props.markers}
            focusNonce={props.focus?.nonce}
            onSelect={props.onSelectMark}
            onHover={props.onHoverMark}
          />
          {regionArmed && (
            <RegionDrawLayer
              onCapture={(rect) => {
                setRegionArmed(false);
                props.onRegion(rect);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
