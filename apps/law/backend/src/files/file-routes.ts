/**
 * The document byte routes — the plain-HTTP half of the Document resource
 * (T03 D6). Bytes never ride Connect unary: upload is
 * `POST /files/cases/{caseId}/documents` (raw body + headers), download is
 * `GET /files/documents/{id}/content` (a stream the browser can save).
 *
 * These routes are the second transport, not a second implementation:
 * identity comes from the same authenticator chain (auth/auth.ts, its
 * plain-HTTP binding), authorization from the same policy module, and the
 * store choreography (object PUT before row create, orphan cleanup) is
 * the shared domain core (domain/document/store-document.ts) — the same
 * one implementation the assistant's attach_document verb composes.
 * What lives HERE is only what is transport-shaped: header parsing, the
 * streaming body cap, and HTTP status mapping.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  AuthorizationPolicy,
  ResourceStore,
} from "@stigmer/resource-api";
import type { CallerResolver } from "@stigmer/identity";
import {
  type Document,
  DocumentCategory,
  DocumentSchema,
} from "../gen/stigmer/law/document/v1/document_pb.js";
import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  storeCaseDocument,
  type StoreCaseDocumentDeps,
} from "../domain/document/store-document.js";

const UPLOAD_PATH = /^\/files\/cases\/([A-Za-z0-9_-]+)\/documents$/;
const DOWNLOAD_PATH = /^\/files\/documents\/([A-Za-z0-9_-]+)\/content$/;

export interface FileRouteDeps extends StoreCaseDocumentDeps {
  readonly policy: AuthorizationPolicy;
  /** The identity chain's plain-HTTP binding — the same chain Connect uses. */
  readonly caller: CallerResolver["fromHttp"];
  readonly store: ResourceStore;
}

/**
 * Returns true when the request was a file route (and is being handled);
 * false lets the caller fall through to the Connect adapter.
 */
export function createFileRoutes(deps: FileRouteDeps): (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean {
  return (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";

    const upload = req.method === "POST" ? UPLOAD_PATH.exec(path) : null;
    if (upload) {
      void handleUpload(deps, req, res, upload[1] as string).catch((err) =>
        sendError(res, err),
      );
      return true;
    }

    const download = req.method === "GET" ? DOWNLOAD_PATH.exec(path) : null;
    if (download) {
      void handleDownload(deps, req, res, download[1] as string).catch((err) =>
        sendError(res, err),
      );
      return true;
    }

    return false;
  };
}

async function handleUpload(
  deps: FileRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  caseId: string,
): Promise<void> {
  const caller = await deps.caller(req);
  if (!caller) {
    throw new ConnectError("Authentication required", Code.Unauthenticated);
  }
  // Pre-authorization BEFORE any byte is accepted — the same policy
  // module the pipeline consults ("one policy, two enforcement points").
  // The pipeline authorizes again after upload; this early check is what
  // keeps unauthorized bytes out of the bucket, and it is the seam where
  // per-case grants (FR-USER-002) will bite when they land.
  const decision = await deps.policy.authorize({
    caller,
    kind: "Document",
    operation: "create",
    resource: undefined,
  });
  if (!decision.allow) {
    throw new ConnectError(decision.reason, Code.PermissionDenied);
  }

  const mimeType = (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ConnectError(
      `Document: content-type '${mimeType || "(none)"}' is not supported ` +
        `(PDF, PNG, and JPG only)`,
      Code.InvalidArgument,
    );
  }

  // Filenames are user text (often not ASCII — party names, Hindi); HTTP
  // headers are ASCII, so the client URI-encodes and we decode.
  const rawName = req.headers["x-file-name"];
  const encodedName = Array.isArray(rawName) ? rawName[0] : rawName;
  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedName ?? "");
  } catch {
    throw new ConnectError("Document: x-file-name header is not valid URI encoding", Code.InvalidArgument);
  }
  if (!fileName) {
    throw new ConnectError("Document: x-file-name header is required", Code.InvalidArgument);
  }

  // The rebuild's Document upgrades ride headers the same way the file
  // name does: category as the enum's lowercase word ("pleading",
  // "vakalatnama", …) and an optional hearing link. Both optional —
  // an uncategorized upload lands honestly in the unspecified bucket.
  const category = parseCategory(headerValue(req, "x-document-category"));
  const hearingId = headerValue(req, "x-hearing-id") || undefined;

  const body = await readBodyCapped(req);
  if (body.byteLength === 0) {
    throw new ConnectError("Document: the upload body is empty", Code.InvalidArgument);
  }

  const document = await storeCaseDocument(
    deps,
    { caseId, fileName, mimeType, bytes: body, category, hearingId },
    caller,
  );

  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify(toJson(DocumentSchema, document)));
}

