/**
 * Library data access (FR-CIT-002 + DD-012 D2): the citation SHELF —
 * one query over the Citation resource (identity + provenance, the
 * papers behind it derived server-side) — plus identity search, the
 * upload front door with identity, identity corrections, and the
 * reliance trail. Everything keys under ["library"]; recording a use
 * or filing invalidates the prefix.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import type { CitationIdentity } from "../../api/files.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Citation,
  type CitationSpec,
  CitationSchema,
} from "../../gen/stigmer/law/citation/v1/citation_pb.js";
import {
  CitationUseSchema,
  type CitationUseSpec,
} from "../../gen/stigmer/law/citationuse/v1/citationuse_pb.js";

/** The shelf, newest first — ListCitations IS the library screen. */
export function useShelf(page: number) {
  const { citations } = useApiClients();
  return useQuery({
    queryKey: ["library", "shelf", page],
    queryFn: () =>
      citations.list({ pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

/** Identity search (title + citation string), a suggestion list. */
export function useShelfSearch(query: string) {
  const { citations } = useApiClients();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["library", "shelfSearch", trimmed],
    queryFn: () => citations.search({ query: trimmed }),
    enabled: trimmed.length >= 1,
  });
}

/** Page-text search across the firm's documents (the assistant's
 * search_documents pipeline, firm-wide arm) — the Library search box's
 * second half: identity finds the entry, text finds the passage. */
export function useLibraryTextSearch(query: string) {
  const { documentPages } = useApiClients();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["library", "textSearch", trimmed],
    queryFn: () => documentPages.search({ query: trimmed, caseId: "" }),
    enabled: trimmed.length >= 2,
  });
}

/** The library's front door: upload a judgment with its identity,
 * firm-wide. Invalidates the whole ["library"] prefix. */
export function useUploadLibraryDocument() {
  const { files } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: File; identity?: CitationIdentity }) =>
      files.uploadLibraryDocument(input.file, input.identity),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["library"] }),
  });
}

/** Identity corrections (DD-012 D2): the entry is mutable so a typo is
 * never permanent. Full-spec replacement like every update (D10). */
export function useCorrectCitation() {
  const { citations } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly existing: Citation; readonly spec: CitationSpec }) =>
      citations.update(
        create(CitationSchema, { metadata: input.existing.metadata, spec: input.spec }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["library"] }),
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
