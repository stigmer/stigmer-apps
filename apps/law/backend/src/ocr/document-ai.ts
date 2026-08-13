/**
 * The Google Document AI adapter behind the OcrProvider port (DD-009,
 * gate 1 closed session 21): synchronous `:process` calls with inline
 * bytes, one page window per call — the SWEEP owns chunking and
 * writes each window's rows before requesting the next (review F6).
 * No batch mode, no GCS staging, ever (R2 stays the single byte
 * boundary). Per-page text is not a response field: it is a slice of
 * the top-level document.text through each page's layout.textAnchor
 * segments (sliceAnchoredText below).
 *
 * Error classification implements the port's three-way rule: 400 with
 * a recognized verdict about the BYTES indicts the bytes
 * (OcrBytesRejectedError); any other 400, 413, and 401/403/404 indict
 * the configuration (OcrConfigurationError naming the variable to
 * check); 429/5xx and network failures are transient (plain Error /
 * rethrown).
 */

import { createServiceAccountTokenSource, type TokenSource } from "./google-auth.js";
import {
  OcrBytesRejectedError,
  OcrConfigurationError,
  type OcrPage,
  type OcrProvider,
} from "./provider.js";

/**
 * Pages per synchronous `:process` call. The documented imageless sync
 * limit is 30, but a live 2026 report shows a sibling processor still
 * enforcing 15 despite `imagelessMode: true`; 15 is within limits
 * unconditionally, and for a background sweep the extra calls are
 * noise — raise only on proof from our own processor.
 */
export const WINDOW_PAGES = 15;

/** Sync OCR of a 15-page window runs seconds-to-tens of seconds; two
 * minutes bounds a hung call without killing a slow-but-live one. */
const PROCESS_TIMEOUT_MS = 120_000;

/**
 * HTTP 400 becomes OcrBytesRejectedError (terminal OCR_FAILED) ONLY
 * when the server's message matches one of these verdicts about the
 * BYTES (case-insensitive substrings, from Google's observed error
 * texts — "Invalid image content" was answered live to the 1x1-PNG
 * probe smoke, 2026-08-13). The rule exists because our own
 * request-shape bugs also answer 400, and a machinery bug must never
 * stamp a document verdict (the session-14 principle); an
 * unrecognized 400 is classified as configuration instead — loud,
 * retryable, and never terminal for the document.
 */
export const BYTES_REJECTED_MESSAGE_MARKERS: readonly string[] = [
  "invalid image content",
  "unsupported input file format",
  "corrupt",
  "password",
  "encrypted",
];

