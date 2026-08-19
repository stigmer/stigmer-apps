/**
 * The Citation resource (DD-012 D2) — the library shelf entry, on the
 * commons pipeline. The immutable Document holds the paper; this
 * MUTABLE companion holds the identity a lawyer recognizes and IS the
 * shelf: the Library screen lists Citations (one kind, one query —
 * the AND-only filter grammar cannot express a "case-less OR flagged"
 * document shelf). Corrections are updates (the correctable-identity
 * requirement that kept identity OFF the immutable DocumentSpec);
 * there is no delete.
 *
 * document_id is the natural key: one entry per paper, ALREADY_EXISTS
 * from the database itself (the DocumentPage arrangement).
 *
 * Promote (the "add to library" act on a matter's judgment) is the
 * one operation that touches bytes: it reads the source object,
 * re-files it CASE-LESS through the shared storeDocument seam (which
 * creates this resource's companion row with provenance), and answers
 * the new shelf entry. Producing a case-less row is the whole design:
 * it inherits every existing invariant — the policy's library read
 * arm, the search absent-case arm, the extraction sweep — with zero
 * new policy machinery. A shared-blob duplicate was REJECTED because
 * CitationUse keys the reliance trail by document id and a second id
 * would split "has this precedent worked for us?" in half (DD-012).
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  CallerPrincipal,
  PipelineStep,
  ResourceEventPublisher,
  ResourceStore,
  WriteContext,
} from "@stigmer/resource-api";
import {
  alreadyExists,
  createOperation,
  customOperation,
  defineResource,
  failedPrecondition,
  getOperation,
  invalidArgument,
  updateOperation,
} from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  type Citation,
  CitationSchema,
  CitationService,
  CitationStatusSchema,
  type GetCitationRequest,
  type ListCitationsRequest,
  type ListCitationsResponse,
  ListCitationsResponseSchema,
  type PromoteCitationRequest,
  type SearchCitationsRequest,
  type SearchCitationsResponse,
  SearchCitationsResponseSchema,
} from "../../gen/stigmer/law/citation/v1/citation_pb.js";
import {
  type Document,
  DocumentCategory,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import type { StoredObject } from "../../objectstore/object-store.js";
import type { PolicyGuards } from "../authz/policy.js";
import type { StoreDocumentInput } from "../document/store-document.js";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

/** The byte legs the promote operation composes — the object read and
 * the ONE storeDocument seam (composed in routes.ts, where the
 * self-referential createCitation half is closed after construction). */
export interface CitationPromotionDeps {
  readObject(key: string): Promise<StoredObject | undefined>;
  storeLibraryJudgment(
    input: StoreDocumentInput,
    caller: CallerPrincipal,
  ): Promise<Document>;
}

