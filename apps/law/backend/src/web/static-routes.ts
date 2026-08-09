/**
 * Static serving for the web app's built SPA (T04b D1): the web app is
 * served by THIS process from the same origin as the API, which is what
 * makes DD-005 D5's cookie assumption true by construction — the
 * SameSite=Strict, host-only refresh cookie needs no CORS, no proxy, and
 * no deployment-time domain care.
 *
 * Deliberately a boolean handler like file-routes: the server composes
 * transports in one visible chain. This handler owns every GET/HEAD that
 * is not API surface; unknown non-GET paths fall through to Connect,
 * whose error answers are part of the uniform contract.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/**
 * Connect service paths are `/{package.Service}/{Method}` and every
 * service this backend mounts lives under a `stigmer.`-prefixed package —
 * that prefix IS the API path space, so the static handler must never
 * answer inside it (an unknown RPC must get Connect's 404, not
 * index.html).
 */
const CONNECT_PATH_PREFIX = "/stigmer.";

/**
 * MIME map for what Vite emits (plus the favicon family). Anything
 * unlisted downloads as octet-stream rather than guessing.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * Returns true when the request was answered as static content; false
 * lets the caller fall through to the Connect adapter. Mirrors
 * file-routes' contract so server.ts stays a one-line-per-transport chain.
 */
export function createStaticRoutes(rootDir: string): (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, "index.html");

  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return false;
    }
    const rawPath = (req.url ?? "").split("?")[0] ?? "";
    if (rawPath.startsWith(CONNECT_PATH_PREFIX)) {
      return false;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      respondNotFound(res);
      return true;
    }
    // Traversal guard: resolve inside the root and refuse anything that
    // escapes it (or smuggles a null byte past path handling).
    if (decoded.includes("\0")) {
      respondNotFound(res);
      return true;
    }
    const resolved = path.resolve(root, "." + path.posix.normalize("/" + decoded));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      respondNotFound(res);
      return true;
    }

    if (isFile(resolved)) {
      serveFile(res, req.method === "HEAD", resolved, cacheControlFor(root, resolved));
      return true;
    }

    // SPA fallback: client-routed paths (/cases/123, /inbox, …) have no
    // file on disk — the router owns them, so every miss that isn't a
    // hashed-asset lookup answers index.html. Asset misses answer 404:
    // a stale HTML referencing a gone bundle must fail loudly, not
    // receive index.html as if it were JavaScript.
    if (path.extname(decoded) !== "" && decoded !== "/index.html") {
      respondNotFound(res);
      return true;
    }
    if (!isFile(indexPath)) {
      respondNotFound(res);
      return true;
    }
    serveFile(res, req.method === "HEAD", indexPath, "no-store");
    return true;
  };
}

/**
 * Vite content-hashes everything under assets/, so those are immutable
 * forever; index.html is the one mutable entry point and is never cached
 * (no-store) so a deploy is visible on the next load. Everything else
 * (favicons, manifests) revalidates.
 */
function cacheControlFor(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  if (relative === "index.html") {
    return "no-store";
  }
  if (relative.startsWith("assets" + path.sep)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function serveFile(
  res: ServerResponse,
  headOnly: boolean,
  filePath: string,
  cacheControl: string,
): void {
  const stat = statSync(filePath);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "cache-control": cacheControl,
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function respondNotFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/**
 * The built layout's web root: build.mjs copies the web app's dist to
 * `dist/public` beside the bundle (the migrations-copy precedent — the
 * image carries no source trees). Absent in dev and in tests, where the
 * Vite dev server (dev) or nothing (tests) serves the front end.
 */
export function detectWebRoot(moduleDir: string): string | undefined {
  const bundled = path.join(moduleDir, "public");
  return existsSync(path.join(bundled, "index.html")) ? bundled : undefined;
}
