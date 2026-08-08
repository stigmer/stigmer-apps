import type { ConnectRouter } from "@connectrpc/connect";
import type { ResourceEventPublisher, ResourceStore } from "@stigmer/resource-api";
import { caseResource } from "./domain/case/case-resource.js";
import { caseNoteResource } from "./domain/casenote/casenote-resource.js";
import { notificationResource } from "./domain/notification/notification-resource.js";
import { taskResource } from "./domain/task/task-resource.js";
import { taskCommentResource } from "./domain/taskcomment/taskcomment-resource.js";
import type { CredentialStore } from "./domain/user/credentials.js";
import { userResource } from "./domain/user/user-resource.js";
import { firmPolicy } from "./domain/authz/policy.js";

export interface AppDeps {
  readonly store: ResourceStore;
  readonly credentials: CredentialStore;
  readonly publisher?: ResourceEventPublisher;
}

/**
 * The full resource set, constructed once and shared by BOTH surfaces:
 * the Connect routes and the in-process invokers the event handlers use
 * (server.ts wires those). One policy module for all of them;
 * dependencies are explicit arguments (never module state) so tests build
 * against their own store.
 */
export function createResources(deps: AppDeps) {
  const policy = firmPolicy();
  const shared = { store: deps.store, policy, publisher: deps.publisher };
  return {
    cases: caseResource(shared),
    users: userResource({ ...shared, credentials: deps.credentials }),
    tasks: taskResource(shared),
    notifications: notificationResource(shared),
    caseNotes: caseNoteResource(shared),
    taskComments: taskCommentResource(shared),
    // T03.4: documents.
  };
}

export type AppResources = ReturnType<typeof createResources>;

export function buildRoutes(resources: AppResources): (router: ConnectRouter) => void {
  return (router) => {
    for (const resource of Object.values(resources)) {
      resource.routes(router);
    }
  };
}