export function citationResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
  promotion: CitationPromotionDeps;
}) {
  // Page-shaped display facts (the CitationUse status precedent): the
  // paper's file name and the promoted-from file number resolve in two
  // bulk lookups, never client-side and never N+1.
  const deriveStatus = async (citations: readonly Citation[]) => {
    const documentIds = [
      ...new Set(
        citations.map((c) => c.spec?.documentId).filter((v): v is string => !!v),
      ),
    ];
    const caseIds = [
      ...new Set(
        citations
          .map((c) => c.spec?.promotedFromCaseId)
          .filter((v): v is string => !!v),
      ),
    ];
    const [documents, cases] = await Promise.all([
      deps.store.getByIds("Document", documentIds),
      deps.store.getByIds("Case", caseIds),
    ]);
    for (const citation of citations) {
      citation.status = create(CitationStatusSchema, {
        documentFileName:
          (documents.get(citation.spec?.documentId ?? "") as Document | undefined)
            ?.spec?.fileName ?? "",
        promotedFromFileNumber:
          (cases.get(citation.spec?.promotedFromCaseId ?? "") as Case | undefined)
            ?.spec?.fileNumber ?? "",
      });
    }
  };

  /** The shelf rule (create): the entry's paper must exist, be
   * CASE-LESS, and carry category JUDGMENT — the shelf lists library
   * papers only. Field validation cannot see across resources. */
  const shelfIntegrity: PipelineStep<WriteContext<Citation>> = {
    name: "verify-shelf-paper",
    async execute(ctx) {
      const spec = (ctx.newState as Citation).spec;
      if (!spec?.documentId) return;
      const document = (await deps.store.getById("Document", spec.documentId)) as
        | Document
        | undefined;
      if (!document) {
        throw failedPrecondition(`Referenced document '${spec.documentId}' not found`);
      }
      if (document.spec?.caseId || document.spec?.category !== DocumentCategory.JUDGMENT) {
        throw failedPrecondition(
          "A shelf entry describes a judgment in the firm library — file " +
            "the judgment to the library (or promote it from its matter) first",
        );
      }
    },
  };

  /** The update rule: identity corrections edit the WORDS. The paper
   * link and the promotion provenance are facts about how the entry
   * came to be — re-pointing either would silently relabel the
   * reliance trail the shelf fronts. */
  const identityImmutables: PipelineStep<WriteContext<Citation>> = {
    name: "verify-immutable-links",
    execute(ctx) {
      const previous = ctx.existing?.spec;
      const next = (ctx.newState as Citation).spec;
      if (!previous || !next) return;
      if (next.documentId !== previous.documentId) {
        throw invalidArgument(
          "A shelf entry stays with its paper — corrections edit the " +
            "identity, never the document link",
        );
      }
      if (
        next.promotedFromCaseId !== previous.promotedFromCaseId ||
        next.promotedFromDocumentId !== previous.promotedFromDocumentId
      ) {
        throw invalidArgument("Promotion provenance is set by the promote operation only");
      }
    },
  };

  return defineResource({
    definition: {
      kind: "Citation",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cit",
      schema: CitationSchema,
      naturalKey: {
        label: "document",
        get: (c) => c.spec?.documentId ?? "",
      },
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: CitationService,
    operations: {
      create: createOperation<Citation>({
        beforePersist: [shelfIntegrity],
      }),
      update: updateOperation<Citation>({
        beforePersist: [identityImmutables],
      }),
      get: getOperation<Citation, GetCitationRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: customOperation<Citation, ListCitationsRequest, ListCitationsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          const { items, totalCount } = await deps.store.list("Citation", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // Newest first — the shelf grows at the front.
            orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
          });
          const citations = items as Citation[];
          await deriveStatus(citations);
          return create(ListCitationsResponseSchema, {
            items: citations,
            totalCount: BigInt(totalCount),
          });
        },
      }),
      search: customOperation<Citation, SearchCitationsRequest, SearchCitationsResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          const limit = Math.min(
            ctx.input.limit > 0 ? ctx.input.limit : DEFAULT_SEARCH_LIMIT,
            MAX_SEARCH_LIMIT,
          );
          // Title and citation-string arms merged under a cap — the
          // sanctioned suggestion-list shape (the DocumentPage search
          // precedent); dedup because one entry can match both.
          const [byTitle, byCitation] = await Promise.all([
            deps.store.searchText("Citation", "title", ctx.input.query, limit),
            deps.store.searchText("Citation", "citation", ctx.input.query, limit),
          ]);
          const seen = new Set<string>();
          const merged = ([...byTitle, ...byCitation] as Citation[])
            .filter((c) => {
              const id = c.metadata?.id ?? "";
              if (seen.has(id)) return false;
              seen.add(id);
              return true;
            })
            .slice(0, limit);
          await deriveStatus(merged);
          return create(SearchCitationsResponseSchema, { items: merged });
        },
      }),
      promote: customOperation<Citation, PromoteCitationRequest, Citation>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          const source = (await deps.store.getById(
            "Document",
            ctx.input.sourceDocumentId,
          )) as Document | undefined;
          if (!source) {
            throw failedPrecondition(
              `Referenced document '${ctx.input.sourceDocumentId}' not found`,
            );
          }
          if (source.spec?.category !== DocumentCategory.JUDGMENT) {
            throw failedPrecondition(
              "Only judgments go on the library shelf — this paper is not " +
                "in the judgment collection",
            );
          }
          if (!source.spec.caseId) {
            throw failedPrecondition(
              "This judgment is already library material — file its shelf " +
                "entry directly instead of promoting",
            );
          }
          // The source is case content: promotion is an act of the
          // matter's team (it deliberately widens the paper's
          // visibility to the whole firm).
          await deps.guards.assertCaseContent(ctx.caller, source.spec.caseId);

          // One promotion per paper — the friendly check; the partial
          // unique index on promoted_from_document_id is the database's
          // own backstop against a race.
          const existing = await deps.store.list("Citation", {
            limit: 1,
            offset: 0,
            filter: { promotedFromDocumentId: ctx.input.sourceDocumentId },
          });
          if (existing.items.length > 0) {
            throw alreadyExists("Citation", "promoted paper", ctx.input.sourceDocumentId);
          }

          const object = await deps.promotion.readObject(source.spec.objectKey);
          if (!object) {
            // A persisted document always has its bytes (the upload
            // choreography's polarity) — a missing object is corruption
            // worth a loud, specific sentence.
            throw failedPrecondition(
              "The judgment's file could not be read from storage — contact support",
            );
          }
          const bytes = await bufferOf(object);

          // Through the ONE storeDocument seam: object PUT, case-less
          // Document via the full pipeline (libraryIntegrity applies),
          // and THIS resource's companion create with provenance — all
          // as the real caller.
          const promoted = await deps.promotion.storeLibraryJudgment(
            {
              fileName: source.spec.fileName,
              mimeType: source.spec.mimeType,
              bytes,
              category: DocumentCategory.JUDGMENT,
              citation: {
                title: ctx.input.title,
                court: ctx.input.court,
                year: ctx.input.year,
                citation: ctx.input.citation,
                promotedFromCaseId: source.spec.caseId,
                promotedFromDocumentId: ctx.input.sourceDocumentId,
              },
            },
            ctx.caller,
          );

          const entry = (await deps.store.getByNaturalKey(
            "Citation",
            promoted.metadata?.id ?? "",
          )) as Citation | undefined;
          if (!entry) {
            // storeLibraryJudgment throws when the companion write
            // fails, so reaching here without a row is a bug, not a
            // user condition.
            throw failedPrecondition("The shelf entry was not written — try again");
          }
          await deriveStatus([entry]);
          return entry;
        },
      }),
    },
  });
}

/** Collects a stored object's stream — bounded by the upload cap by
 * construction (nothing larger ever entered the bucket). */
async function bufferOf(object: StoredObject): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
