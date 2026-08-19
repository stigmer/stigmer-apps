/**
 * The DocumentAnnotation resource (DD-010) — an append-only mark with
 * a comment on a filed document, on the commons pipeline. Wire
 * surface: Create + List ONLY — the proto declares no other method, so
 * the absence is the contract (the TaskComment rule). Author and
 * timestamp are the envelope's created_by/created_at.
 *
 * Marks are case content reached THROUGH the document: create verifies
 * membership against the case the referenced document names, and list
 * does the same before reading — a mark can never be more visible than
 * its document (the DocumentPage rule).
 *
 * Two invariants field validation cannot express live here as steps:
 * the client-submitted denormalized case_id must MATCH the referenced
 * document's (denormalized, never trusted), and a REGION mark carries
 * exactly one rect (per-line rects are a HIGHLIGHT's shape — the
 * DD-010 amendment).
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  createOperation,
  customOperation,
  defineResource,
  failedPrecondition,
  invalidArgument,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  AnnotationKind,
  type DocumentAnnotation,
  DocumentAnnotationSchema,
  DocumentAnnotationService,
  type ListDocumentAnnotationsRequest,
  type ListDocumentAnnotationsResponse,
  ListDocumentAnnotationsResponseSchema,
} from "../../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

export function documentAnnotationResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  async function documentOrRefuse(documentId: string): Promise<Document> {
    const document = (await deps.store.getById("Document", documentId)) as
      | Document
      | undefined;
    if (!document) {
      throw failedPrecondition(`Referenced document '${documentId}' not found`);
    }
    return document;
  }

  const membershipOnWrite: PipelineStep<WriteContext<DocumentAnnotation>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const spec = (ctx.newState as DocumentAnnotation).spec;
      if (ctx.caller && spec?.documentId) {
        const document = await documentOrRefuse(spec.documentId);
        if (!document.spec?.caseId) {
          // Library documents (FR-DOC-005) — a NAMED deferral, refused
          // in the user's words: marks are case-team records, and a
          // firm-wide mark visibility model has not been designed yet.
          throw failedPrecondition(
            "Marks on library documents aren't supported yet — marks live on a matter's own papers",
          );
        }
        await deps.guards.assertCaseContent(ctx.caller, document.spec.caseId);
      }
    },
  };

  /** The two cross-field invariants (see the module header). */
  const anchorIntegrity: PipelineStep<WriteContext<DocumentAnnotation>> = {
    name: "verify-annotation-anchor",
    async execute(ctx) {
      const spec = (ctx.newState as DocumentAnnotation).spec;
      if (!spec) return;
      if (spec.annotationKind === AnnotationKind.REGION && spec.rects.length !== 1) {
        throw invalidArgument("A region mark carries exactly one rectangle");
      }
      const document = await documentOrRefuse(spec.documentId);
      if (spec.caseId !== (document.spec?.caseId ?? "")) {
        // The denormalized field is client-supplied and load-bearing
        // for policy — a lie here would misfile the mark's visibility.
        throw invalidArgument(
          "case_id must match the case of the referenced document",
        );
      }
    },
  };

  return defineResource({
    definition: {
      kind: "DocumentAnnotation",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "ann",
      schema: DocumentAnnotationSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: DocumentAnnotationService,
    operations: {
      create: createOperation<DocumentAnnotation>({
        beforePersist: [
          membershipOnWrite,
          referencesExistStep<DocumentAnnotation>(deps.store, [
            {
              kind: "Document",
              label: "document",
              get: (a) => a.spec?.documentId || undefined,
            },
          ]),
          anchorIntegrity,
        ],
      }),
      list: customOperation<
        DocumentAnnotation,
        ListDocumentAnnotationsRequest,
        ListDocumentAnnotationsResponse
      >({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          // Membership is the DOCUMENT's rule (the DocumentPage list
          // precedent): marks inherit their document's case.
          const document = (await deps.store.getById(
            "Document",
            ctx.input.documentId,
          )) as Document | undefined;
          if (!document) {
            throw invalidArgument(`Document '${ctx.input.documentId}' not found`);
          }
          if (!document.spec?.caseId) {
            // Library documents carry no marks by contract (create
            // refuses, FR-DOC-005 deferral) — the honest empty page,
            // so the shared viewer renders cleanly on /library.
            return create(ListDocumentAnnotationsResponseSchema, {
              items: [],
              totalCount: 0n,
            });
          }
          await deps.guards.assertCaseContent(ctx.caller, document.spec.caseId);

          const { items, totalCount } = await deps.store.list("DocumentAnnotation", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // Oldest first — the learning trail reads chronologically
            // (the TaskComment list contract).
            orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
            filter: { documentId: ctx.input.documentId },
          });
          return create(ListDocumentAnnotationsResponseSchema, {
            items: items as DocumentAnnotation[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No update, no delete: append-only by contract (DD-010).
    },
  });
}
