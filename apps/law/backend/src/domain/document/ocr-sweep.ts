/**
 * The OCR sweep (DD-009) — the second clock-driven writer of the
 * document page store, on the extraction sweep's exact arrangement:
 * an interval loop, every write through the full pipeline as the
 * system principal, idempotent by construction (DocumentPage's
 * composed natural key answers ALREADY_EXISTS), multi-replica safe,
 * bounded work per tick, pages-first-status-last.
 *
 * The queue predicate is NO_TEXT_LAYER: the state the extraction
 * sweep parks scans in becomes the OCR sweep's work list, so every
 * pre-OCR row re-enters automatically (the sweep pattern's backfill
 * story — no migration touches rows).
 *
 * Failure classification is the provider port's three-way rule,
 * carried by error TYPE: bytes rejected → terminal OCR_FAILED;
 * configuration wrong → abort the tick, no document verdict
 * (session-14: machinery state must not be written as document
 * state); anything else → transient, retried under backoff.
 *
 * THE ARGUED DIVERGENCE (DD-009): the sweep pattern's "retry forever,
 * no counter" rule was designed when retries were free (local
 * parsing). With a per-use provider every retry is a billed API call
 * — one stuck 200-page document retried each 5-minute tick would bill
 * ~57k pages/day — so this sweep meters: a per-tick page budget gates
 * STARTING a document, and transient failures back off exponentially
 * per document (createOcrBackoff below).
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerPrincipal, ResourceStore } from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import {
  type Document,
  ExtractionState,
  type RecordDocumentExtractionRequest,
  RecordDocumentExtractionRequestSchema,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  DocumentPageSchema,
  TextSource,
} from "../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import type { ObjectStore } from "../../objectstore/object-store.js";
import {
  OcrBytesRejectedError,
  OcrConfigurationError,
  type OcrProvider,
} from "../../ocr/provider.js";
import { MAX_PAGE_CHARS, MAX_PAGES_PER_DOCUMENT } from "./document-page-resource.js";
import { countPdfPages } from "./pdf-text.js";

/** Documents per tick — one page of work, the sibling sweeps' bound.
 * The page BUDGET below is the spending ceiling; this bounds how many
 * documents one tick PROCESSES (eligible ones — see the overfetch
 * note at the list call). */
const DOCUMENTS_PER_TICK = 20;

/** Extra rows fetched past DOCUMENTS_PER_TICK so backed-off documents
 * cannot consume every inspection slot: the list is createdAt-ordered,
 * so a head full of documents inside their backoff windows would
 * otherwise starve fresh uploads behind them for hours (review F7).
 * 80 extra slots ride one cheap indexed query and cover 4x the tick
 * bound of simultaneously backed-off documents before starvation can
 * recur — beyond that, something is wrong enough that the backoff
 * log is the real signal. */
const BACKOFF_OVERFETCH = 80;

const NO_TEXT_LAYER_TEXT = "EXTRACTION_STATE_NO_TEXT_LAYER";

/** Per-document transient-failure backoff (the argued divergence —
 * see the header). Time is a parameter so tests are deterministic. */
export interface OcrBackoff {
  isEligible(documentId: string, nowMs: number): boolean;
  recordFailure(documentId: string, nowMs: number): void;
  /** On success or a terminal verdict — the document leaves the queue. */
  evict(documentId: string): void;
}

/** Exponent cap: 2^5 = 32 intervals (~2.7h at a 5-minute tick) is
 * slow enough to stop the billing bleed without parking a document
 * for days. */
const MAX_BACKOFF_EXPONENT = 5;

/** Map bound. In-memory-per-replica is acceptable: natural-key
 * idempotency makes concurrent replicas harmless, and reset-on-restart
 * retrying once is fine — a tight loop billing all day is what the
 * backoff exists to prevent (DD-009's argued divergence from the
 * no-counter rule). */
const MAX_TRACKED_DOCUMENTS = 500;

