/**
 * The CaseNote resource on the commons pipeline. Append-only (DD-001
 * operation matrix): create and list, nothing else — the proto declares
 * no other method, so the absence is the contract. Author and timestamp
 * are the envelope's created_by/created_at; the spec carries only the
 * reference and the content.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  createOperation,
  defineResource,
  listOperation,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { CallerExtractor } from "@stigmer/resource-api";
import {
  type CaseNote,
  CaseNoteSchema,
  CaseNoteService,
  type ListCaseNotesRequest,
  ListCaseNotesResponseSchema,
} from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";

export function caseNoteResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "CaseNote",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "note",
      schema: CaseNoteSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: CaseNoteService,
    operations: {
      create: createOperation<CaseNote>({
        beforePersist: [
          referencesExistStep<CaseNote>(deps.store, [
            { kind: "Case", label: "case", get: (n) => n.spec?.caseId || undefined },
          ]),
        ],
      }),
      list: listOperation<CaseNote, ListCaseNotesRequest, unknown>({
        // Newest first (record model) — the metadata-backed column (D5).
        orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: { caseId: req.caseId },
        }),
        respond: (items, totalCount) =>
          create(ListCaseNotesResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // No update, no delete: append-only by contract.
    },
  });
}
