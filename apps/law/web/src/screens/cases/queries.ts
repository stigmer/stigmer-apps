/**
 * Case, note, and document data access (T04b D3). Ordering and derived
 * facts are server contracts: cases soonest-hearing-first dateless-last
 * (FR-CASE-002), notes newest-first (FR-CASE-006), documents newest-first
 * with the derived document_count on the case (FR-CASE-005 AC8). Notes
 * and documents key under ["cases", …, caseId], so a case's whole detail
 * view invalidates with one prefix.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Case,
  CaseSchema,
  type CaseSpec,
  CaseSpecSchema,
} from "../../gen/stigmer/law/case/v1/case_pb.js";

export function useCaseList(page: number) {
  const { cases } = useApiClients();
  return useQuery({
    queryKey: ["cases", "list", page],
    queryFn: () => cases.list({ pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export function useCase(id: string) {
  const { cases } = useApiClients();
  return useQuery({
    queryKey: ["cases", "byId", id],
    queryFn: () => cases.get({ id }),
  });
}

export function useCreateCase() {
  const { cases } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: CaseSpec) => cases.create(create(CaseSchema, { spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases"] }),
  });
}

/** Full-spec replacement (D10): callers submit the COMPLETE desired spec. */
export function useUpdateCase() {
  const { cases } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly existing: Case; readonly spec: CaseSpec }) =>
      cases.update(create(CaseSchema, { metadata: input.existing.metadata, spec: input.spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases"] }),
  });
}

export function useCaseNotes(caseId: string, page: number) {
  const { caseNotes } = useApiClients();
  return useQuery({
    queryKey: ["cases", "notes", caseId, page],
    queryFn: () =>
      caseNotes.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export function useAddCaseNote(caseId: string) {
  const { caseNotes } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => caseNotes.create({ spec: { caseId, content } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases", "notes", caseId] }),
  });
}

export function useCaseDocuments(caseId: string, page: number) {
  const { documents } = useApiClients();
  return useQuery({
    queryKey: ["cases", "documents", caseId, page],
    queryFn: () =>
      documents.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

/** Multi-file upload = repeated create (FR-CASE-005 AC10), sequential. */
export function useUploadDocuments(caseId: string) {
  const { files } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (picked: readonly File[]) => {
      for (const file of picked) {
        await files.uploadDocument(caseId, file);
      }
    },
    // The case's derived document_count changed too — one prefix covers
    // the documents list AND every case read.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases"] }),
  });
}

export { CaseSpecSchema };
