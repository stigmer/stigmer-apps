import http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { InProcessEventDispatcher, ResourceStore } from "@stigmer/resource-api";
import type { CredentialStore } from "./domain/user/credentials.js";
import { registerTaskAssignmentHandler } from "./domain/notification/task-assignment-handler.js";
import { createFileRoutes } from "./files/file-routes.js";
import type { ObjectStore } from "./objectstore/object-store.js";
import { buildRoutes, createApp } from "./routes.js";

export interface BackendDeps {
  readonly store: ResourceStore;
  readonly credentials: CredentialStore;
  readonly objectStore: ObjectStore;
  /**
   * The resource event dispatcher. Optional so narrow tests can boot
   * without eventing; when present it is both the pipelines' publisher
   * and the bus the notification handlers subscribe on.
   */
  readonly dispatcher?: InProcessEventDispatcher;
}

/**
 * Builds the HTTP server: health endpoint, the document byte routes
 * (upload/download — T03 D6), and every Connect route, with the event
 * subscribers wired to the SAME resource instances the routes serve —
 * one pipeline per resource, shared by every surface. Construction is
 * separated from listening so integration tests can boot the exact
 * production server on an ephemeral port.
 */
export function createBackendServer(deps: BackendDeps): http.Server {
  const app = createApp({
    store: deps.store,
    credentials: deps.credentials,
    publisher: deps.dispatcher,
  });

  if (deps.dispatcher) {
    // Notification.create is a system operation: no RPC exists, so the
    // handler reaches the full pipeline through the invoker (T03 D1).
    registerTaskAssignmentHandler(
      deps.dispatcher,
      app.resources.notifications.invoke.create as NonNullable<
        typeof app.resources.notifications.invoke.create
      >,
    );
  }

  const fileRoutes = createFileRoutes({
    policy: app.policy,
    store: deps.store,
    objectStore: deps.objectStore,
    createDocument: app.resources.documents.invoke.create as NonNullable<
      typeof app.resources.documents.invoke.create
    >,
  });

  const connectHandler = connectNodeAdapter({ routes: buildRoutes(app.resources) });

  return http.createServer((req, res) => {
    // Health answers before anything else and deliberately does NOT check
    // the database: a store outage must degrade requests, not crash-loop
    // the pod (isc-assistant precedent).
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (fileRoutes(req, res)) {
      return;
    }
    connectHandler(req, res);
  });
}
