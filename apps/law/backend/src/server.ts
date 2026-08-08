import http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { buildRoutes, type RouteDeps } from "./routes.js";

/**
 * Builds the HTTP server: health endpoint plus every Connect route.
 * Construction is separated from listening so integration tests can boot
 * the exact production server on an ephemeral port.
 */
export function createBackendServer(deps: RouteDeps): http.Server {
  const connectHandler = connectNodeAdapter({ routes: buildRoutes(deps) });

  return http.createServer((req, res) => {
    // Health answers before anything else and deliberately does NOT check
    // the database: a store outage must degrade requests, not crash-loop
    // the pod (isc-assistant precedent).
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    connectHandler(req, res);
  });
}