export function createOcrBackoff(intervalMs: number): OcrBackoff {
  const entries = new Map<string, { attempts: number; eligibleAtMs: number }>();
  return {
    isEligible(documentId, nowMs) {
      const entry = entries.get(documentId);
      return !entry || nowMs >= entry.eligibleAtMs;
    },
    recordFailure(documentId, nowMs) {
      const attempts = (entries.get(documentId)?.attempts ?? 0) + 1;
      entries.set(documentId, {
        attempts,
        eligibleAtMs: nowMs + intervalMs * 2 ** Math.min(attempts, MAX_BACKOFF_EXPONENT),
      });
      if (entries.size > MAX_TRACKED_DOCUMENTS) {
        // Drop the oldest-eligible entry: it is the one whose skip
        // window ends soonest, so forgetting it costs at most one
        // early retry.
        let oldestId: string | undefined;
        let oldestAt = Infinity;
        for (const [id, entry] of entries) {
          if (entry.eligibleAtMs < oldestAt) {
            oldestAt = entry.eligibleAtMs;
            oldestId = id;
          }
        }
        if (oldestId !== undefined) {
          entries.delete(oldestId);
        }
      }
    },
    evict(documentId) {
      entries.delete(documentId);
    },
  };
}

/**
 * Chunks a page list into provider-call windows — the arithmetic the
 * adapter used to own, moved here because the SWEEP now drives one
 * provider call per batch and writes each batch's rows before the
 * next call (review F6: a mid-document failure must neither discard
 * nor re-bill the windows that already succeeded).
 */
export function chunkPages(pages: readonly number[], maxPagesPerCall: number): number[][] {
  const windows: number[][] = [];
  for (let i = 0; i < pages.length; i += maxPagesPerCall) {
    windows.push(pages.slice(i, i + maxPagesPerCall));
  }
  return windows;
}

/**
 * The budget gate's decision, pure for testing. The gate is on
 * STARTING a document (partial documents would break
 * pages-first-status-last):
 *
 * - fits the remaining budget → process;
 * - exceeds it mid-tick (budget already partly spent) → STOP the tick,
 *   so arrival order is preserved — a big document at the head of the
 *   queue is never starved by smaller ones jumping it;
 * - exceeds a WHOLE tick's budget as the tick's first document
 *   (remaining === pagesPerTick) → process it whole, or it would never
 *   run at all.
 */
export function decideBudgetGate(
  requestedPages: number,
  remainingPages: number,
  pagesPerTick: number,
): "process" | "stop" {
  if (requestedPages <= remainingPages) {
    return "process";
  }
  return remainingPages === pagesPerTick ? "process" : "stop";
}

export interface OcrSweepDeps {
  readonly store: ResourceStore;
  readonly objectStore: ObjectStore;
  readonly createDocumentPage: (
    input: DocumentPage,
    caller: CallerPrincipal,
  ) => Promise<DocumentPage>;
  /** The named status mutation (Document.recordExtraction) — the same
   * single write path the extraction sweep uses; status stays
   * system-owned. */
  readonly recordExtraction: (
    input: RecordDocumentExtractionRequest,
    caller: CallerPrincipal,
  ) => Promise<Document>;
  readonly provider: OcrProvider;
  /** The per-tick page budget — the hard spending ceiling (DD-009). */
  readonly pagesPerTick: number;
  /** Injectable for tests; startOcrSweep supplies createOcrBackoff. */
  readonly backoff?: OcrBackoff;
}

