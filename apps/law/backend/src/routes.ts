import type { ConnectRouter } from "@connectrpc/connect";
import type { ResourceEventPublisher, ResourceStore } from "@stigmer/resource-api";
import { caseResource } from "./domain/case/case-resource.js";
import { userResource } from "./domain/user/user-resource.js";
import type { CredentialStore } from "./domain/user/credentials.js";
import { firmPolicy } from "./domain/authz/policy.js";

export interface RouteDeps {
  readonly store: ResourceStore;
  readonly credentials: CredentialStore;
  readonly publisher?: ResourceEventPublisher;
}

/**
 * Registers every resource this backend serves. One policy module for all
 * of them; dependencies are explicit arguments (never module state) so
 * tests build routes against their own store.
 */
export function buildRoutes(deps: RouteDeps): (router: ConnectRouter) => void {
  const policy = firmPolicy();
  const resources = [
    caseResource({ store: deps.store, policy, publisher: deps.publisher }),
    userResource({
      store: deps.store,
      policy,
      publisher: deps.publisher,
      credentials: deps.credentials,
    }),
    // T03: tasks, case notes, task comments, documents, notifications.
  ];
  return (router) => {
    for (const resource of resources) {
      resource.routes(router);
    }
  };
}
