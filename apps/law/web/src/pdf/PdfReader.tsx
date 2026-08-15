/**
 * The pdfjs reading surface (T12, DD-010): continuous scroll, fit-to-
 * width initial zoom, app-owned chrome (page indicator + jump, zoom,
 * in-viewer find) — the lazy body behind DocumentViewer's PDF branch,
 * loaded on first open so pdfjs costs the main bundle nothing (the
 * AssistantConversation precedent).
 *
 * Extraction seam: this module (src/pdf/) knows bytes, pages, and the
 * generic kit — never cases, documents, or routes. A future vertical's
 * web app lifts the folder as-is; the case-specific wiring stays in
 * screens/cases/DocumentViewer.tsx.
 *
 * The find box is the native viewer's Ctrl-F equivalent and no more:
 * literal, whitespace-flexible matching (find.ts records the rules).
 * Cmd/Ctrl+F is intercepted WHILE FOCUS IS INSIDE THE VIEWER (owner
 * decision, 2026-08-15): under windowing, browser-native find only
 * sees mounted pages and silently misses matches — interception is
 * the honest behavior. Cross-language search stays the server's
 * document search; this box must not oversell.
 *
 * Only pages near the viewport are mounted (geometry.ts windowing);
 * scrolling drives state, state drives the window, and each PdfPage
 * is memoized so only pages whose own inputs changed re-render.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ChevronDown, ChevronUp, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../components/Button.js";
import { Loading } from "../components/async.js";
import {
  computeLayout,
  currentPage as currentPageAt,
  scrollOffsetForPage,
  visiblePageRange,
  type PageSize,
} from "./geometry.js";
import { buildPageText, compileFindQuery, findMatchesOnPage, type PageMatch } from "./find.js";
import { applyFindHighlights, clearFindHighlights } from "./highlight.js";
import { PdfPage } from "./PdfPage.js";
import { usePdfDocument } from "./use-pdf-document.js";
import type { PDFDocumentProxy } from "./pdfjs.js";
import "./pdf.css";

/** A4-portrait-ish stand-in until page 1 reports its real size — court
 * filings are uniform, so page 1's measurement becomes every
 * unmeasured page's estimate and the layout self-corrects from there. */
const DEFAULT_PAGE_SIZE: PageSize = { width: 612, height: 792 };
/** Pages kept mounted beyond the visible ones, each side. */
const OVERSCAN = 2;
/** Breathing room the fit-to-width scale leaves on each side, px. */
const FIT_MARGIN = 24;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3] as const;
const MIN_SCALE = 0.25;

export interface PdfReaderProps {
  readonly blob: Blob;
  /** Accessible name for the reading surface (the file name). */
  readonly label: string;
  /** 1-based page to open at — the ?page= citation seam. Input-only:
   * scrolling never writes back to the URL. */
  readonly initialPage?: number;
  /** The bounded-height frame (DD-019: the surface scrolls INSIDE it;
   * the shell's `main` stays the app's one scroll container). */
  readonly className?: string;
}

export default function PdfReader(props: PdfReaderProps) {
  const state = usePdfDocument(props.blob);

  if (state.status === "loading") {
    return (
      <div className={props.className}>
        <Loading label="Opening the document…" />
      </div>
    );
  }
  if (state.status === "error") {
    // A parse failure here is about the FILE, not the network — the
    // byte fetch already succeeded. Plain words plus the way forward.
    return (
      <div className={props.className}>
        <div role="alert" className="m-4 rounded-card bg-danger-surface px-4 py-3 text-sm">
          <p className="text-danger">
            This document could not be opened for reading. Use Download to view it another way.
          </p>
        </div>
      </div>
    );
  }
  return (
    <PdfReaderBody
      doc={state.doc}
      label={props.label}
      initialPage={props.initialPage}
      className={props.className}
    />
  );
}