export async function runOcrSweepOnce(deps: OcrSweepDeps): Promise<void> {
  // ONE pull, single filter: the extraction sweep's two-pull dance
  // exists for its absent-status duty (the backfill of pre-extraction
  // rows), which OCR does not have — NO_TEXT_LAYER is always written
  // explicitly before a document can reach this queue. OVERFETCHED
  // past the tick bound so backed-off documents at the queue head
  // cannot starve fresh ones (BACKOFF_OVERFETCH has the argument);
  // the loop still processes at most DOCUMENTS_PER_TICK ELIGIBLE
  // documents.
  const { items } = await deps.store.list("Document", {
    limit: DOCUMENTS_PER_TICK + BACKOFF_OVERFETCH,
    offset: 0,
    orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
    filter: { extraction: NO_TEXT_LAYER_TEXT },
  });

  // Mutable on purpose: ocrOne charges it per ATTEMPTED provider
  // call, so a mid-document failure still accounts for the batches
  // that were billed before it (review F6).
  const budget = { remainingPages: deps.pagesPerTick };
  let processed = 0;
  for (const document of items as Document[]) {
    if (processed >= DOCUMENTS_PER_TICK) {
      return;
    }
    const id = document.metadata?.id;
    if (!id) continue;
    if (deps.backoff && !deps.backoff.isEligible(id, Date.now())) {
      continue;
    }
    processed += 1;
    try {
      const outcome = await ocrOne(deps, document, budget);
      if (outcome === "budget-stop") {
        // Stop the WHOLE tick rather than skipping ahead: arrival
        // order preserved (see decideBudgetGate).
        return;
      }
      deps.backoff?.evict(id);
    } catch (err) {
      if (err instanceof OcrConfigurationError) {
        // A config error afflicts every document equally — 20 billed
        // failures teach nothing 1 does, so the tick aborts. Documents
        // stay NO_TEXT_LAYER, retryable: a config error must never
        // write a document verdict (session-14).
        console.error(`ocr sweep: configuration error, aborting tick: ${err.message}`);
        return;
      }
      // Transient by classification (ocrOne wrote no status): back off
      // this document, keep sweeping — one flaky call must not strand
      // the rest of the queue.
      deps.backoff?.recordFailure(id, Date.now());
      console.error(`ocr sweep: document ${id} left NO_TEXT_LAYER (retrying):`, err);
    }
  }
}

/** Starts the loop; returns a stopper. First pass immediate, so a
 * fresh boot begins draining the NO_TEXT_LAYER backlog without
 * waiting an interval. */
export function startOcrSweep(deps: OcrSweepDeps, intervalMs: number): () => void {
  const sweepDeps: OcrSweepDeps = {
    ...deps,
    backoff: deps.backoff ?? createOcrBackoff(intervalMs),
  };
  const tick = () =>
    runOcrSweepOnce(sweepDeps).catch((err) => {
      console.error("ocr sweep failed (retrying next tick):", err);
    });
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never hold the process open just to OCR scans
  return () => clearInterval(timer);
}

type OcrOutcome = "done" | "budget-stop";

