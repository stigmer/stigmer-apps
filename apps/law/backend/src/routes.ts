import type { ConnectRouter } from "@connectrpc/connect";
import type { ResourceEventPublisher, ResourceStore } from "@stigmer/resource-api";
import { caseResource } from "./domain/case/case-resource.js";
import { caseNoteResource } from "./domain/casenote/casenote-resource.js";
import { documentResource } from "./domain/document/document-resource.js";
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
 * The full resource set plus THE policy instance, constructed once and
 * shared by every surface: the Connect routes, the in-process invokers
 * the event handlers use, and the plain-HTTP file routes (which consult
 * the same policy — one definition of "what may this person do").
 * Dependencies are explicit arguments (never module state) so tests build
 * against their own store.
 */
export function createApp(deps: AppDeps) {
  const policy = firmPolicy();
  const shared = { store: deps.store, policy, publisher: deps.publisher };
  return {
    policy,
    resources: {
      cases: caseResource(shared),
      users: userResource({ ...shared, credentials: deps.credentials }),
      tasks: taskResource(shared),
      notifications: notificationResource(shared),
      caseNotes: caseNoteResource(shared),
      taskComments: taskCommentResource(shared),
      documents: documentResource(shared),
    },
  };
}

export type App = ReturnType<typeof createApp>;
export type AppResources = App["resources"];

export function buildRoutes(resources: AppResources): (router: ConnectRouter) => void {
  return (router) => {
    for (const resource of Object.values(resources)) {
      resource.routes(router);
    }
  };
}