function PdfReaderBody(props: {
  doc: PDFDocumentProxy;
  label: string;
  initialPage?: number;
  className?: string;
}) {
  const { doc } = props;
  const pageCount = doc.numPages;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [measured, setMeasured] = useState<ReadonlyMap<number, PageSize>>(new Map());
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matches, setMatches] = useState<readonly PageMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);

  /** Rendered text layers, for find-highlighting; the tick tells the
   * highlight effect the map changed (refs are invisible to React). */
  const textLayersRef = useRef(new Map<number, Element>());
  const [renderedTick, setRenderedTick] = useState(0);
  /** Per-page text, extracted once per document on first find. */
  const pageTextsRef = useRef(new Map<number, string>());
  useEffect(() => {
    pageTextsRef.current = new Map();
    textLayersRef.current = new Map();
  }, [doc]);

  // ---- geometry ----

  const sizes = useMemo(() => {
    const fallback = measured.get(1) ?? DEFAULT_PAGE_SIZE;
    return Array.from({ length: pageCount }, (_, i) => measured.get(i + 1) ?? fallback);
  }, [measured, pageCount]);

  const fitScale =
    surfaceSize.width > 0
      ? Math.max(MIN_SCALE, (surfaceSize.width - FIT_MARGIN * 2) / (sizes[0] ?? DEFAULT_PAGE_SIZE).width)
      : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  const layout = useMemo(() => computeLayout(sizes, scale), [sizes, scale]);
  const window_ = visiblePageRange(layout, scrollTop, surfaceSize.height, OVERSCAN);
  const current = currentPageAt(layout, scrollTop, surfaceSize.height);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () =>
      setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    // The frame's OWN width, never the viewport's: the Ask AI dock
    // squeezes content without resizing the window (DD-007 §5a — the
    // rail learned this via container queries; fit-width rides the
    // same lesson via ResizeObserver).
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  // Reading position survives a zoom change: same content point stays
  // under the reading line by scaling scrollTop with the layout.
  const prevScaleRef = useRef(scale);
  useEffect(() => {
    if (prevScaleRef.current === scale) return;
    const ratio = scale / prevScaleRef.current;
    prevScaleRef.current = scale;
    const surface = surfaceRef.current;
    if (!surface) return;
    const next = surface.scrollTop * ratio;
    surface.scrollTop = next;
    setScrollTop(next);
  }, [scale]);

  const scrollToPage = useCallback(
    (page: number) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const top = scrollOffsetForPage(layout, Math.min(Math.max(page, 1), pageCount));
      surface.scrollTop = top;
      // jsdom fires no scroll events; mirroring into state keeps the
      // window and indicator correct everywhere.
      setScrollTop(top);
    },
    [layout, pageCount],
  );
  // The find effect jumps to the first match as the query settles (the
  // native-find convention) — through a ref, so a layout change (zoom,
  // page measurement) never re-fires the search or re-jumps the reader.
  const scrollToPageRef = useRef(scrollToPage);
  scrollToPageRef.current = scrollToPage;

  // The ?page= deep link: one scroll, after the first layout exists.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || layout.pages.length === 0) return;
    deepLinked.current = true;
    if (props.initialPage && props.initialPage > 1) scrollToPage(props.initialPage);
  }, [layout, props.initialPage, scrollToPage]);

  // Opening a document is a deliberate act — focus moves to the
  // surface so keyboard scrolling and Ctrl/Cmd+F work immediately
  // (the dock's expand-focuses-panel precedent).
  useEffect(() => {
    surfaceRef.current?.focus();
  }, []);

  // ---- stable callbacks for the memoized pages ----

  const onMeasured = useCallback((page: number, size: PageSize) => {
    setMeasured((prev) => {
      const known = prev.get(page);
      if (known && known.width === size.width && known.height === size.height) return prev;
      return new Map(prev).set(page, size);
    });
  }, []);

  const registerTextLayer = useCallback((page: number, container: Element | null) => {
    if (container) textLayersRef.current.set(page, container);
    else textLayersRef.current.delete(page);
    setRenderedTick((tick) => tick + 1);
  }, []);

  // ---- find ----

  useEffect(() => {
    const regex = compileFindQuery(findOpen ? findQuery : "");
    if (!regex) {
      setMatches([]);
      setMatchIndex(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const found: PageMatch[] = [];
      for (let page = 1; page <= pageCount; page++) {
        let text = pageTextsRef.current.get(page);
        if (text === undefined) {
          const content = await doc.getPage(page).then((p) => p.getTextContent());
          if (cancelled) return;
          // Marked-content items carry structure, not text — the text
          // layer DOM skips them the same way, keeping offsets aligned.
          text = buildPageText(
            content.items.flatMap((item) => ("str" in item ? [{ str: item.str }] : [])),
          );
          pageTextsRef.current.set(page, text);
        }
        found.push(...findMatchesOnPage(regex, page, text));
      }
      if (cancelled) return;
      setMatches(found);
      setMatchIndex(0);
      const first = found[0];
      if (first) scrollToPageRef.current(first.page);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, findOpen, findQuery, pageCount]);

  useEffect(() => {
    applyFindHighlights(textLayersRef.current, matches, matchIndex);
  }, [matches, matchIndex, renderedTick]);
  useEffect(() => clearFindHighlights, []);

  function goToMatch(index: number) {
    if (matches.length === 0) return;
    const wrapped = (index + matches.length) % matches.length;
    setMatchIndex(wrapped);
    const match = matches[wrapped];
    if (match) scrollToPage(match.page);
  }

  function openFind() {
    setFindOpen(true);
    // The input mounts this render; focus lands after commit.
    requestAnimationFrame(() => findInputRef.current?.select());
  }

  function closeFind() {
    setFindOpen(false);
    clearFindHighlights();
    surfaceRef.current?.focus();
  }

  function onRootKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    } else if (event.key === "Escape" && findOpen) {
      event.preventDefault();
      closeFind();
    }
  }

  function onFindKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      goToMatch(event.shiftKey ? matchIndex - 1 : matchIndex + 1);
    }
  }

  // ---- zoom ----

  function zoomIn() {
    setZoom(ZOOM_STEPS.find((step) => step > scale + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? scale);
  }
  function zoomOut() {
    setZoom([...ZOOM_STEPS].reverse().find((step) => step < scale - 0.01) ?? ZOOM_STEPS[0] ?? scale);
  }

  function onPageJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = new FormData(event.currentTarget).get("page");
    const page = Number(raw);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) scrollToPage(page);
  }

  return (
    <div
      onKeyDown={onRootKeyDown}
      className={`flex flex-col overflow-hidden ${props.className ?? ""}`}
    >
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-2">
        <form onSubmit={onPageJump} className="flex items-center gap-1 text-sm">
          <label htmlFor="pdf-page-jump" className="sr-only">
            Go to page
          </label>
          <input
            id="pdf-page-jump"
            name="page"
            key={current}
            defaultValue={current}
            inputMode="numeric"
            className="h-7 w-12 rounded-card border border-line bg-surface text-center text-sm"
          />
          <span className="text-ink-muted">/ {pageCount}</span>
        </form>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
        <Button onClick={zoomOut} aria-label="Zoom out" title="Zoom out">
          <ZoomOut className="size-4" aria-hidden="true" />
        </Button>
        <span className="w-11 text-center text-sm text-ink-muted">{Math.round(scale * 100)}%</span>
        <Button onClick={zoomIn} aria-label="Zoom in" title="Zoom in">
          <ZoomIn className="size-4" aria-hidden="true" />
        </Button>
        <Button onClick={() => setZoom("fit")} aria-pressed={zoom === "fit"}>
          Fit width
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
        <Button onClick={() => (findOpen ? closeFind() : openFind())} aria-expanded={findOpen}>
          <Search className="size-4" aria-hidden="true" />
          Find
        </Button>
      </div>

      {findOpen && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-2">
          <label htmlFor="pdf-find-input" className="sr-only">
            Find in document
          </label>
          <input
            id="pdf-find-input"
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={onFindKeyDown}
            placeholder="Find in document"
            className="h-7 min-w-0 flex-1 rounded-card border border-line bg-surface px-2 text-sm sm:max-w-64"
          />
          <span aria-live="polite" className="whitespace-nowrap text-xs text-ink-muted">
            {compileFindQuery(findQuery) === null
              ? ""
              : matches.length === 0
                ? "No matches"
                : `${matchIndex + 1} of ${matches.length}`}
          </span>
          <Button
            onClick={() => goToMatch(matchIndex - 1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
            title="Previous match"
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </Button>
          <Button
            onClick={() => goToMatch(matchIndex + 1)}
            disabled={matches.length === 0}
            aria-label="Next match"
            title="Next match"
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </Button>
          <Button onClick={closeFind} aria-label="Close find" title="Close find">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* tabIndex: a scrollable region with no focusable children must
          itself be focusable (the Guide screen's session-15 axe lesson,
          scrollable-region-focusable) — and this is also what scopes
          the Ctrl/Cmd+F interception to the viewer. */}
      <div
        ref={surfaceRef}
        role="region"
        aria-label={props.label}
        tabIndex={0}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="relative min-h-0 flex-1 overflow-auto bg-ink/5"
      >
        <div className="relative" style={{ height: layout.totalHeight }}>
          {layout.pages.map((band, index) => {
            const page = index + 1;
            if (page < window_.first || page > window_.last) return null;
            return (
              <PdfPage
                key={page}
                doc={doc}
                pageNumber={page}
                pageCount={pageCount}
                scale={scale}
                top={band.top}
                width={band.width}
                height={band.height}
                onMeasured={onMeasured}
                registerTextLayer={registerTextLayer}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
