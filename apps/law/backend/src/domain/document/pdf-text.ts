/**
 * PDF text-layer extraction (FR-DOC-003): pdfjs-dist's legacy Node
 * build, per page, no worker (in-process — the sweep is already the
 * concurrency bound). Pure text-layer reading: a scanned or image-only
 * PDF parses fine and yields nothing, which is a CLASSIFICATION
 * (no_text_layer), never an error — the honest state the assistant
 * reports until OCR lands (DD-008 gate).
 *
 * The failure polarity matters to the sweep's retry rule: everything
 * the parser rejects (corrupt bytes, encryption) throws
 * PdfNotReadableError — DETERMINISTIC, so the sweep records FAILED and
 * never retries it. Anything else that throws here is a programming
 * error and propagates as such.
 */

// Order matters: the polyfill must be evaluated before pdfjs, whose
// module scope constructs a DOMMatrix (pdf-polyfill.ts has the story).
import "./pdf-polyfill.js";
import {
  getDocument,
  InvalidPDFException,
  PasswordException,
} from "pdfjs-dist/legacy/build/pdf.mjs";

/** The parser rejected the bytes — identical on every retry. */
export class PdfNotReadableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PdfNotReadableError";
  }
}

export interface ExtractedPdf {
  /** Text per page, 1-based order, whitespace-normalized. */
  readonly pages: readonly string[];
  /** True when the document carries no USABLE text — a scan or
   * image-only PDF. Judged across the whole document against a small
   * threshold, not page emptiness: scanners and photo-to-PDF apps often
   * emit a handful of stray glyphs, and answering searches from that
   * noise would be pretending to read a scan. */
  readonly noTextLayer: boolean;
}

/** Below this many characters across ALL pages, the text layer is
 * classified as absent (see ExtractedPdf.noTextLayer). */
const MIN_MEANINGFUL_CHARS = 20;

/**
 * Counts a PDF's pages without reading any text. The OCR sweep
 * measures page counts itself because DocumentStatus.page_count is
 * contractually "DocumentPage rows; 0 unless EXTRACTED"
 * (document.proto) and NO_TEXT_LAYER rows honestly carry 0. A
 * NO_TEXT_LAYER PDF parsed clean once by definition (garbage lands
 * FAILED), so a parse failure here is transient and throws past the
 * frame — no PdfNotReadableError classification.
 */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const loadingTask = getDocument({
    // A COPY, never the caller's array: pdfjs v6 TRANSFERS the
    // underlying ArrayBuffer into its parser (getDocument({ data })
    // detaches it — proven in isolation: byteLength 797 → 0 after the
    // call), so handing over the caller's bytes would leave them
    // reading as 0 bytes afterwards. The OCR sweep counts pages and
    // then sends the SAME array to the provider; without this copy
    // every PDF went out as an empty rawDocument (the review's F1
    // showstopper). Copying here, inside the counter, protects every
    // future caller too.
    data: bytes.slice(),
    // Same posture as extractPdfText: no filesystem lookups, errors
    // only (the header there has the story).
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await loadingTask.promise;
    return doc.numPages;
  } finally {
    // v6 API: teardown lives on the loading task, not the document —
    // and it must run on the reject path too, or a failed parse leaks
    // the task's resources.
    await loadingTask.destroy();
  }
}

/**
 * Extracts at most `maxPages` pages, each truncated to `maxPageChars`
 * characters — the caps keep one pathological file from unbounding the
 * sweep; both bounds belong to the caller (the DocumentPage contract).
 * Callers must not reuse `bytes` after the call: pdfjs v6 transfers
 * the underlying ArrayBuffer, so the caller's array reads as 0 bytes
 * afterwards (countPdfPages copies for exactly this reason).
 */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: { maxPages: number; maxPageChars: number },
): Promise<ExtractedPdf> {
  const loadingTask = getDocument({
    data: bytes,
    // No filesystem lookups: the bundle ships no cmap/font assets, and
    // text extraction does not render glyphs.
    useSystemFonts: false,
    // Errors only: the default level warns per document about the very
    // font data the line above declines — noise, not signal, at one
    // line per swept document.
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      // ONLY the parser's verdicts about the BYTES are deterministic
      // (corrupt data, encryption) — those become PdfNotReadableError
      // and the sweep records terminal FAILED. Anything else here is the
      // ENVIRONMENT failing (found live: the image shipped without
      // pdf.worker.mjs, and the resulting setup error was misclassified
      // as unreadable documents — a wrong PERMANENT verdict on healthy
      // bytes). Environmental errors propagate raw; the sweep leaves the
      // document pending and the next tick retries.
      if (err instanceof InvalidPDFException || err instanceof PasswordException) {
        throw new PdfNotReadableError(err.message);
      }
      throw err;
    }

    const pages: string[] = [];
    const pageCount = Math.min(doc.numPages, opts.maxPages);
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Items carry positioned runs; joining on spaces and collapsing
      // whitespace yields the quotable reading order for text-layer
      // documents (columns/tables are best-effort by nature).
      //
      // U+0000 is stripped BEFORE the whitespace collapse (so a NUL
      // between spaces still collapses to one). Postgres jsonb can
      // never store \u0000 — a hard engine rule ("unsupported Unicode
      // escape sequence"), not a schema choice — and the sweep's
      // untyped persist error reads as transient, so ONE such page
      // wedges the document in an eternal per-tick retry (live-
      // observed 2026-08-13: a Chrome print-to-pdf with a ToUnicode
      // gap maps unmapped glyphs to U+0000, and documents are
      // immutable so the poison pill could not even be deleted). A
      // glyph the generator failed to map carries no text anyway;
      // dropping it loses nothing quotable.
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\u0000/g, "")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(text.slice(0, opts.maxPageChars));
      page.cleanup();
    }
    return {
      pages,
      noTextLayer: pages.reduce((chars, p) => chars + p.length, 0) < MIN_MEANINGFUL_CHARS,
    };
  } finally {
    // v6 API: teardown lives on the loading task, not the document —
    // and it must run on the reject path too, or a failed parse leaks
    // the task's resources.
    await loadingTask.destroy();
  }
}
