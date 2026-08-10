/**
 * The AuditEntry resource — the append-only change history
 * (FR-AUDIT-001). System-written only: no wire Create exists; the
 * audit subscriber writes through the in-process invoker (the
 * Notification arrangement). The wire surface is exactly one partner-
 * only, case-scoped list.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import { defineResource, listOperation } from "@stigmer/resource-api";
import {
  AuditEntrySchema,
  AuditEntryService,
  type AuditEntry,
  type ListAuditEntriesRequest,
  type ListAuditEntriesResponse,
  ListAuditEntriesResponseSchema,
} from "../../gen/stigmer/law/auditentry/v1/auditentry_pb.js";

export function auditEntryResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "AuditEntry",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "audit",
      schema: AuditEntrySchema,
      naturalKey: {
        label: "audit key",
        get: (e) => e.spec?.dedupKey ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: AuditEntryService,
    operations: {
      list: listOperation<AuditEntry, ListAuditEntriesRequest, ListAuditEntriesResponse>({
        // "What happened on this matter lately" — newest first.
        orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: { caseId: req.caseId },
        }),
        respond: (items, totalCount) =>
          create(ListAuditEntriesResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
    },
    systemOperations: {
      // The subscriber's write path — the full pipeline as the system
      // principal; the dedup natural key absorbs duplicate delivery.
      create: {},
    },
  });
}
