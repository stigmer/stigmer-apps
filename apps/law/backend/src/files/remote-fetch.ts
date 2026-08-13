/**
 * Guarded fetch of a remote document by URL — the byte entrance for the
 * assistant's attach_document verb. The URL arrives as MODEL-WRITTEN
 * TEXT (the agent quotes it from its execution context), so this module
 * treats every input as untrusted:
 *
 * - https only — the expected URLs are the platform's presigned R2
 *   links, which are always https.
 * - The host must resolve ONLY to public addresses. The law backend
 *   lives inside a cluster; a fetch steered at a private, loopback, or
 *   link-local address would turn the verb into a probe of internal
 *   services (SSRF). IP-literal hosts are checked directly.
 * - Redirects are refused outright — a vetted host must not bounce the
 *   request somewhere unvetted, and presigned links never redirect.
 * - The body is read under the document byte cap, aborting the moment
 *   it is exceeded (a Content-Length over the cap fails before any
 *   byte is read).
 * - The content's type comes from ITS BYTES (magic numbers), never from
 *   the Content-Type header — a header is the remote end's claim.
 *
 * Documented residual: the address check resolves DNS before fetch()
 * resolves it again, leaving a narrow rebinding window (an attacker
 * controlling a hostname's DNS could answer differently twice). Closing
 * it needs connect-time address pinning via a custom dispatcher — a new
 * dependency bought against an attack that already requires a hostile
 * URL in the agent's mouth AND attacker-controlled DNS. Revisit if the
 * threat model changes.
 *
 * `allowPrivateNetworks` exists for ONE caller: integration suites,
 * whose MinIO testcontainer lives on plain-http loopback. It relaxes
 * the scheme and address checks together (local test containers do not
 * speak TLS); production wiring never sets it.
 *
 * Error sentences are chat-facing: the MCP gate relays these codes
 * verbatim to the agent, which repeats them to a lawyer. Say what
 * happened and what to do, never how the guard works.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Code, ConnectError } from "@connectrpc/connect";
import { MAX_DOCUMENT_BYTES } from "../domain/document/store-document.js";

/** Generous for a 25 MB object on a slow leg; a presigned R2 read is
 * normally sub-second. */
const FETCH_TIMEOUT_MS = 60_000;

export interface RemoteFetchOptions {
  /** Test seam only — see the module doc. */
  readonly allowPrivateNetworks?: boolean;
}

export interface FetchedDocument {
  readonly bytes: Buffer;
  /** Derived from the content's magic bytes, never the header. */
  readonly mimeType: string;
}

export async function fetchRemoteDocument(
  url: string,
  options?: RemoteFetchOptions,
): Promise<FetchedDocument> {
  const allowPrivate = options?.allowPrivateNetworks === true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectError("Document: that is not a valid link", Code.InvalidArgument);
  }
  if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) {
    throw new ConnectError(
      "Document: only https:// links can be fetched",
      Code.InvalidArgument,
    );
  }
  if (!allowPrivate) {
    await assertPublicHost(parsed.hostname);
  }

  let response: Response;
  try {
    response = await fetch(parsed, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch() folds every transport-level failure (DNS, TLS, refused
    // connection, refused redirect, timeout) into a TypeError/AbortError
    // — one honest sentence covers them all for the person.
    throw new ConnectError(
      "Document: the link could not be reached — ask for the file to be sent again",
      Code.FailedPrecondition,
    );
  }

  if (response.status === 403 || response.status === 401 || response.status === 410) {
    // The presigned-link lifecycle failure: links are time-limited, and
    // a re-sent file arrives with a fresh one.
    throw new ConnectError(
      "Document: the file's link has expired or does not allow access — " +
        "ask for the file to be sent again",
      Code.FailedPrecondition,
    );
  }
  if (!response.ok) {
    throw new ConnectError(
      `Document: the link answered HTTP ${response.status} instead of the file`,
      Code.FailedPrecondition,
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    throw oversize();
  }

  const bytes = await readBodyCapped(response);
  const mimeType = sniffMimeType(bytes);
  if (!mimeType) {
    throw new ConnectError(
      "Document: the file is not a PDF, PNG, or JPG — only those can be " +
        "filed in the document system",
      Code.InvalidArgument,
    );
  }
  return { bytes, mimeType };
}

/** Refuses when the hostname is, or resolves to, anything non-public.
 * ALL resolved addresses must pass — a hostname answering with one
 * public and one private address is an attack shape, not a mistake. */
async function assertPublicHost(hostname: string): Promise<void> {
  const refusal = new ConnectError(
    "Document: that link's address is not reachable from the firm's " +
      "document system",
    Code.InvalidArgument,
  );

  // WHATWG URL keeps the brackets on an IPv6 literal hostname.
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(literal) !== 0) {
    if (!isPublicAddress(literal)) throw refusal;
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ConnectError(
      "Document: the link could not be reached — ask for the file to be sent again",
      Code.FailedPrecondition,
    );
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw refusal;
  }
}

/** Public = not loopback, not RFC1918/ULA private, not link-local, not
 * unspecified. IPv4-mapped IPv6 is judged by its embedded IPv4. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(address);
  if (kind === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (RFC 6598)
  return true;
}

function isPublicV6(address: string): boolean {
  const lower = address.toLowerCase();
  // IPv4-mapped forms carry the judgment of the embedded v4. The URL
  // parser canonicalizes the dotted form into hex groups
  // ("::ffff:10.0.0.1" arrives as "::ffff:a00:1"), so both spellings
  // must be unmapped.
  if (lower.startsWith("::ffff:")) {
    const rest = lower.slice("::ffff:".length);
    if (rest.includes(".")) return isPublicV4(rest);
    const groups = rest.split(":").map((g) => Number.parseInt(g, 16));
    if (groups.length > 2 || groups.some((g) => Number.isNaN(g))) return false;
    const [hi, lo] = groups.length === 2 ? [groups[0]!, groups[1]!] : [0, groups[0]!];
    return isPublicV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return false; // link-local fe80::/10
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // ULA fc00::/7
  return true;
}

function oversize(): ConnectError {
  return new ConnectError(
    `Document: the file exceeds the ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit`,
    Code.ResourceExhausted,
  );
}

/** Streams the body, aborting past the cap — trusting Content-Length
 * alone would let a lying server feed unbounded bytes. */
async function readBodyCapped(response: Response): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw oversize();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The three types the file room accepts, judged by magic numbers
 * (store-document.ts owns the allowlist; this maps bytes onto it). */
function sniffMimeType(bytes: Buffer): string | undefined {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}