export interface DocumentAiConfig {
  /** Processor resource name: projects/…/locations/{loc}/processors/…. */
  readonly processor: string;
  /** Service-account key JSON — exactly one of this or tokenSource. */
  readonly credentialsJson?: string;
  /** Pre-built token source — the test seam. */
  readonly tokenSource?: TokenSource;
  /** Override for the fake-server integration tests; defaults to the
   * regional endpoint parsed from the processor name. */
  readonly endpointBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/** The `:process` response subset the adapter maps. Shape verified
 * live in the 2026-08-13 probe runs (a 2-page PDF against BOTH the
 * default and rc processor versions, plus the page-selector run),
 * recorded in stigmer-cloud _ops/probes/ocr-docai/README.md. JSON
 * int64 fields (textSegments offsets) arrive as strings. */
interface ProcessResponse {
  readonly document?: {
    readonly text?: string;
    readonly pages?: readonly {
      readonly pageNumber?: number;
      readonly detectedLanguages?: readonly {
        readonly languageCode?: string;
        readonly confidence?: number;
      }[];
      readonly layout?: {
        readonly textAnchor?: {
          readonly textSegments?: readonly {
            readonly startIndex?: string | number;
            readonly endIndex?: string | number;
          }[];
        };
      };
    }[];
  };
}

export function createDocumentAiProvider(cfg: DocumentAiConfig): OcrProvider {
  // Exactly one token authority, decided by branch so the compiler
  // narrows credentialsJson itself — no `as string` (review F15).
  const credentialsJson = cfg.credentialsJson;
  let tokenSource: TokenSource;
  if (cfg.tokenSource !== undefined) {
    if (credentialsJson !== undefined) {
      throw new OcrConfigurationError(
        "exactly one of credentialsJson or tokenSource must be provided " +
          "(two token authorities would be ambiguous)",
      );
    }
    tokenSource = cfg.tokenSource;
  } else if (credentialsJson !== undefined) {
    tokenSource = createServiceAccountTokenSource(credentialsJson);
  } else {
    throw new OcrConfigurationError(
      "exactly one of credentialsJson or tokenSource must be provided " +
        "(zero is no auth at all)",
    );
  }
  const endpointBaseUrl = cfg.endpointBaseUrl ?? defaultEndpointBaseUrl(cfg.processor);
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${endpointBaseUrl}/v1/${cfg.processor}:process`;

  return {
    maxPagesPerCall: WINDOW_PAGES,
    async recognize(bytes, mimeType, pages) {
      if (pages.length > WINDOW_PAGES) {
        // A programming error in the caller, not a provider outcome:
        // the sweep owns chunking (review F6) and must never hand the
        // adapter more than one window.
        throw new Error(
          `recognize() called with ${pages.length} pages — the caller must chunk to ` +
            `at most maxPagesPerCall (${WINDOW_PAGES})`,
        );
      }
      const content = Buffer.from(bytes).toString("base64");
      const token = await tokenSource();
      // fetch/abort rejections propagate raw — transient by the
      // port's rule.
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rawDocument: { content, mimeType },
          // imagelessMode is a TOP-LEVEL request field — nested
          // inside processOptions it is silently ignored (documented
          // community failure mode).
          imagelessMode: true,
          processOptions: { individualPageSelector: { pages } },
          fieldMask: "text,pages.pageNumber,pages.detectedLanguages,pages.layout",
        }),
        signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Drop the cached token BEFORE classifying: after a key
          // rotation the stale token would otherwise keep being
          // served for up to ~55 minutes of failing ticks (review
          // F8). The next call re-exchanges.
          tokenSource.invalidate?.();
        }
        throw await classifyHttpFailure(response);
      }
      const body = (await response.json()) as ProcessResponse;
      return mapDocument(body);
    },
  };
}

/** Region rides the hostname — parsed from the processor resource
 * name; a name without a location is a configuration problem. */
function defaultEndpointBaseUrl(processor: string): string {
  const location = /\/locations\/([^/]+)\//.exec(processor)?.[1];
  if (!location) {
    throw new OcrConfigurationError(
      `OCR_DOCAI_PROCESSOR '${processor}' carries no location segment ` +
        "(expected projects/…/locations/{loc}/processors/…)",
    );
  }
  return `https://${location}-documentai.googleapis.com`;
}

async function classifyHttpFailure(response: Response): Promise<Error> {
  const raw = await response.text();
  const serverMessage = extractServerMessage(raw);
  if (response.status === 400) {
    // Message-aware split (review F3): only the server's known
    // verdicts about the BYTES earn the terminal classification —
    // see BYTES_REJECTED_MESSAGE_MARKERS for the rule's argument.
    const lowered = serverMessage.toLowerCase();
    if (BYTES_REJECTED_MESSAGE_MARKERS.some((marker) => lowered.includes(marker))) {
      return new OcrBytesRejectedError(
        `Document AI rejected the document bytes (HTTP 400): ${serverMessage}`,
      );
    }
    return new OcrConfigurationError(
      `Document AI answered HTTP 400 with an unrecognized message: ${serverMessage} — ` +
        "likely a request-shape problem in this adapter, not the document; " +
        "no document verdict is written (session-14)",
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new OcrConfigurationError(
      `Document AI answered HTTP ${response.status}: ${serverMessage} — ` +
        "check OCR_DOCAI_CREDENTIALS_JSON (service-account key and its " +
        "roles/documentai.apiUser grant)",
    );
  }
  if (response.status === 404) {
    return new OcrConfigurationError(
      `Document AI answered HTTP 404: ${serverMessage} — ` +
        "check OCR_DOCAI_PROCESSOR (processor resource name and region)",
    );
  }
  if (response.status === 413) {
    // Payload too large is OUR sizing problem (window arithmetic or
    // the inline-bytes ceiling), never the document's fault — a
    // configuration verdict, explicitly (review F3).
    return new OcrConfigurationError(
      `Document AI answered HTTP 413 (payload too large): ${serverMessage} — ` +
        "an adapter sizing problem, not a document verdict",
    );
  }
  // 429 and 5xx: transient by the port's rule — a plain Error the
  // sweep retries under its cost guard.
  return new Error(`Document AI answered HTTP ${response.status}: ${serverMessage}`);
}

/** Google's error envelope is { error: { message } }; fall back to the
 * raw body when the shape surprises. */
function extractServerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string" && parsed.error.message !== "") {
      return parsed.error.message;
    }
  } catch {
    // Not JSON — the raw text is the message.
  }
  return raw;
}

