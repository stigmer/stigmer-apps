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
 * Images still render as a plain img on a blob object URL, and
 * Download rides the same URL for both kinds; the URL exists exactly
 * as long as the viewer does (created when the bytes arrive, revoked
 * on close) — the tested pairing invariant.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { documentCategoryLabel } from "../../lib/format.js";
import { useDocument, useDocumentBytes } from "./queries.js";

// pdfjs costs the main bundle nothing: the reader chunk loads on the
// first PDF open (the AssistantConversation precedent).
const PdfReader = lazy(() => import("../../pdf/PdfReader.js"));

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

export function DocumentViewer(props: {
  documentId: string;
  /** 1-based page to open at (the assistant's citation unit). */
  page?: number;
  onClose: () => void;
}) {
  const doc = useDocument(props.documentId);
  const bytes = useDocumentBytes(props.documentId);
  const objectUrl = useObjectUrl(bytes.data);

  const fileName = doc.data?.spec?.fileName ?? "Document";
  const isPdf = doc.data?.spec?.mimeType === "application/pdf";

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

      {doc.isSuccess &&
        bytes.data &&
        (isPdf ? (
          <Suspense fallback={<Loading label="Opening the document…" />}>
            <PdfReader
              blob={bytes.data}
              label={fileName}
              initialPage={props.page}
              className={SURFACE_CLASS}
            />
          </Suspense>
        ) : (
          objectUrl && (
            <div className={`${SURFACE_CLASS} overflow-auto p-2`}>
              <img src={objectUrl} alt={fileName} className="mx-auto max-w-full" />
            </div>
          )
        ))}
    </section>
  );
}
