/**
 * The document byte routes' client (T04b D7) — the ONE sanctioned
 * non-Connect data access (003_web_engineer): bytes never ride Connect
 * unary (T03 D6), so upload POSTs raw bytes to
 * /files/cases/{caseId}/documents and download GETs
 * /files/documents/{id}/content, both carrying the same bearer the
 * Connect interceptor attaches (the byte routes resolve callers from the
 * Authorization header ONLY — a cookie never reaches them).
 *
 * Client-side pre-checks mirror the server's limits for immediate
 * feedback; the server stays the authority (its checks run regardless).
 */

import { fromJson } from "@bufbuild/protobuf";
import {
  type Document,
  DocumentSchema,
} from "../gen/stigmer/law/document/v1/document_pb.js";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from "../lib/contract.js";
import type { TokenSource } from "./transport.js";

/** The shelf entry's identity (DD-012 D2), captured at filing time —
 * all optional; the server defaults the title from the file name and
 * the Citation stays correctable after. */
export interface CitationIdentity {
  readonly title?: string;
  readonly court?: string;
  readonly year?: number;
  readonly citation?: string;
}

export interface FilesClient {
  /** Case filing; category rides the header ("pleading", "evidence",
   * …) — empty lands honestly in the unspecified bucket. */
  uploadDocument(caseId: string, file: File, category?: string): Promise<Document>;
  /** The firm library's front door (FR-DOC-005): case-less
   * public-record material — always category 'judgment', the one
   * library category. The shelf entry's identity rides beside the
   * bytes (DD-012 D2). */
  uploadLibraryDocument(file: File, identity?: CitationIdentity): Promise<Document>;
  downloadDocument(documentId: string): Promise<Blob>;
}

export function createFilesClient(
  baseUrl: string,
  session: Pick<TokenSource, "getAccessToken">,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): FilesClient {
  async function authorization(): Promise<string> {
    return `Bearer ${await session.getAccessToken()}`;
  }

  function preCheck(file: File): void {
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      throw new Error(
        `'${file.name}' is not a supported type — upload a PDF, PNG, or JPG (FR-INTEG-001).`,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `'${file.name}' is larger than the 25 MB limit — split or compress it.`,
      );
    }
  }

  return {
    async uploadDocument(caseId, file, category) {
      preCheck(file);
      const res = await fetchImpl(`${baseUrl}/files/cases/${encodeURIComponent(caseId)}/documents`, {
        method: "POST",
        headers: {
          authorization: await authorization(),
          "content-type": file.type,
          // Filenames are user text (party names, often non-ASCII); HTTP
          // headers are ASCII, so the client URI-encodes and the server
          // decodes (the byte-route contract).
          "x-file-name": encodeURIComponent(file.name),
          ...(category ? { "x-document-category": category } : {}),
        },
        body: file,
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      return fromJson(DocumentSchema, await res.json());
    },

    async uploadLibraryDocument(file, identity) {
      preCheck(file);
      const res = await fetchImpl(`${baseUrl}/files/library/documents`, {
        method: "POST",
        headers: {
          authorization: await authorization(),
          "content-type": file.type,
          "x-file-name": encodeURIComponent(file.name),
          "x-document-category": "judgment",
          // Identity is user text like the file name: URI-encoded.
          ...(identity?.title
            ? { "x-citation-title": encodeURIComponent(identity.title) }
            : {}),
          ...(identity?.court
            ? { "x-citation-court": encodeURIComponent(identity.court) }
            : {}),
          ...(identity?.year ? { "x-citation-year": String(identity.year) } : {}),
          ...(identity?.citation
            ? { "x-citation-string": encodeURIComponent(identity.citation) }
            : {}),
        },
        body: file,
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      return fromJson(DocumentSchema, await res.json());
    },

    async downloadDocument(documentId) {
      const res = await fetchImpl(
        `${baseUrl}/files/documents/${encodeURIComponent(documentId)}/content`,
        { headers: { authorization: await authorization() } },
      );
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      return res.blob();
    },
  };
}

/**
 * The byte routes answer errors as {code, message} JSON in the Connect
 * code vocabulary — the message is the UX, same as everywhere else.
 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // Non-JSON error (a proxy, a dead server) — fall through.
  }
  return `The server answered ${res.status} — try again, and sign in again if it persists.`;
}
