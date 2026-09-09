/**
 * The CaseNote resource on the commons pipeline. Append-only (DD-001
 * operation matrix): create and list, nothing else — the proto declares
 * no other method, so the absence is the contract. Author and timestamp
 * are the envelope's created_by/created_at; the spec carries only the
 * reference and the content.
 *
 * Notes are case content (FR-AUTHZ-002): the policy's create cell checks
 * membership of the case the input names, and the list is a custom
 * operation because its case gate scopes a query the authorize slot
 * cannot see.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  createOperation,
  customOperation,
  defineResource,
  invalidArgument,
  referencesExistStep,
} from "@stigmer/resource-api";
import {
  type CaseNote,
  CaseNoteSchema,
  CaseNoteService,
  type ListCaseNotesRequest,
  type ListCaseNotesResponse,
  ListCaseNotesResponseSchema,
} from "../../gen/stigmer/law/casenote/v1/casenote_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

export function caseNoteResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
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
      // Case membership on create is the policy's (the authorize slot
      // sees the input since resource-api 0.6).
      create: createOperation<CaseNote>({
        beforePersist: [
          referencesExistStep<CaseNote>(deps.store, [
            { kind: "Case", label: "case", get: (n) => n.spec?.caseId || undefined },
          ]),
        ],
      }),
      list: customOperation<CaseNote, ListCaseNotesRequest, ListCaseNotesResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
          const { items, totalCount } = await deps.store.list("CaseNote", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // Newest first (record model) — the metadata-backed column.
            orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
            filter: { caseId: ctx.input.caseId },
          });
          return create(ListCaseNotesResponseSchema, {
            items: items as CaseNote[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No update, no delete: append-only by contract.
    },
  });
}
