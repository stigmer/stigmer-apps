/**
 * The DocumentPage resource (FR-DOC-003) — one page of a document's
 * extracted text layer, on the commons pipeline. Wire surface: List
 * ONLY, per document; creation is a system operation reached only by
 * the extraction sweep, and there is no update or delete at all — a
 * page is as immutable as the document it was read from. Idempotency
 * is the composed natural key `{documentId}:{page}` (the CaseMember
 * arrangement): re-extracting a document answers ALREADY_EXISTS row by
 * row, which is what lets the sweep retry safely.
 *
 * ORDERING NOTE: the `page` generated column renders int32 as text, so
 * store-level ordering would put "10" before "2". The list handler
 * therefore fetches the document's page set (bounded by the sweep's
 * MAX_PAGES_PER_DOCUMENT) and orders numerically itself — the proto's
 * "ascending page number" promise is kept here, not in SQL.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  customOperation,
  defineResource,
  invalidArgument,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  type DocumentPage,
  DocumentPageSchema,
  DocumentPageService,
  type ListDocumentPagesRequest,
  type ListDocumentPagesResponse,
  ListDocumentPagesResponseSchema,
  type SearchDocumentPagesRequest,
  type SearchDocumentPagesResponse,
  SearchDocumentPagesResponseSchema,
} from "../../gen/stigmer/law/documentpage/v1/documentpage_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

/**
 * The page-count bound of the DocumentPage contract, owned here beside
 * the resource: the extraction sweep truncates past it (a sanity bound
 * — a 25 MB filing tops out in the low hundreds of pages), and the
 * list handler's bounded-fetch-then-sort relies on it (header note).
 */
export const MAX_PAGES_PER_DOCUMENT = 200;

/**
 * The per-page character cap of the DocumentPage contract (proto
 * max_len on DocumentPageSpec.text), owned here beside the resource
 * like MAX_PAGES_PER_DOCUMENT: both sweeps truncate against it, and
 * exporting the one constant is what keeps their truncation and the
 * proto's promise from drifting apart (review F16 — three copies had
 * accumulated).
 */
export const MAX_PAGE_CHARS = 100_000;

/** The composed natural key — the same string the migration's
 * generated `page_key` column stores. */
export function pageKey(documentId: string, page: number): string {
  return `${documentId}:${page}`;
}

export function documentPageResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "DocumentPage",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "dpg",
      schema: DocumentPageSchema,
      naturalKey: {
        label: "page",
        get: (p) => (p.spec ? pageKey(p.spec.documentId, p.spec.page) : ""),
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: DocumentPageService,
    operations: {
      list: customOperation<DocumentPage, ListDocumentPagesRequest, ListDocumentPagesResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }
          if (!ctx.input.documentId) {
            throw invalidArgument("Document pages are listed per document (document_id)");
          }

          // Membership is the DOCUMENT's rule: pages inherit their
          // document's case, so the guard checks the case the document
          // names — a page can never be more visible than its document.
          const document = (await deps.store.getById("Document", ctx.input.documentId)) as
            | Document
            | undefined;
          if (!document) {
            throw invalidArgument(`Document '${ctx.input.documentId}' not found`);
          }
          await deps.guards.assertCaseContent(ctx.caller, document.spec?.caseId ?? "");

          // Bounded fetch + numeric sort (see the header's ordering
          // note); page_size/page_offset slice the sorted whole.
          const { items, totalCount } = await deps.store.list("DocumentPage", {
            limit: MAX_PAGES_PER_DOCUMENT,
            offset: 0,
            filter: { documentId: ctx.input.documentId },
          });
          const sorted = (items as DocumentPage[]).sort(
            (a, b) => (a.spec?.page ?? 0) - (b.spec?.page ?? 0),
          );
          const size = ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20;
          const offset = ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0;
          return create(ListDocumentPagesResponseSchema, {
            items: sorted.slice(offset, offset + size),
            totalCount: BigInt(totalCount),
          });
        },
      }),
      search: customOperation<
        DocumentPage,
        SearchDocumentPagesRequest,
        SearchDocumentPagesResponse
      >({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          // The visibility scope, resolved BEFORE the query and applied
          // INSIDE it (the searchText filter seam): one matter when
          // named (membership asserted), otherwise the caller's whole
          // visible case set — firm-wide only when the policy says the
          // caller sees everything (partners).
          let scope: Record<string, string | { in: string[] }> = {};
          if (ctx.input.caseId) {
            await deps.guards.assertCaseContent(ctx.caller, ctx.input.caseId);
            scope = { caseId: ctx.input.caseId };
          } else {
            const member = await deps.guards.requireMember(ctx.caller);
            const visible = await deps.guards.visibleCaseIds(member);
            if (visible !== undefined) {
              scope = { caseId: { in: [...visible] } };
            }
          }

          const limit = ctx.input.limit > 0 ? Math.min(ctx.input.limit, 20) : 8;
          const items = await deps.store.searchText(
            "DocumentPage",
            "text",
            ctx.input.query,
            limit,
            scope,
          );
          return create(SearchDocumentPagesResponseSchema, {
            items: items as DocumentPage[],
          });
        },
      }),
    },
    systemOperations: {
      // The extraction sweep's write path. The reference check makes an
      // orphan page impossible; the natural key makes a duplicate page
      // impossible — together they are the sweep's idempotency contract.
      create: {
        beforePersist: [
          referencesExistStep<DocumentPage>(deps.store, [
            { kind: "Document", label: "document", get: (p) => p.spec?.documentId || undefined },
            { kind: "Case", label: "case", get: (p) => p.spec?.caseId || undefined },
          ]),
        ],
      },
    },
  });
}
