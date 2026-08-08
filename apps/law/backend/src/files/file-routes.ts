/**
 * The document byte routes — the plain-HTTP half of the Document resource
 * (T03 D6). Bytes never ride Connect unary: upload is
 * `POST /files/cases/{caseId}/documents` (raw body + headers), download is
 * `GET /files/documents/{id}/content` (a stream the browser can save).
 *
 * These routes are the second transport, not a second implementation:
 * identity comes from the same authenticator chain (auth/auth.ts, its
 * plain-HTTP binding), authorization from the same policy module, and the
 * row is created by the same pipeline through the in-process invoker. What is deliberately different
 * is the ORDER: the object is uploaded BEFORE the row is created, so the
 * only possible inconsistency is an invisible unreferenced object — a
 * persisted document can never 404 on download. On pipeline failure the
 * object is deleted best-effort; a missed cleanup is harmless (nothing
 * references it) and cheap.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  AuthorizationPolicy,
  CallerPrincipal,
  ResourceStore,
} from "@stigmer/resource-api";
import type { CallerResolver } from "@stigmer/identity";
import {
  type Document,
  DocumentSchema,
} from "../gen/stigmer/law/document/v1/document_pb.js";
import { create } from "@bufbuild/protobuf";
import type { ObjectStore } from "../objectstore/object-store.js";

/** The contract's upload limit (T01 owner decision 4). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

const UPLOAD_PATH = /^\/files\/cases\/([A-Za-z0-9_-]+)\/documents$/;
const DOWNLOAD_PATH = /^\/files\/documents\/([A-Za-z0-9_-]+)\/content$/;

export interface FileRouteDeps {
  readonly policy: AuthorizationPolicy;
  /** The identity chain's plain-HTTP binding — the same chain Connect uses. */
  readonly caller: CallerResolver["fromHttp"];
  readonly store: ResourceStore;
  readonly objectStore: ObjectStore;
  readonly createDocument: (input: Document, caller: CallerPrincipal) => Promise<Document>;
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

  const body = await readBodyCapped(req);
  if (body.byteLength === 0) {
    throw new ConnectError("Document: the upload body is empty", Code.InvalidArgument);
  }

  // Upload FIRST (see the header comment for why). The key follows the
  // contract's cases/{case_id}/documents/… shape; the leaf is a fresh
  // UUID rather than the row id, which does not exist until the pipeline
  // creates it — uniqueness is the property that matters.
  const objectKey = `cases/${caseId}/documents/${randomUUID()}`;
  await deps.objectStore.put(objectKey, body, mimeType);

  let document: Document;
  try {
    document = await deps.createDocument(
      create(DocumentSchema, {
        spec: {
          caseId,
          fileName,
          mimeType,
          sizeBytes: BigInt(body.byteLength),
          objectKey,
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
      if (total > MAX_UPLOAD_BYTES) {
        req.off("data", onData);
        req.pause();
        reject(
          new ConnectError(
            `Document: upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
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
