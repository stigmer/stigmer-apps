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
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
 * Extracts at most `maxPages` pages, each truncated to `maxPageChars`
 * characters — the caps keep one pathological file from unbounding the
 * sweep; both bounds belong to the caller (the DocumentPage contract).
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
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    throw new PdfNotReadableError(err instanceof Error ? err.message : String(err));
  }

  try {
    const pages: string[] = [];
    const pageCount = Math.min(doc.numPages, opts.maxPages);
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Items carry positioned runs; joining on spaces and collapsing
      // whitespace yields the quotable reading order for text-layer
      // documents (columns/tables are best-effort by nature).
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
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
    // v6 API: teardown lives on the loading task, not the document.
    await loadingTask.destroy();
  }
}