/**
 * Maps one `:process` response. PINNED FACT (live-verified 2026-08-13,
 * the page-selector probe run in stigmer-cloud
 * _ops/probes/ocr-docai/README.md): with individualPageSelector,
 * document.text contains ONLY the selected pages' text and textAnchor
 * offsets are REBASED to that filtered text, while pageNumber keeps
 * ORIGINAL numbering — per-response slicing is mandatory; anchors
 * never index across windows.
 */
function mapDocument(body: ProcessResponse): OcrPage[] {
  const text = body.document?.text ?? "";
  // Encoded ONCE per response, not per page (review F10): anchors
  // index the same document.text for every page in the window.
  const textBytes = Buffer.from(text, "utf8");
  const pages: OcrPage[] = [];
  for (const page of body.document?.pages ?? []) {
    const pageNumber = page.pageNumber;
    if (pageNumber === undefined) {
      // Cannot place text without a page number. Skipping here is
      // safe because the SWEEP verifies every requested page is
      // answered before writing any row (review F2) — an omitted
      // pageNumber surfaces there as a transient error, never as a
      // silently blank row.
      continue;
    }
    // Best-of selection: the provider may report several candidate
    // languages per page; the row stores the most confident one.
    let language = "";
    let confidence = 0;
    for (const detected of page.detectedLanguages ?? []) {
      const detectedConfidence = detected.confidence ?? 0;
      if (detected.languageCode !== undefined && detectedConfidence >= confidence) {
        language = detected.languageCode;
        confidence = detectedConfidence;
      }
    }
    pages.push({
      page: pageNumber,
      text: sliceAnchoredText(textBytes, page.layout?.textAnchor?.textSegments ?? []),
      language,
      confidence,
    });
  }
  return pages;
}

/**
 * Slices a page's text out of the UTF-8 encoding of the top-level
 * document.text (pre-encoded by the caller — once per response, not
 * per page) through its textAnchor segments. Protobuf string offsets
 * index the UTF-8 ENCODING, not UTF-16 code units — slicing must
 * happen over the byte encoding or any non-ASCII document (Telugu
 * court papers are the proof case) shears mid-character. JSON int64
 * arrives as strings, and startIndex is OMITTED when 0 (proto3 JSON
 * drops zero values). Unit-tested with non-ASCII below; to be
 * re-verified on real multilingual output at the T11 validation.
 */
export function sliceAnchoredText(
  textBytes: Buffer,
  segments: readonly { startIndex?: string | number; endIndex?: string | number }[],
): string {
  const parts: Buffer[] = [];
  for (const segment of segments) {
    const start = segment.startIndex === undefined ? 0 : Number(segment.startIndex);
    const end = segment.endIndex === undefined ? 0 : Number(segment.endIndex);
    // Guard the parsed offsets: Number() of a corrupted int64 string
    // silently loses precision past 2^53, and Buffer.subarray would
    // clamp NaN to 0 — both would shear text without a trace. A real
    // document cannot reach the guard honestly: 2^53 bytes is ~9
    // petabytes of recognized text, while the inline-bytes request
    // ceiling alone caps a response's text megabytes short of that.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error(
        `textAnchor segment carries a non-safe-integer offset ` +
          `(startIndex=${String(segment.startIndex)}, endIndex=${String(segment.endIndex)})`,
      );
    }
    parts.push(textBytes.subarray(start, end));
  }
  return Buffer.concat(parts).toString("utf8");
}
