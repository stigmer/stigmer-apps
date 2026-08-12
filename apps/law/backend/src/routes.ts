import type { ConnectRouter } from "@connectrpc/connect";
import type {
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import type { AuthorizationEngine } from "@stigmer/authorization";
import type {
  ActivationCodeStore,
  CredentialStore,
  RefreshTokenStore,
} from "@stigmer/identity";
import { userResource } from "@stigmer/identity";
import { auditEntryResource } from "./domain/audit/auditentry-resource.js";
import { caseResource } from "./domain/case/case-resource.js";
import { caseMemberResource } from "./domain/casemember/casemember-resource.js";
import { caseNoteResource } from "./domain/casenote/casenote-resource.js";
import { clientResource } from "./domain/client/client-resource.js";
import { deadlineResource } from "./domain/deadline/deadline-resource.js";
import { documentPageResource } from "./domain/document/document-page-resource.js";
import { documentResource } from "./domain/document/document-resource.js";
import { firmMemberResource } from "./domain/firmmember/firmmember-resource.js";
import { hearingResource } from "./domain/hearing/hearing-resource.js";
import { feeArrangementResource } from "./domain/money/feearrangement-resource.js";
import { ledgerEntryResource } from "./domain/money/ledgerentry-resource.js";
import { notificationResource } from "./domain/notification/notification-resource.js";
import { taskResource } from "./domain/task/task-resource.js";
import { taskCommentResource } from "./domain/taskcomment/taskcomment-resource.js";
import { createFirmPolicy } from "./domain/authz/policy.js";

export interface AppDeps {
  readonly store: ResourceStore;
  /** The one caller seam (T04a): the identity chain's Connect binding. */
  readonly caller: CallerExtractor;
  /** The FGA engine the policy consults and the tuple-sync steps write
   * (DD-003): bootstrapped + reconciled BEFORE assembly (main.ts). */
  readonly authz: AuthorizationEngine;
  readonly credentials: CredentialStore;
  readonly refreshTokens: RefreshTokenStore;
  readonly activationCodes: ActivationCodeStore;
  readonly publisher?: ResourceEventPublisher;
}

/**
 * The full resource set plus THE policy instance, constructed once and
 * shared by every surface: the Connect routes, the in-process invokers
 * the event handlers and the reminder sweep use, and the plain-HTTP
 * file routes — one definition of "what may this person do" (DD-A5).
 * The policy answers relationship questions through the FGA engine
 * (whose tuples project from this same store — DD-003) and keeps the
 * liveness gate and attribute rules on the store; the guards carry the
 * rules the authorize slot cannot see (create input, list scoping).
 *
 * User is the identity commons' resource (DD-005 D2) composed here with
 * THIS app's policy — operator-only writes, self-only reads.
 */
export function createApp(deps: AppDeps) {
  const firm = createFirmPolicy(deps.store, deps.authz);
  const shared = {
    store: deps.store,
    policy: firm.policy,
    publisher: deps.publisher,
    caller: deps.caller,
  };
  const guarded = { ...shared, guards: firm.guards };
  // The three kinds whose rows project into tuples carry the engine for
  // their same-request sync steps (DD-003 D1a).
  const projected = { authz: deps.authz };
  return {
    policy: firm.policy,
    guards: firm.guards,
    resources: {
      users: userResource({
        ...shared,
        credentials: deps.credentials,
        refreshTokens: deps.refreshTokens,
        activationCodes: deps.activationCodes,
      }),
      firmMembers: firmMemberResource({ ...shared, ...projected }),
      clients: clientResource(shared),
      cases: caseResource({ ...guarded, ...projected }),
      caseMembers: caseMemberResource({ ...guarded, ...projected }),
      hearings: hearingResource(guarded),
      deadlines: deadlineResource(guarded),
      feeArrangements: feeArrangementResource(shared),
      ledgerEntries: ledgerEntryResource(guarded),
      tasks: taskResource(guarded),
      notifications: notificationResource(shared),
      caseNotes: caseNoteResource(guarded),
      taskComments: taskCommentResource(guarded),
      documents: documentResource(guarded),
      documentPages: documentPageResource(guarded),
      auditEntries: auditEntryResource(shared),
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
