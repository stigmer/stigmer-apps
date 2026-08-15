/**
 * The pdfjs document lifecycle as a hook: one loading task per Blob,
 * destroyed when the Blob changes or the viewer unmounts — the same
 * created/released pairing discipline the old viewer proved for its
 * object URLs, now on pdfjs resources.
 *
 * The v6 rules (recorded first in the backend's pdf-text.ts, applied
 * verbatim here):
 * - getDocument({ data }) TRANSFERS the underlying ArrayBuffer. The
 *   buffer handed over is a FRESH copy from blob.arrayBuffer() — the
 *   react-query-cached Blob itself is never touched, so Download and
 *   a later re-open keep working (session 21's detached-buffer
 *   showstopper, designed out by construction).
 * - Teardown lives on the LOADING TASK, and must run on the reject
 *   path too, or a failed parse leaks the task's resources.
 */

import { useEffect, useState } from "react";
import { getDocument, PDF_ASSET_OPTIONS, type PDFDocumentProxy } from "./pdfjs.js";

export type PdfDocumentState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: Error }
  | { readonly status: "ready"; readonly doc: PDFDocumentProxy };

export function usePdfDocument(blob: Blob): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    // Set once the async chain reaches getDocument; the cleanup below
    // may run BEFORE that (unmount while blob.arrayBuffer() is still
    // pending), which is why destroy is also attempted inside the
    // chain when it finds the effect already disposed.
    let task: ReturnType<typeof getDocument> | undefined;

    setState({ status: "loading" });
    void (async () => {
      try {
        const data = await blob.arrayBuffer();
        if (disposed) return;
        task = getDocument({ data, ...PDF_ASSET_OPTIONS });
        const doc = await task.promise;
        if (disposed) return;
        setState({ status: "ready", doc });
      } catch (err) {
        if (disposed) return;
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      disposed = true;
      // destroy() settles the task on both resolve and reject paths;
      // pdfjs documents it as idempotent, so racing the load is safe.
      void task?.destroy();
    };
  }, [blob]);

  return state;
}
