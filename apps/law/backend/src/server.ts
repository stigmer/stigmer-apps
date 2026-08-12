import http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter } from "@connectrpc/connect";
import type { InProcessEventDispatcher, ResourceStore } from "@stigmer/resource-api";
import type { AuthorizationEngine } from "@stigmer/authorization";
import {
  authService,
  createCallerIdentityResolver,
  type ActivationCodeStore,
  type CredentialStore,
  type RefreshTokenStore,
} from "@stigmer/identity";
import { assistantService, type AssistantRuntime } from "./assistant/assistant-service.js";
import type { AuthKit } from "./auth/auth.js";
import { registerAuditSubscriber } from "./domain/audit/audit-subscriber.js";
import { registerLeadMembershipHandler } from "./domain/case/lead-membership-handler.js";
import { registerNextHearingRefreshHandler } from "./domain/case/next-hearing-refresh-handler.js";
import { startExtractionSweep } from "./domain/document/extraction-sweep.js";
import { registerDeactivationHandler } from "./domain/firmmember/deactivation-handler.js";
import { registerTaskAssignmentHandler } from "./domain/notification/task-assignment-handler.js";
import { startReminderSweep } from "./domain/reminders/sweep.js";
import { createFileRoutes } from "./files/file-routes.js";
import { createMcpHttpServer } from "./mcp/transport.js";
import type { ObjectStore } from "./objectstore/object-store.js";
import { type App, buildRoutes, createApp } from "./routes.js";
import { createStaticRoutes } from "./web/static-routes.js";

export interface BackendDeps {
  readonly store: ResourceStore;
  /** The composed authentication (auth/auth.ts): issuer + caller resolver. */
  readonly auth: AuthKit;
  /**
   * The FGA engine (DD-003), already bootstrapped and reconciled by the
   * caller (main.ts in production; each suite's harness in tests) —
   * server assembly stays synchronous and engine-shape-agnostic.
   */
  readonly authz: AuthorizationEngine;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  readonly activationCodes: ActivationCodeStore;
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
  /**
   * Reminder sweep tick (Gate-1 Q4); 0/absent disables the loop (tests
   * drive runSweepOnce directly). Multi-replica safe: the Notification
   * dedup key absorbs concurrent sweeps.
   */
  readonly reminderIntervalMs?: number;
  /**
   * Extraction sweep tick (FR-DOC-003); 0/absent disables the loop
   * (tests drive runExtractionSweepOnce directly). Multi-replica safe:
   * DocumentPage's composed natural key absorbs concurrent sweeps.
   */
  readonly extractionIntervalMs?: number;
  /**
   * The assistant integration (T05 web leg): config + platform token
   * minter, present together. Absent means the deployment has no
   * assistant — the service still mounts and says so, which is what
   * lets the web decide whether an "Ask AI" affordance exists.
   */
  readonly assistant?: AssistantRuntime;
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
        // The caller resolver reads the SAME store the pipelines use;
        // deliberately not in the authenticator chain (identity README).
        resolveCallerIdentity: createCallerIdentityResolver(deps.store),
        store: deps.store,
      },
    ),
  };
}

function assembleApp(deps: BackendDeps): App {
  const app = createApp({
    store: deps.store,
    caller: deps.auth.resolver.fromConnect,
    authz: deps.authz,
    credentials: deps.credentials,
    refreshTokens: deps.refreshTokens,
    activationCodes: deps.activationCodes,
    publisher: deps.dispatcher,
  });

  if (deps.dispatcher) {
    // Every subscriber writes through the in-process invoker — the full
    // pipeline as the system principal (DD-A4); each is idempotent by a
    // dedup natural key or by construction.
    registerTaskAssignmentHandler(
      deps.dispatcher,
      deps.store,
      app.resources.notifications.invoke.create as NonNullable<
        typeof app.resources.notifications.invoke.create
      >,
    );
    // The lead lawyer is materialized as an active case member — the
    // single membership fact "mine" and the policy both read (Gate-1).
    registerLeadMembershipHandler(
      deps.dispatcher,
      deps.store,
      app.resources.caseMembers.invoke.create as NonNullable<
        typeof app.resources.caseMembers.invoke.create
      >,
    );
    // Hearing writes refresh the case's stored-derived next-hearing
    // fact (Gate-1 Q6): the update pipeline's recompute step does the
    // math; the handler only triggers the write.
    registerNextHearingRefreshHandler(
      deps.dispatcher,
      deps.store,
      app.resources.cases.invoke.update as NonNullable<
        typeof app.resources.cases.invoke.update
      >,
    );
    // The append-only change history (FR-AUDIT-001, Gate-1 Q8).
    registerAuditSubscriber(
      deps.dispatcher,
      app.resources.auditEntries.invoke.create as NonNullable<
        typeof app.resources.auditEntries.invoke.create
      >,
    );
    // Deactivation kills refresh sessions (FR-MEMBER-002).
    registerDeactivationHandler(deps.dispatcher, deps.refreshTokens);
  }

  if (deps.reminderIntervalMs && deps.reminderIntervalMs > 0) {
    // The clock-driven notifications (Gate-1 Q4). The interval timer is
    // unref'd inside, so it never holds a closing process open.
    startReminderSweep(
      {
        store: deps.store,
        createNotification: app.resources.notifications.invoke.create as NonNullable<
          typeof app.resources.notifications.invoke.create
        >,
      },
      deps.reminderIntervalMs,
    );
  }

  if (deps.extractionIntervalMs && deps.extractionIntervalMs > 0) {
    // The document text-layer writer (FR-DOC-003) — covers fresh
    // uploads, the backfill, and retry through one idempotent loop.
    startExtractionSweep(
      {
        store: deps.store,
        objectStore: deps.objectStore,
        createDocumentPage: app.resources.documentPages.invoke.create as NonNullable<
          typeof app.resources.documentPages.invoke.create
        >,
        recordExtraction: app.resources.documents.invoke.recordExtraction,
      },
      deps.extractionIntervalMs,
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
    activationCodes: deps.activationCodes,
    issuer: deps.auth.issuer,
    caller: deps.auth.resolver.fromConnect,
  });

  // GetConfig/MintToken — identity-level like the auth surface, but its
  // mint runs through the policy's liveness gate: deactivation closes
  // the assistant with everything else (assistant-service.ts).
  const assistant = assistantService({
    assistant: deps.assistant,
    store: deps.store,
    caller: deps.auth.resolver.fromConnect,
    requireMember: app.guards.requireMember,
  });

  const connectHandler = connectNodeAdapter({
    routes: (router: ConnectRouter) => {
      buildRoutes(app.resources)(router);
      auth.routes(router);
      assistant.routes(router);
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
