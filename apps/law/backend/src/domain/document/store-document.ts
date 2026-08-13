/**
 * The one implementation of "store a file as a case document" — every
 * byte transport composes THIS function, none re-performs its steps.
 * Extracted from the upload route when the assistant's attach_document
 * verb became the third way bytes arrive (browser upload, agent
 * hand-off; a future channel is the fourth), because the invariants
 * below are cross-transport and must not fork:
 *
 * - The object is uploaded BEFORE the row is created, so the only
 *   possible inconsistency is an invisible unreferenced object — a
 *   persisted document can never 404 on download. On pipeline failure
 *   the object is deleted best-effort; a missed cleanup is harmless
 *   (nothing references it) and cheap.
 * - The row is created through the invoke pipeline AS THE REAL CALLER,
 *   so the policy's create rule and the case-membership guard
 *   (document-resource.ts beforePersist) apply to the person, never to
 *   the transport.
 * - The object key follows the contract's `cases/{case_id}/documents/…`
 *   shape; the leaf is a fresh UUID rather than the row id, which does
 *   not exist until the pipeline creates it — uniqueness is the
 *   property that matters.
 *
 * Transports keep their own EARLIEST-POINT checks in front of this
 * (the upload route pre-authorizes before reading the body; the
 * attach_document verb pre-authorizes before fetching remote bytes)
 * with transport-worded errors — the "one policy, two enforcement
 * points" arrangement. The checks here are the transport-agnostic
 * floor a new transport cannot forget.
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerPrincipal } from "@stigmer/resource-api";
import {
  type Document,
  DocumentCategory,
  DocumentSchema,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import type { ObjectStore } from "../../objectstore/object-store.js";

/** The contract's upload limit (T01 owner decision 4), for every
 * transport — the route caps its request body with it and the verb
 * caps its remote fetch with it. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** What the firm's file room accepts (T01 contract): court papers are
 * PDFs, and photographed papers arrive as PNG/JPG. */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export interface StoreCaseDocumentDeps {
  readonly objectStore: ObjectStore;
  readonly createDocument: (input: Document, caller: CallerPrincipal) => Promise<Document>;
}

export interface CaseDocumentInput {
  readonly caseId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly category: DocumentCategory;
  readonly hearingId?: string;
}

/** "vakalatnama" → the enum; empty → unspecified; anything else is a
 * caller mistake worth naming (a typo'd category silently landing in
 * OTHER would misfile the record). The category vocabulary every byte
 * transport speaks — the upload route reads it from a header, the
 * attach_document verb from a tool argument. */
export function parseCategoryWord(word: string): DocumentCategory {
  if (!word) return DocumentCategory.UNSPECIFIED;
  const key = word.trim().toUpperCase();
  const value = (DocumentCategory as Record<string, unknown>)[key];
  if (typeof value !== "number" || value === DocumentCategory.UNSPECIFIED) {
    throw new ConnectError(
      `Document: unknown category '${word}' (use pleading, application, evidence, ` +
        `order_judgment, correspondence, vakalatnama, judgment, or other)`,
      Code.InvalidArgument,
    );
  }
  return value as DocumentCategory;
}

export async function storeCaseDocument(
  deps: StoreCaseDocumentDeps,
  input: CaseDocumentInput,
  caller: CallerPrincipal,
): Promise<Document> {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new ConnectError(
      `Document: content-type '${input.mimeType || "(none)"}' is not supported ` +
        `(PDF, PNG, and JPG only)`,
      Code.InvalidArgument,
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new ConnectError("Document: the file is empty", Code.InvalidArgument);
  }
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ConnectError(
      `Document: the file exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`,
      Code.ResourceExhausted,
    );
  }

  const objectKey = `cases/${input.caseId}/documents/${randomUUID()}`;
  await deps.objectStore.put(objectKey, input.bytes, input.mimeType);

  try {
    return await deps.createDocument(
      create(DocumentSchema, {
        spec: {
          caseId: input.caseId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.bytes.byteLength),
          objectKey,
          category: input.category,
          hearingId: input.hearingId,
        },
      }),
      caller,
    );
  } catch (err) {
    // The row never existed; remove the just-uploaded object. Best
    // effort: a missed cleanup is an invisible orphan, not a bug a user
    // can see.
    await deps.objectStore.delete(objectKey).catch((cleanupErr) => {
      console.error(`orphan object cleanup failed (key=${objectKey}):`, cleanupErr);
    });
    throw err;
  }
}
