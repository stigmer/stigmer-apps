import http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter } from "@connectrpc/connect";
import type { InProcessEventDispatcher, ResourceStore } from "@stigmer/resource-api";
import {
  authService,
  createChannelIdentityResolver,
  type CredentialStore,
  type RefreshTokenStore,
} from "@stigmer/identity";
import type { AuthKit } from "./auth/auth.js";
import { registerTaskAssignmentHandler } from "./domain/notification/task-assignment-handler.js";
import { createFileRoutes } from "./files/file-routes.js";
import { createMcpHttpServer } from "./mcp/transport.js";
import type { ObjectStore } from "./objectstore/object-store.js";
import { type App, buildRoutes, createApp } from "./routes.js";
import { createStaticRoutes } from "./web/static-routes.js";

export interface BackendDeps {
  readonly store: ResourceStore;
  /** The composed authentication (auth/auth.ts): issuer + caller resolver. */
  readonly auth: AuthKit;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  readonly objectStore: ObjectStore;
  /**
   * The resource event dispatcher. Optional so narrow tests can boot
   * without eventing; when present it is both the pipelines' publisher
   * and the bus the notification handlers subscribe on.
   */
  readonly dispatcher?: InProcessEventDispatcher;
  /**
   * Directory of the web app's built SPA (T04b D1). Optional: absent in
   * dev (the Vite dev server proxies to this process) and in API tests;
   * present in the built image, detected by main.ts (detectWebRoot).
   */
  readonly webRoot?: string;
}

/**
 * Builds the HTTP server: health endpoint, the document byte routes
 * (upload/download — T03 D6), and every Connect route, with the event
 * subscribers wired to the SAME resource instances the routes serve —
 * one pipeline per resource, shared by every surface. Both transports
 * resolve callers through the SAME auth kit (one chain, N entrances).
 * Construction is separated from listening so integration tests can boot
 * the exact production server on an ephemeral port.
 */
export function createBackendServer(deps: BackendDeps): http.Server {
  return buildWebServer(assembleApp(deps), deps);
}

/**
 * The firm's whole process (T05, DD-008): the app server AND the MCP
 * listener, assembled from ONE createApp — the MCP tools run the exact
 * pipeline instances the Connect routes serve, so the policy module and
 * the event subscribers govern every surface identically. The MCP
 * server listens on its own cluster-internal port; it is never mounted
 * on the ingress port.
 */
export function createFirmServers(
  deps: BackendDeps,
  mcp: { readonly sharedSecret: string },
): { readonly web: http.Server; readonly mcp: http.Server } {
  const app = assembleApp(deps);
  return {
    web: buildWebServer(app, deps),
    mcp: createMcpHttpServer(
      { sharedSecret: mcp.sharedSecret },
      {
        resources: app.resources,
        // The channel resolver reads the SAME store the pipelines use;
        // deliberately not in the authenticator chain (identity README).
        resolveChannelIdentity: createChannelIdentityResolver(deps.store),
      },
    ),
  };
}

function assembleApp(deps: BackendDeps): App {
  const app = createApp({
    store: deps.store,
    caller: deps.auth.resolver.fromConnect,
    credentials: deps.credentials,
    refreshTokens: deps.refreshTokens,
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
  return app;
}

function buildWebServer(app: App, deps: BackendDeps): http.Server {
  const fileRoutes = createFileRoutes({
    policy: app.policy,
    caller: deps.auth.resolver.fromHttp,
    store: deps.store,
    objectStore: deps.objectStore,
    createDocument: app.resources.documents.invoke.create as NonNullable<
      typeof app.resources.documents.invoke.create
    >,
  });

  // Login/Refresh/Logout/WhoAmI — identity-level, mounted beside the
  // resources; the resource pipelines and the policy module are untouched
  // by it (the auth surface proves identity, the policy governs actions).
  const auth = authService({
    store: deps.store,
    credentials: deps.credentials,
    refreshTokens: deps.refreshTokens,
    issuer: deps.auth.issuer,
    caller: deps.auth.resolver.fromConnect,
  });

  const connectHandler = connectNodeAdapter({
    routes: (router: ConnectRouter) => {
      buildRoutes(app.resources)(router);
      auth.routes(router);
    },
  });

  // The web app's built SPA, same origin as the API (T04b D1) — the
  // handler owns non-API GET/HEAD paths and declines `/stigmer.*`, so it
  // can never shadow an RPC.
  const staticRoutes = deps.webRoot ? createStaticRoutes(deps.webRoot) : undefined;

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
    if (staticRoutes?.(req, res)) {
      return;
    }
    connectHandler(req, res);
  });
}
