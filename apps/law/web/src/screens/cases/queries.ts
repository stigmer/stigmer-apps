/**
 * Case data access: the summary list with its named predicates, the
 * membership-gated full read, the two write paths (full-spec update;
 * lifecycle ONLY through UpdateStatus), and the case-scoped sections —
 * notes, documents, members, and the partner-only change history.
 * Ordering and derived facts are server contracts. Everything under a
 * case keys with the ["cases"] prefix, so a case's whole detail view
 * invalidates together.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Case,
  type CaseLifecycle,
  CaseSchema,
  type CaseSpec,
  CaseSpecSchema,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import { RoleOnCase } from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";

/** The list's named predicates — each a server-side query, never a client filter. */
export interface CaseListPredicates {
  /** Hearings within [today, today+N]; mutually exclusive with noNextDate. */
  readonly hearingWithinDays?: number;
  readonly noNextDate?: boolean;
  readonly mine?: boolean;
  readonly clientId?: string;
  /** UNSPECIFIED/absent = the working default (active only). */
  readonly lifecycle?: CaseLifecycle;
}

export function useCaseList(predicates: CaseListPredicates, page: number) {
  const { cases } = useApiClients();
  return useQuery({
    queryKey: ["cases", "list", predicates, page],
    queryFn: () =>
      cases.list({
        pageSize: PAGE_SIZE,
        pageOffset: page * PAGE_SIZE,
        hearingWithinDays: predicates.hearingWithinDays ?? 0,
        noNextDate: predicates.noNextDate ?? false,
        mine: predicates.mine ?? false,
        clientId: predicates.clientId ?? "",
        lifecycle: predicates.lifecycle ?? 0,
      }),
  });
}

/**
 * One summary page fetched for joining file numbers onto case-scoped
 * rows (home's hearings and deadlines) — one List, mapped by id, never
 * per-row Gets.
 */
export function useCaseSummaryMap() {
  const { cases } = useApiClients();
  return useQuery({
    queryKey: ["cases", "summaryMap"],
    queryFn: async () => {
      const page = await cases.list({ pageSize: 100 });
      return new Map(page.items.map((summary) => [summary.id, summary]));
    },
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

/** Lifecycle's ONLY write path — spec updates cannot smuggle it (DD-A6). */
export function useUpdateCaseLifecycle() {
  const { cases } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly id: string; readonly lifecycle: CaseLifecycle }) =>
      cases.updateStatus({ id: input.id, lifecycle: input.lifecycle }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases"] }),
  });
}

/* ------------------------------- notes ------------------------------- */

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

/* ----------------------------- documents ----------------------------- */

export function useCaseDocuments(caseId: string, page: number) {
  const { documents } = useApiClients();
  return useQuery({
    queryKey: ["cases", "documents", caseId, page],
    queryFn: () =>
      documents.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

/**
 * Search-as-you-type over the matter's extracted page text
 * (FR-DOC-004). Gated at the proto's minimum query length (2) — an
 * ungated first keystroke would be a guaranteed INVALID_ARGUMENT — and
 * keyed per trimmed query like the client register's search. Results
 * are the server's suggestion-list contract: top matches, no total.
 */
export function useCaseDocumentSearch(caseId: string, query: string) {
  const { documentPages } = useApiClients();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["cases", "documentSearch", caseId, trimmed],
    queryFn: () => documentPages.search({ query: trimmed, caseId }),
    enabled: trimmed.length >= 2,
  });
}

/**
 * File names for search hits, joined client-side from ONE list (the
 * useCaseSummaryMap pattern) — never a get per hit. Pages carry only
 * the document id; a hit beyond the first hundred documents renders
 * the neutral fallback rather than costing a second fetch.
 */
export function useCaseDocumentNames(caseId: string, enabled: boolean) {
  const { documents } = useApiClients();
  return useQuery({
    queryKey: ["cases", "documents", "nameMap", caseId],
    queryFn: async () => {
      const page = await documents.list({ caseId, pageSize: 100 });
      return new Map(page.items.map((doc) => [doc.metadata?.id ?? "", doc.spec?.fileName ?? ""]));
    },
    enabled,
  });
}

/** The viewer's metadata read. Get authorizes case membership, so a
 * foreign or invented id fails closed with the server's sentence. */
export function useDocument(id: string) {
  const { documents } = useApiClients();
  return useQuery({
    queryKey: ["cases", "documents", "byId", id],
    queryFn: () => documents.get({ id }),
  });
}

/** The viewer's bytes, through the SAME bearer-carrying byte route as
 * Download (a bare URL would reach the server with no identity). A
 * filed document is immutable — no update RPC exists — so the blob
 * never goes stale and reopening re-reads cache, not network. */
export function useDocumentBytes(id: string) {
  const { files } = useApiClients();
  return useQuery({
    queryKey: ["cases", "documents", "bytes", id],
    queryFn: () => files.downloadDocument(id),
    staleTime: Infinity,
  });
}

/**
 * Search-as-you-type over the matter's extracted page text — the web's
 * consumer of DocumentPageService.Search (FR-DOC-004; the assistant's
 * search_documents rides the same pipeline). The proto validates
 * query.min_len = 2, so the hook gates instead of firing a doomed
 * request; server defaults answer 8 hits, capped at 20, no total count
 * (a suggestion list by contract).
 */
export function useDocumentPageSearch(caseId: string, query: string) {
  const { documentPages } = useApiClients();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["cases", "documents", "search", caseId, trimmed],
    queryFn: () => documentPages.search({ query: trimmed, caseId }),
    enabled: trimmed.length >= 2,
  });
}

/**
 * The hits' citation facts: one cached Get per DISTINCT document, never
 * per hit — and the key is shared with useDocument, so opening a hit in
 * the viewer finds its metadata read already warm.
 */
export function useDocumentsById(ids: readonly string[]) {
  const { documents } = useApiClients();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["cases", "documents", "byId", id],
      queryFn: () => documents.get({ id }),
    })),
    combine: (results) =>
      new Map(
        results
          .map((result) => result.data)
          .filter((doc) => doc !== undefined)
          .map((doc) => [doc.metadata?.id ?? "", doc]),
      ),
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

/* ------------------------------ members ------------------------------ */

export function useCaseMembers(caseId: string) {
  const { caseMembers } = useApiClients();
  return useQuery({
    queryKey: ["cases", "members", caseId],
    queryFn: () => caseMembers.list({ caseId }),
  });
}

export function useAddCaseMember(caseId: string) {
  const { caseMembers } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly memberId: string; readonly roleOnCase: RoleOnCase }) =>
      caseMembers.create({
        spec: { caseId, memberId: input.memberId, roleOnCase: input.roleOnCase },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases", "members", caseId] }),
  });
}

export function useRemoveCaseMember(caseId: string) {
  const { caseMembers } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => caseMembers.remove({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cases", "members", caseId] }),
  });
}

/* --------------------------- change history --------------------------- */

/** Partner-only by policy; the screen only mounts it for partners. */
export function useCaseHistory(caseId: string, page: number) {
  const { auditEntries } = useApiClients();
  return useQuery({
    queryKey: ["cases", "history", caseId, page],
    queryFn: () =>
      auditEntries.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export { CaseSpecSchema, RoleOnCase };
