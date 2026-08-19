/**
 * Library data access (FR-CIT-001/002): the firm-wide judgment
 * collection (the ONE case-less document list the contract allows —
 * FR-DOC-002, still visibility-scoped server-side) and the reliance
 * trail beside it. Everything keys under ["library"]; recording a use
 * invalidates the prefix.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  CitationUseSchema,
  type CitationUseSpec,
} from "../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";
import { DocumentCategory } from "../../gen/stigmer/law/document/v1/document_pb.js";

/** The judgment collection, newest first (the list contract). */
export function useJudgmentCollection(page: number) {
  const { documents } = useApiClients();
  return useQuery({
    queryKey: ["library", "judgments", page],
    queryFn: () =>
      documents.list({
        category: DocumentCategory.JUDGMENT,
        pageSize: PAGE_SIZE,
        pageOffset: page * PAGE_SIZE,
      }),
  });
}

/** One judgment's reliance trail — everywhere the firm used it.
 * Enabled on demand: a hundred judgments on screen must not mean a
 * hundred trail queries (the row passes its open state). */
export function useCitationUsesByDocument(documentId: string, enabled: boolean) {
  const { citationUses } = useApiClients();
  return useQuery({
    queryKey: ["library", "uses", documentId],
    queryFn: () => citationUses.list({ documentId, pageSize: 20 }),
    enabled,
  });
}

export function useRecordCitationUse(documentId: string) {
  const { citationUses } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: Omit<CitationUseSpec, "$typeName" | "documentId">) =>
      citationUses.create(
        create(CitationUseSchema, {
          spec: { documentId, caseId: spec.caseId, proposition: spec.proposition },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["library", "uses", documentId] }),
  });
}