async function handleDownload(
  deps: FileRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const caller = await deps.caller(req);
  if (!caller) {
    throw new ConnectError("Authentication required", Code.Unauthenticated);
  }

  // Load before authorize — the same ordering invariant as the pipeline
  // (missing answers NOT_FOUND, not PERMISSION_DENIED).
  const document = (await deps.store.getById("Document", id)) as Document | undefined;
  if (!document) {
    throw new ConnectError(`Document '${id}' not found`, Code.NotFound);
  }
  const decision = await deps.policy.authorize({
    caller,
    kind: "Document",
    operation: "download",
    resource: document,
  });
  if (!decision.allow) {
    throw new ConnectError(decision.reason, Code.PermissionDenied);
  }

  const objectKey = document.spec?.objectKey ?? "";
  const stored = await deps.objectStore.get(objectKey);
  if (!stored) {
    // Cannot happen by construction (object precedes row) — if it does,
    // it is data corruption, not a client mistake.
    throw new ConnectError(
      `Document '${id}' has no stored object (key=${objectKey})`,
      Code.Internal,
    );
  }

  const fileName = document.spec?.fileName ?? "document";
  res.writeHead(200, {
    "content-type": document.spec?.mimeType ?? "application/octet-stream",
    "content-length": String(document.spec?.sizeBytes ?? stored.contentLength ?? ""),
    // RFC 5987 for non-ASCII names, plus an ASCII fallback.
    "content-disposition":
      `attachment; filename="${fileName.replace(/[^\x20-\x7e]|"/g, "_")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  stored.body.pipe(res);
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

/** "vakalatnama" → the enum; empty → unspecified; anything else is a
 * client mistake worth naming (a typo'd category silently landing in
 * OTHER would misfile the record). */
function parseCategory(word: string): DocumentCategory {
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

/**
 * Reads the whole body, failing fast past the 25 MB contract cap. On
 * breach the stream is paused (NOT destroyed — killing the socket would
 * turn the 413 into a connection reset the client cannot read; errors
 * are UX). Node tears the connection down after the response completes.
 */
function readBodyCapped(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        req.off("data", onData);
        req.pause();
        reject(
          new ConnectError(
            `Document: upload exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`,
            Code.ResourceExhausted,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Errors use the SAME vocabulary as the Connect surface (the uniform
 * error contract), translated to HTTP statuses the way connect-es maps
 * codes; the body carries code and message as JSON.
 */
function sendError(res: ServerResponse, err: unknown): void {
  const cerr = ConnectError.from(err);
  if (cerr.code === Code.Internal) {
    console.error("file route internal error:", err);
  }
  if (!res.headersSent) {
    // connection: close tells the client to stop sending any remaining
    // body (the oversize case) and read the answer.
    res.writeHead(httpStatus(cerr.code), {
      "content-type": "application/json",
      connection: "close",
    });
    res.end(JSON.stringify({ code: Code[cerr.code], message: cerr.rawMessage }));
  } else {
    res.destroy();
  }
}

function httpStatus(code: Code): number {
  switch (code) {
    case Code.InvalidArgument:
      return 400;
    case Code.Unauthenticated:
      return 401;
    case Code.PermissionDenied:
      return 403;
    case Code.NotFound:
      return 404;
    case Code.AlreadyExists:
      return 409;
    case Code.FailedPrecondition:
      return 412;
    case Code.ResourceExhausted:
      return 413;
    default:
      return 500;
  }
}
