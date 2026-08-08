/**
 * The Document resource on the commons pipeline. Wire surface: Get and
 * List ONLY — create runs as a system operation invoked by the plain-HTTP
 * upload route (bytes never ride Connect, T03 D6), and download is the
 * streaming HTTP route. Both routes authenticate through the same caller
 * seam and authorize through the same policy module as every RPC.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  defineResource,
  getOperation,
  listOperation,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { CallerExtractor } from "@stigmer/resource-api";
import {
  type Document,
  DocumentSchema,
  DocumentService,
  type GetDocumentRequest,
  type ListDocumentsRequest,
  ListDocumentsResponseSchema,
} from "../../gen/stigmer/law/document/v1/document_pb.js";

export function documentResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "Document",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "doc",
      schema: DocumentSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: DocumentService,
    operations: {
      get: getOperation<Document, GetDocumentRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: listOperation<Document, ListDocumentsRequest, unknown>({
        orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: { caseId: req.caseId },
        }),
        respond: (items, totalCount) =>
          create(ListDocumentsResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
    },
    systemOperations: {
      // Reached only through invoke, from the upload route — which has
      // already put the bytes in the bucket, so a persisted row always
      // has its object (T03 D6 failure polarity).
      create: {
        beforePersist: [
          referencesExistStep<Document>(deps.store, [
            { kind: "Case", label: "case", get: (d) => d.spec?.caseId || undefined },
          ]),
        ],
      },
    },
  });
}
