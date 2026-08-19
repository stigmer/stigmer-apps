/**
 * The Document resource on the commons pipeline. Wire surface: Get and
 * List ONLY — create runs as a system operation invoked by the plain-HTTP
 * upload route (bytes never ride Connect, T03 D6), and download is the
 * streaming HTTP route. Both routes authenticate through the same caller
 * seam and authorize through the same policy module as every RPC.
 *
 * Rebuild upgrades (DD-001): `category` (with `vakalatnama` and the
 * `judgment` knowledge-base hook) and an optional hearing link. List is
 * now a custom operation: documents are case content, and the one
 * firm-wide view (the judgment collection, FR-DOC-002) stays subject to
 * the caller's case visibility via query scoping.
 */

import { clone, create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  customOperation,
  defineResource,
  getOperation,
  invalidArgument,
  failedPrecondition,
  referencesExistStep,
} from "@stigmer/resource-api";
import {
  type Document,
  DocumentCategory,
  DocumentSchema,
  DocumentService,
  DocumentStatusSchema,
  type GetDocumentRequest,
  type ListDocumentsRequest,
  type ListDocumentsResponse,
  ListDocumentsResponseSchema,
  type RecordDocumentExtractionRequest,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

function categoryText(category: DocumentCategory): string {
  return `DOCUMENT_CATEGORY_${DocumentCategory[category]}`;
}

export function documentResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
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
      // The extraction sweep's status report. NOT the update flavor:
      // the generic update pipeline KEEPS stored status by design
      // (status is system-owned — commons buildUpdateState), so a
      // status write must be a named mutation, the Case.updateStatus
      // arrangement. The policy allows ONLY the system principal in;
      // every wire caller gets the refusal — and the spec is untouched
      // by construction, the record stays immutable (FR-DOC-001).
      recordExtraction: customOperation<Document, RecordDocumentExtractionRequest, Document>({
        async handler(ctx) {
          // load() authorizes "recordExtraction" — system only.
          const document = await ctx.load({ id: ctx.input.id });
          const previous = clone(DocumentSchema, document);
          document.status = create(DocumentStatusSchema, {
            extraction: ctx.input.extraction,
            pageCount: ctx.input.pageCount,
          });
          const saved = await ctx.save(document);
          await ctx.publish("updated", saved, previous);
          return saved;
        },
      }),
      list: customOperation<Document, ListDocumentsRequest, ListDocumentsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          let scope: Record<string, string | { in: string[] } | { absent: true }> = {};
          if (ctx.input.libraryOnly) {
            // The firm library (FR-DOC-005): case-less rows are library
            // material by the create invariant, readable by every case
            // worker — the authorize() above IS the whole gate, no
            // visibility scoping applies.
            scope = { caseId: { absent: true } };
          } else if (ctx.input.caseId) {
            await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
            scope = { caseId: ctx.input.caseId };
          } else if (ctx.input.category === DocumentCategory.JUDGMENT) {
            // The knowledge-base collection (FR-DOC-002): CASE-BOUND
            // judgments — firm-wide for partners, member cases only for
            // everyone else. Library judgments live behind library_only
            // (two honest piles; consumers merge without pagination —
            // FR-DOC-005).
            const member = await deps.guards.requireMember(ctx.caller);
            const visible = await deps.guards.visibleCaseIds(member);
            if (visible !== undefined) {
              scope = { caseId: { in: [...visible] } };
            }
          } else {
            throw invalidArgument(
              "Documents are listed per case (case_id), firm-wide for the " +
                "judgment collection (category JUDGMENT), or from the firm " +
                "library (library_only)",
            );
          }

          const { items, totalCount } = await deps.store.list("Document", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
            filter: {
              ...scope,
              ...(ctx.input.category !== DocumentCategory.UNSPECIFIED
                ? { category: categoryText(ctx.input.category) }
                : {}),
            },
          });
          return create(ListDocumentsResponseSchema, {
            items: items as Document[],
            totalCount: BigInt(totalCount),
          });
        },
      }),
    },
    systemOperations: {
      // Reached only through invoke, from the upload route — which has
      // already put the bytes in the bucket, so a persisted row always
      // has its object (T03 D6 failure polarity). The route passes the
      // REAL caller, so the policy's create rule AND the membership
      // guard below apply to the person, never to "system".
      create: {
        beforePersist: [
          libraryIntegrity,
          membershipOnWrite(deps),
          referencesExistStep<Document>(deps.store, [
            { kind: "Case", label: "case", get: (d) => d.spec?.caseId || undefined },
            { kind: "Hearing", label: "hearing", get: (d) => d.spec?.hearingId || undefined },
          ]),
        ],
      },
    },
  });
}

/**
 * The library invariants (FR-DOC-005) — what makes "case-less ⇒
 * library material" TRUE, which the policy's read arm then relies on:
 * a case-less document must be a JUDGMENT (the one library category
 * since the acts feature was removed — owner decision, 2026-08-19)
 * and carry no hearing link (a hearing without a case is
 * meaningless).
 */
const libraryIntegrity: PipelineStep<WriteContext<Document>> = {
  name: "verify-library-shape",
  execute(ctx) {
    const spec = (ctx.newState as Document).spec;
    if (!spec) return;
    if (!spec.caseId) {
      if (spec.category !== DocumentCategory.JUDGMENT) {
        throw failedPrecondition(
          "Only judgments can be filed to the firm library — every other " +
            "paper belongs to a matter (give its case)",
        );
      }
      if (spec.hearingId) {
        throw invalidArgument(
          "A library document cannot reference a hearing — hearings belong to matters",
        );
      }
    }
  },
};

/** Documents are case content: the uploader must be a member of the
 * case (or a partner) — the create-input check the authorize slot
 * cannot make (policy.ts, rule shapes). Library documents skip it by
 * shape: no case, no membership to assert (the role gate in the
 * policy's create rule still applies). */
function membershipOnWrite(deps: {
  guards: PolicyGuards;
}): PipelineStep<WriteContext<Document>> {
  return {
    name: "assert-case-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as Document).spec?.caseId;
      if (ctx.caller && ctx.caller.kind === "user" && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId);
      }
    },
  };
}
