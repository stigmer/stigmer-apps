/**
 * The MCP listener — a SECOND http server beside the app's (T05,
 * DD-008), bound to its own cluster-internal port so the tool surface
 * has no public attack surface at all (verified in Stage 0: the agent
 * sandboxes share the firm's cluster, and multi-port services are the
 * platform's proven shape).
 *
 * Request order is itself a security property:
 *
 *   1. /healthz answers first (and never touches the database — a store
 *      outage must degrade answers, not restart the pod).
 *   2. The shared secret is compared in CONSTANT TIME before any other
 *      header is read. Nothing below runs for an unauthenticated caller.
 *   3. Only then are the caller-identity headers parsed.
 *
 * The trust model (DD-008, pinned by a test rather than hidden):
 * whoever holds the shared secret can assert ANY lawyer's identity. The
 * headers are runner-asserted, not signed — they close the
 * prompt-injection hole (identity never passes through the model), and
 * the secret is the entire remaining boundary. Hence: no insecure mode,
 * a minimum secret length, and no ingress.
 *
 * Stateless streamable HTTP: one McpServer + one transport per request,
 * torn down when the response closes. Sessions would add a second place
 * identity could live; statelessness makes the per-request identity
 * arrangement structural.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callerIdentityFromHeaders, identityLogToken } from "./identity.js";
import { buildFirmMcpServer } from "./server.js";
import type { ToolDeps } from "./tools/shared.js";

export const MCP_PATH = "/mcp";

export interface McpTransportOptions {
  readonly sharedSecret: string;
}

/** Constant-time comparison; hashing first so lengths never leak. */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(req: http.IncomingMessage): string {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1] ?? "";
}

function deny(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }) + "\n");
}

export function createMcpHttpServer(
  options: McpTransportOptions,
  deps: ToolDeps,
): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, options, deps).catch((err) => {
      console.error("mcp transport failure:", err);
      if (!res.headersSent) {
        deny(res, 500, "internal error");
      } else {
        res.end();
      }
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: McpTransportOptions,
  deps: ToolDeps,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // The gate. Nothing below this line runs for an unauthenticated caller.
  if (!secretMatches(bearerToken(req), options.sharedSecret)) {
    deny(res, 401, "missing or invalid Authorization: Bearer secret");
    return;
  }

  const url = (req.url ?? "").split("?")[0];
  if (url !== MCP_PATH) {
    deny(res, 404, `not found (the MCP endpoint is POST ${MCP_PATH})`);
    return;
  }
  if (req.method !== "POST") {
    deny(res, 405, "this MCP server is stateless: POST only");
    return;
  }

  const identity = callerIdentityFromHeaders(req);
  console.info(
    JSON.stringify({ msg: "mcp request", caller: identityLogToken(identity) }),
  );

  // One server + transport per request: the identity parsed from THIS
  // request's headers is the only identity the instance ever sees.
  const server = buildFirmMcpServer(identity, deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