async function ocrOne(
  deps: OcrSweepDeps,
  document: Document,
  budget: { remainingPages: number },
): Promise<OcrOutcome> {
  const id = document.metadata?.id ?? "";
  const spec = document.spec;
  if (!spec) {
    return "done";
  }

  // Object-store errors throw PAST this frame (transient — the caller
  // backs off and retries). A MISSING object cannot happen by
  // construction (the object precedes the row) — it is data
  // corruption, deterministic, and recorded as FAILED rather than
  // retried forever (the extraction sweep's rule).
  const stored = await deps.objectStore.get(spec.objectKey);
  if (!stored) {
    console.error(`ocr sweep: document ${id} has no stored object (key=${spec.objectKey})`);
    await writeStatus(deps, document, ExtractionState.FAILED, 0);
    return "done";
  }
  const bytes = await readAll(stored.body);

  // The sweep measures the page count itself (countPdfPages has the
  // contract story); images are one page by definition. Capped at the
  // same 200-page bound extraction honors (MAX_PAGES_PER_DOCUMENT —
  // the DocumentPage contract's sanity bound).
  const pageCount =
    spec.mimeType === "application/pdf"
      ? Math.min(await countPdfPages(bytes), MAX_PAGES_PER_DOCUMENT)
      : 1;

  // Resume-from-partial: request only pages not already written, so a
  // mid-document transient failure (pages landed, status write did
  // not) never re-bills the pages that survived. Migration 0015's
  // document_id column serves the filter — the page-list handler's
  // exact query shape.
  const existing = await deps.store.list("DocumentPage", {
    limit: MAX_PAGES_PER_DOCUMENT,
    offset: 0,
    filter: { documentId: id },
  });
  const written = new Set(
    (existing.items as DocumentPage[]).map((page) => page.spec?.page ?? 0),
  );
  const missing: number[] = [];
  for (let page = 1; page <= pageCount; page++) {
    if (!written.has(page)) {
      missing.push(page);
    }
  }
  if (missing.length === 0) {
    // Every page already exists (a prior partial sweep) — only the
    // status write remains.
    await writeStatus(deps, document, ExtractionState.EXTRACTED, pageCount);
    return "done";
  }

  // The budget gate (DD-009's meter — the header has the argument),
  // decided on the pages actually about to be BILLED.
  if (decideBudgetGate(missing.length, budget.remainingPages, deps.pagesPerTick) === "stop") {
    return "budget-stop";
  }

  // One provider call per ≤maxPagesPerCall batch, and each batch's
  // rows are WRITTEN before the next call (review F6): a transient
  // failure on batch N leaves batches 1..N-1 landed, and the retry's
  // missing-page filter above requests only what is still unanswered
  // — resume-from-partial that saves real money. Pages-first-
  // status-last still holds: EXTRACTED is written only after EVERY
  // batch.
  for (const batch of chunkPages(missing, deps.provider.maxPagesPerCall)) {
    // Charged when the batch is ATTEMPTED, not on success: every
    // attempt is a billed API call, so the ceiling must bound spend,
    // not success (review F6).
    budget.remainingPages -= batch.length;

    let recognized;
    try {
      recognized = await deps.provider.recognize(bytes, spec.mimeType, batch);
    } catch (err) {
      if (err instanceof OcrBytesRejectedError) {
        // Deterministic: the same bytes fail the same way every tick.
        console.warn(`ocr sweep: document ${id} rejected by provider (${err.message})`);
        await writeStatus(deps, document, ExtractionState.OCR_FAILED, 0);
        return "done";
      }
      // Configuration or transient — the caller classifies by type.
      throw err;
    }

    // Coverage check BEFORE any row write (review F2): DocumentPage
    // rows are immutable and EXTRACTED dequeues forever, so a page
    // the provider did not answer must never become a permanently
    // blank row. A 200 with an error body, fieldMask drift, and a
    // missing pageNumber are the observed shapes that would all land
    // here — a plain Error, transient, retried under backoff.
    const byPage = new Map(recognized.map((page) => [page.page, page]));
    const unanswered = batch.filter((page) => !byPage.has(page));
    if (unanswered.length > 0) {
      throw new Error(
        `provider response omitted requested page(s) ${unanswered.join(", ")} ` +
          `of document ${id} — refusing to write blank rows`,
      );
    }

    // Every requested page is written even when its text is empty —
    // page numbers must match the physical document (citations; the
    // existing invariant).
    for (const page of batch) {
      const result = byPage.get(page);
      try {
        await deps.createDocumentPage(
          create(DocumentPageSchema, {
            spec: {
              documentId: id,
              caseId: spec.caseId,
              page,
              text: (result?.text ?? "").slice(0, MAX_PAGE_CHARS),
              source: TextSource.OCR,
              language: result?.language ?? "",
              confidence: result?.confidence ?? 0,
            },
          }),
          SYSTEM_PRINCIPAL,
        );
      } catch (err) {
        // ALREADY_EXISTS is the idempotency answering (a prior partial
        // sweep or a concurrent replica wrote this page) — anything else
        // is transient and throws.
        if (ConnectError.from(err).code !== Code.AlreadyExists) {
          throw err;
        }
      }
    }
  }

  await writeStatus(deps, document, ExtractionState.EXTRACTED, pageCount);
  return "done";
}

async function writeStatus(
  deps: OcrSweepDeps,
  document: Document,
  extraction: ExtractionState,
  pageCount: number,
): Promise<void> {
  await deps.recordExtraction(
    create(RecordDocumentExtractionRequestSchema, {
      id: document.metadata?.id ?? "",
      extraction,
      pageCount,
    }),
    SYSTEM_PRINCIPAL,
  );
}

async function readAll(body: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  // A PLAIN Uint8Array copy, deliberately: pdfjs v6 rejects Buffer
  // instances outright (the extraction sweep's readAll, duplicated —
  // it is unexported there).
  return Uint8Array.from(Buffer.concat(chunks));
}
