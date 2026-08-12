/**
 * The extraction sweep (FR-DOC-003) — the clock-driven writer of the
 * document page store, on the reminder sweep's exact arrangement: an
 * interval loop, every write through the full pipeline as the system
 * principal, idempotent by construction (DocumentPage's composed
 * natural key answers ALREADY_EXISTS for a page already extracted),
 * multi-replica safe, bounded work per tick.
 *
 * ONE mechanism, three duties: fresh uploads (their status is unset
 * until the first sweep), the backfill of documents predating
 * extraction (also unset — no migration touches rows), and retry
 * (transient failures leave a document PENDING, and the next tick is
 * the free retry).
 *
 * The retry rule is the failure POLARITY, not a counter: deterministic
 * outcomes (parser rejection, an image upload, a missing object) write
 * a terminal status; transient outcomes (bucket or store unreachable)
 * write NOTHING and are retried by the next tick forever. A poison
 * pill cannot loop, an outage cannot strand a document.
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
} from "../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import type { ObjectStore } from "../../objectstore/object-store.js";
import { MAX_PAGES_PER_DOCUMENT } from "./document-page-resource.js";
import { extractPdfText, PdfNotReadableError } from "./pdf-text.js";

/** The DocumentPageSpec contract's per-page cap (proto max_len). */
const MAX_PAGE_CHARS = 100_000;

/** Documents per tick — one page of work, the reminder sweep's bound.
 * A backlog (the backfill) drains a page per tick rather than spiking
 * the pod; extraction is sequential for the same reason (one PDF's
 * parse in memory at a time). */
const DOCUMENTS_PER_TICK = 20;

const PENDING_TEXT = "EXTRACTION_STATE_PENDING";

export interface ExtractionSweepDeps {
  readonly store: ResourceStore;
  readonly objectStore: ObjectStore;
  readonly createDocumentPage: (
    input: DocumentPage,
    caller: CallerPrincipal,
  ) => Promise<DocumentPage>;
  /** The named status mutation (Document.recordExtraction) — generic
   * update deliberately cannot write status (commons buildUpdateState
   * keeps the stored one; status is system-owned). */
  readonly recordExtraction: (
    input: RecordDocumentExtractionRequest,
    caller: CallerPrincipal,
  ) => Promise<Document>;
}

export async function runExtractionSweepOnce(deps: ExtractionSweepDeps): Promise<void> {
  // The work queue in arrival order: status ABSENT (fresh uploads AND
  // every pre-extraction row — the automatic backfill) plus explicit
  // PENDING. Two pulls because the filter vocabulary is deliberately
  // OR-free; dedup by id in case a row transitions between them.
  const queue = new Map<string, Document>();
  for (const filter of [{ extraction: { absent: true } as const }, { extraction: PENDING_TEXT }]) {
    const { items } = await deps.store.list("Document", {
      limit: DOCUMENTS_PER_TICK,
      offset: 0,
      orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
      filter,
    });
    for (const item of items as Document[]) {
      const id = item.metadata?.id;
      if (id && queue.size < DOCUMENTS_PER_TICK) {
        queue.set(id, item);
      }
    }
  }

  for (const document of queue.values()) {
    try {
      await extractOne(deps, document);
    } catch (err) {
      // Transient by classification (extractOne wrote no status): log
      // loudly, leave the document for the next tick, keep sweeping —
      // one unreachable object must not strand the rest of the queue.
      console.error(
        `extraction sweep: document ${document.metadata?.id} left pending (retrying next tick):`,
        err,
      );
    }
  }
}

/** Starts the loop; returns a stopper. First pass immediate, so a
 * fresh boot begins the backfill without waiting an interval. */
export function startExtractionSweep(
  deps: ExtractionSweepDeps,
  intervalMs: number,
): () => void {
  const tick = () =>
    runExtractionSweepOnce(deps).catch((err) => {
      console.error("extraction sweep failed (retrying next tick):", err);
    });
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never hold the process open just to extract text
  return () => clearInterval(timer);
}

async function extractOne(deps: ExtractionSweepDeps, document: Document): Promise<void> {
  const id = document.metadata?.id ?? "";
  const spec = document.spec;
  if (!spec) return;

  // Images have no text layer by definition — the honest terminal
  // state until the OCR gate opens (DD-008).
  if (spec.mimeType !== "application/pdf") {
    await writeStatus(deps, document, ExtractionState.NO_TEXT_LAYER, 0);
    return;
  }

  // Object-store errors throw PAST this frame (transient — the caller
  // leaves the document pending). A MISSING object cannot happen by
  // construction (the object precedes the row) — it is data corruption,
  // deterministic, and recorded as FAILED rather than retried forever.
  const stored = await deps.objectStore.get(spec.objectKey);
  if (!stored) {
    console.error(`extraction sweep: document ${id} has no stored object (key=${spec.objectKey})`);
    await writeStatus(deps, document, ExtractionState.FAILED, 0);
    return;
  }
  const bytes = await readAll(stored.body);

  let extracted;
  try {
    extracted = await extractPdfText(bytes, {
      maxPages: MAX_PAGES_PER_DOCUMENT,
      maxPageChars: MAX_PAGE_CHARS,
    });
  } catch (err) {
    if (err instanceof PdfNotReadableError) {
      // Deterministic: the same bytes fail the same way every tick.
      console.warn(`extraction sweep: document ${id} not readable (${err.message})`);
      await writeStatus(deps, document, ExtractionState.FAILED, 0);
      return;
    }
    throw err;
  }

  if (extracted.noTextLayer) {
    await writeStatus(deps, document, ExtractionState.NO_TEXT_LAYER, 0);
    return;
  }

  // Pages first, status LAST: the EXTRACTED status is the promise that
  // the pages exist, so it must never precede them. Empty pages are
  // kept — page numbers must match the physical document (citations).
  for (const [index, text] of extracted.pages.entries()) {
    try {
      await deps.createDocumentPage(
        create(DocumentPageSchema, {
          spec: {
            documentId: id,
            caseId: spec.caseId,
            page: index + 1,
            text,
          },
        }),
        SYSTEM_PRINCIPAL,
      );
    } catch (err) {
      // ALREADY_EXISTS is the idempotency answering (a prior partial
      // sweep wrote this page) — anything else is transient and throws.
      if (ConnectError.from(err).code !== Code.AlreadyExists) {
        throw err;
      }
    }
  }

  await writeStatus(deps, document, ExtractionState.EXTRACTED, extracted.pages.length);
}

async function writeStatus(
  deps: ExtractionSweepDeps,
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
  // instances outright, and handing it a view over Buffer pool memory
  // would let the parser see bytes it must own.
  return Uint8Array.from(Buffer.concat(chunks));
}
