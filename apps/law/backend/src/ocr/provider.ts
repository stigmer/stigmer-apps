/**
 * The OCR provider port (DD-009): bytes in, per-page text out. The
 * provider is a swap seam — the sweep never learns a provider's name,
 * so a failed accuracy validation changes this directory and nothing
 * else (the Document AI adapter is the first implementation; Mistral
 * was the runner-up and would slot in behind the same interface).
 *
 * Error classification is three-way and carried by TYPE (the
 * PdfNotReadableError pattern — the sweep classifies by instanceof,
 * never by message):
 *
 * 1. OcrBytesRejectedError — the provider deterministically rejected
 *    the BYTES. Terminal for the document (OCR_FAILED): the same bytes
 *    fail identically every tick, so retrying is a poison-pill loop.
 * 2. OcrConfigurationError — credentials, processor, or permissions
 *    are wrong. This must NEVER become a document verdict (the
 *    session-14 lesson: machinery state must not be written as
 *    document state) — the sweep logs the fix and aborts the tick,
 *    leaving every document NO_TEXT_LAYER and retryable.
 * 3. Anything else thrown is transient by convention (429/5xx/network)
 *    — retried by later ticks inside the sweep's cost guard.
 */

export interface OcrPage {
  /** 1-based page number, matching the physical document. */
  readonly page: number;
  readonly text: string;
  /** BCP-47 tag the provider detected; empty when not reported. */
  readonly language: string;
  /** Provider-reported confidence 0-1; 0 when not reported. */
  readonly confidence: number;
}

export interface OcrProvider {
  /** The provider's per-call page ceiling. The SWEEP chunks a
   * document's missing pages into batches of at most this many and
   * writes each batch's rows before the next call, so a mid-document
   * failure neither discards nor re-bills the windows that already
   * succeeded (review F6 — incremental batch writes). */
  readonly maxPagesPerCall: number;
  /** Recognize the given 1-based pages of a document. Callers must
   * pass at most maxPagesPerCall pages — the adapter asserts it. */
  recognize(bytes: Uint8Array, mimeType: string, pages: readonly number[]): Promise<OcrPage[]>;
}

/** The provider deterministically rejected the BYTES — terminal for
 * the document (see the header's three-way rule). */
export class OcrBytesRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OcrBytesRejectedError";
  }
}

/** Credentials/processor/permissions wrong — a machinery failure that
 * must never write a document verdict (see the header's three-way
 * rule). */
export class OcrConfigurationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "OcrConfigurationError";
  }
}
