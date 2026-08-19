/**
 * The CitationUse resource (FR-CIT-001) — the firm's reliance trail on
 * its judgment library, on the commons pipeline. Wire surface: Create +
 * List ONLY — the proto declares no other method, so the absence is the
 * contract (the DocumentAnnotation rule). Who recorded a use and when
 * come from the envelope metadata.
 *
 * Three invariants field validation cannot express live here as steps:
 * the referenced document must carry category JUDGMENT (the library is
 * ONE pile — owner decision session 27), the caller must be able to
 * READ that judgment (a use is recorded by someone who read both
 * sides), and the caller must be able to WORK the using case.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  FilterValue,
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
  permissionDenied,
  referencesExistStep,
} from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  DocumentCategory,
  type Document,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import {
  type CitationUse,
  CitationUseSchema,
  CitationUseService,
  CitationUseStatusSchema,
  type ListCitationUsesRequest,
  type ListCitationUsesResponse,
  ListCitationUsesResponseSchema,
} from "../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import type { PolicyGuards } from "../authz/policy.js";

export function citationUseResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  guards: PolicyGuards;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  // Page-shaped display facts (the Task caseFileNumber precedent):
  // file numbers and document names resolve here in two bulk lookups,
  // never client-side and never N+1.
  const deriveUseStatus = async (uses: readonly CitationUse[]) => {
    const caseIds = [...new Set(uses.map((u) => u.spec?.caseId).filter((v): v is string => !!v))];
    const documentIds = [
      ...new Set(uses.map((u) => u.spec?.documentId).filter((v): v is string => !!v)),
    ];
    const [cases, documents] = await Promise.all([
      deps.store.getByIds("Case", caseIds),
      deps.store.getByIds("Document", documentIds),
    ]);
    for (const use of uses) {
      use.status = create(CitationUseStatusSchema, {
        caseFileNumber:
          (cases.get(use.spec?.caseId ?? "") as Case | undefined)?.spec?.fileNumber ?? "",
        documentFileName:
          (documents.get(use.spec?.documentId ?? "") as Document | undefined)?.spec?.fileName ??
          "",
      });
    }
  };

  const membershipOnWrite: PipelineStep<WriteContext<CitationUse>> = {
    name: "assert-case-membership",
    async execute(ctx) {
      const caseId = (ctx.newState as CitationUse).spec?.caseId;
      if (ctx.caller && caseId) {
        await deps.guards.assertCaseContent(ctx.caller, caseId);
      }
    },
  };

  /** The judgment-side invariants (module header): category JUDGMENT,
   * and readable by the caller — checked through the same policy the
   * document's own reads enforce (one policy, N enforcement points). */
  const judgmentIntegrity: PipelineStep<WriteContext<CitationUse>> = {
    name: "verify-cited-judgment",
    async execute(ctx) {
      const spec = (ctx.newState as CitationUse).spec;
      if (!spec?.documentId) return;
      const document = (await deps.store.getById("Document", spec.documentId)) as
        | Document
        | undefined;
      if (!document) {
        throw failedPrecondition(`Referenced document '${spec.documentId}' not found`);
      }
      if (document.spec?.category !== DocumentCategory.JUDGMENT) {
        throw failedPrecondition(
          "Only documents in the judgment collection can be cited — file the " +
            "judgment with category 'judgment' first",
        );
      }
      if (ctx.caller) {
        const decision = await deps.policy.authorize({
          caller: ctx.caller,
          kind: "Document",
          operation: "get",
          resource: document,
        });
        if (!decision.allow) {
          throw permissionDenied(decision.reason);
        }
      }
    },
  };

  return defineResource({
    definition: {
      kind: "CitationUse",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "cuse",
      schema: CitationUseSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: CitationUseService,
    operations: {
      create: createOperation<CitationUse>({
        beforePersist: [
          membershipOnWrite,
          referencesExistStep<CitationUse>(deps.store, [
            { kind: "Case", label: "case", get: (u) => u.spec?.caseId || undefined },
            { kind: "Document", label: "document", get: (u) => u.spec?.documentId || undefined },
          ]),
          judgmentIntegrity,
        ],
      }),
      list: customOperation<CitationUse, ListCitationUsesRequest, ListCitationUsesResponse>({
        async handler(ctx) {
          await ctx.authorize(); // role gate: office staff refused
          if (!ctx.caller) {
            throw invalidArgument("caller required");
          }

          // The three sanctioned shapes (proto contract). An explicit
          // case narrows by membership; every other shape scopes to the
          // caller's visible cases — the trail is never wider than what
          // the person may work (the matrix, applied as query shaping).
          let scope: Record<string, FilterValue> = {};
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
          if (ctx.input.documentId) {
            scope = { ...scope, documentId: ctx.input.documentId };
          }

          const { items, totalCount } = await deps.store.list("CitationUse", {
            limit: ctx.input.pageSize > 0 ? Math.min(ctx.input.pageSize, 100) : 20,
            offset: ctx.input.pageOffset > 0 ? ctx.input.pageOffset : 0,
            // Newest first — recent reliance is the interesting end.
            orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
            filter: scope,
          });
          const uses = items as CitationUse[];
          await deriveUseStatus(uses);
          return create(ListCitationUsesResponseSchema, {
            items: uses,
            totalCount: BigInt(totalCount),
          });
        },
      }),
      // No update, no delete: append-only by contract (module header).
    },
  });
}
