import type { ConnectRouter } from "@connectrpc/connect";
import type {
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import type { CredentialStore, RefreshTokenStore } from "@stigmer/identity";
import { userResource } from "@stigmer/identity";
import { caseResource } from "./domain/case/case-resource.js";
import { caseNoteResource } from "./domain/casenote/casenote-resource.js";
import { documentResource } from "./domain/document/document-resource.js";
import { notificationResource } from "./domain/notification/notification-resource.js";
import { taskResource } from "./domain/task/task-resource.js";
import { taskCommentResource } from "./domain/taskcomment/taskcomment-resource.js";
import { firmPolicy } from "./domain/authz/policy.js";

export interface AppDeps {
  readonly store: ResourceStore;
  /** The one caller seam (T04a): the identity chain's Connect binding. */
  readonly caller: CallerExtractor;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  readonly publisher?: ResourceEventPublisher;
}

/**
 * The full resource set plus THE policy instance, constructed once and
 * shared by every surface: the Connect routes, the in-process invokers
 * the event handlers use, and the plain-HTTP file routes (which consult
 * the same policy — one definition of "what may this person do").
 * Dependencies are explicit arguments (never module state) so tests build
 * against their own store.
 *
 * User is the identity commons' resource (DD-005 D2) composed here with
 * THIS app's policy — the operator-only branches in firmPolicy govern it
 * exactly as they governed the app-owned original.
 */
export function createApp(deps: AppDeps) {
  const policy = firmPolicy();
  const shared = {
    store: deps.store,
    policy,
    publisher: deps.publisher,
    caller: deps.caller,
  };
  return {
    policy,
    resources: {
      cases: caseResource(shared),
      users: userResource({
        ...shared,
        credentials: deps.credentials,
        refreshTokens: deps.refreshTokens,
      }),
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
