/**
 * The ONE import point for pdfjs-dist in the web app — every other pdf
 * module imports from here, never from the package. That single seam is
 * what lets component tests fake the whole engine with one vi.mock, and
 * keeps the loading configuration (worker, fonts, cmaps) impossible to
 * half-apply.
 *
 * The version is pinned to the SAME major the backend's extraction
 * sweep carries (pdfjs-dist ^6.2.x) — one set of quirks, one upgrade
 * surface. The v6 rules recorded in the backend's
 * apps/law/backend/src/domain/document/pdf-text.ts apply here verbatim:
 * getDocument({ data }) TRANSFERS the underlying ArrayBuffer (callers
 * hand over a buffer they will never reuse), and teardown lives on the
 * LOADING TASK (loadingTask.destroy()), which must also run when the
 * load REJECTS or the task's resources leak.
 *
 * Unlike the backend extractor (useSystemFonts: false — it never draws
 * a glyph), the viewer RENDERS, so it must be able to fetch standard
 * font data (PDFs using the base-14 fonts without embedding them) and
 * CMaps (CID-encoded documents). Both ship beside the build under
 * /pdf-assets/ — NOT under Vite's assets/, whose immutable-forever
 * cache header is wrong for files that are copied verbatim rather than
 * content-hashed (a pdfjs upgrade must be able to refresh them). The
 * worker IS content-hashed by Vite's ?url pipeline, so it lives in
 * assets/ with correct immutable caching.
 */

import { GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export { getDocument, OutputScale, TextLayer } from "pdfjs-dist";
export type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";

/** Where the inline Vite plugin publishes the verbatim pdfjs asset
 * directories (see vite.config.ts). Trailing slashes are part of the
 * pdfjs contract for these options. */
export const PDF_ASSET_OPTIONS = {
  cMapUrl: "/pdf-assets/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdf-assets/standard_fonts/",
} as const;
