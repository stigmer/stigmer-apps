/**
 * Case documents (FR-CASE-005, FR-INTEG-001): upload through the byte
 * route (multi-file = repeated create, AC10), list newest first, and the
 * two read actions — View (the in-app reading frame: writing ?doc=<id>
 * swaps the detail frame for DocumentViewer, T09.2) and Download
 * (bearer fetch → triggered save; a bare link would arrive at the
 * server with no identity).
 *
 * The search box rides the same Search pipeline as the assistant's
 * search_documents verb (FR-DOC-004), scoped to this matter; a typed
 * query swaps the list for page-cited hits (the register's pattern),
 * and opening a hit deep-links the reading frame at the cited page
 * (?doc + ?page — the T09.2 citation seam's first consumer). No role
 * gating here: anyone who can see this tab already passes the exact
 * case-content rule Search enforces.
 */

import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { useApiClients } from "../../api/clients.js";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button, buttonClass } from "../../components/Button.js";
import { FormError, InlineInput } from "../../components/Field.js";
import { Pagination } from "../../components/Pagination.js";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import { snippetParts } from "../../lib/snippet.js";
import {
  useCaseDocumentNames,
  useCaseDocumentSearch,
  useCaseDocuments,
  useUploadDocuments,
} from "./queries.js";

function formatSize(bytes: bigint): string {
  const n = Number(bytes);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Page-cited hits for one matter — file, page, highlighted passage. */
function DocumentSearchResults(props: {
  caseId: string;
  query: string;
  onOpen: (documentId: string, page: number) => void;
}) {
  const trimmed = props.query.trim();
  const search = useCaseDocumentSearch(props.caseId, props.query);
  const hits = search.data?.items ?? [];
  // One list joined by id (the useCaseSummaryMap discipline: never a
  // Get per hit); fetched only once a real query is live.
  const names = useCaseDocumentNames(props.caseId, trimmed.length >= 2);

  if (trimmed.length < 2) {
    return <p className="text-sm text-ink-muted">Type at least two letters to search.</p>;
  }
  if (search.isPending) return <Loading label="Searching pages…" />;
  if (search.isError) {
    return <ErrorState error={search.error} onRetry={() => void search.refetch()} />;
  }
  if (hits.length === 0) {
    return (
      <EmptyState title="No pages match">
        Matching is exact — a different word may find it. Scans are searchable only
        after the system has read them — where scan reading is set up, that takes a
        few minutes.
      </EmptyState>
    );
  }
  return (
    <ul aria-label="Matching pages" className="rounded-card border border-line bg-surface">
      {hits.map((hit) => {
        const parts = snippetParts(hit.spec?.text ?? "", trimmed);
        const fileName = names.data?.get(hit.spec?.documentId ?? "");
        return (
          <li key={hit.metadata?.id} className="border-b border-line px-3 py-2 last:border-b-0">
            <button
              type="button"
              className="font-medium text-brand hover:underline"
              onClick={() => props.onOpen(hit.spec?.documentId ?? "", hit.spec?.page ?? 0)}
            >
              {/* Name map still loading (or a hit past its 100-doc cap):
                  the neutral placeholder, replaced when the join lands. */}
              {fileName ?? "Document"}
              <span className="font-normal text-ink-muted"> — page {hit.spec?.page}</span>
            </button>
            <p className="mt-0.5 text-sm text-ink-muted">
              {parts.prefix}
              {parts.match && <mark>{parts.match}</mark>}
              {parts.suffix}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function CaseDocuments(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const documents = useCaseDocuments(props.caseId, page);
  const upload = useUploadDocuments(props.caseId);
  const { files } = useApiClients();
  const fileInput = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const [, setSearchParams] = useSearchParams();

  async function onPicked(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setActionError(undefined);
    try {
      await upload.mutateAsync([...picked]);
    } catch (err) {
      // The failed file's own sentence (mime/size pre-check or the
      // server's answer); already-uploaded files of the batch stay.
      setActionError(ConnectError.from(err).rawMessage);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function onView(doc: Document) {
    // A PUSH, not replace: browser Back from the reading frame is
    // "close the document" (the tab param itself keeps replace
    // semantics — see CaseDetailScreen).
    setSearchParams((params) => {
      params.set("doc", doc.metadata?.id ?? "");
      return params;
    });
  }

  function onOpenHit(documentId: string, atPage: number) {
    // Same PUSH semantics as View, landing the reading frame on the
    // cited page (?page is the reader's app-controlled scroll-to-page
    // since T12; input-only — scrolling never writes it back).
    setSearchParams((params) => {
      params.set("doc", documentId);
      params.set("page", String(atPage));
      return params;
    });
  }

  async function onDownload(doc: Document) {
    setActionError(undefined);
    try {
      const blob = await files.downloadDocument(doc.metadata?.id ?? "");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.spec?.fileName ?? "document";
      anchor.click();
      // Long enough for the save to take the bytes; then release.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setActionError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <section aria-label="Documents" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Documents</h2>
        <div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg"
            className="sr-only"
            id="document-upload"
            onChange={(e) => void onPicked(e.target.files)}
          />
          <label htmlFor="document-upload" className={`${buttonClass("primary")} cursor-pointer`}>
            {upload.isPending ? "Uploading…" : "Upload documents"}
          </label>
        </div>
      </div>
      <p className="mb-2 text-xs text-ink-muted">PDF, PNG, or JPG — up to 25 MB each.</p>

      <label htmlFor="document-search" className="mb-1 block text-sm font-medium">
        Search inside this matter's documents
      </label>
      <InlineInput
        id="document-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="An exact word or phrase, e.g. 'limitation'"
        className="mb-4 block w-full max-w-xl"
      />

      <FormError message={actionError} />

      {query.length > 0 ? (
        <DocumentSearchResults caseId={props.caseId} query={query} onOpen={onOpenHit} />
      ) : (
        <>
          {documents.isPending && <Loading label="Loading documents…" />}
          {documents.isError && (
            <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
          )}
          {documents.isSuccess && documents.data.items.length === 0 && (
            <EmptyState title="No documents yet">
              Petitions, orders, and evidence uploaded here stay with the case.
            </EmptyState>
          )}
          {documents.isSuccess && documents.data.items.length > 0 && (
            <>
              <ul className="rounded-card border border-line bg-surface">
                {documents.data.items.map((doc) => (
                  <li
                    key={doc.metadata?.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 last:border-b-0"
                  >
                    <span className="flex-1 basis-48 font-medium">{doc.spec?.fileName}</span>
                    <span className="text-xs text-ink-faint">
                      {formatSize(doc.spec?.sizeBytes ?? 0n)}
                    </span>
                    <Button onClick={() => onView(doc)}>View</Button>
                    <Button onClick={() => void onDownload(doc)}>Download</Button>
                  </li>
                ))}
              </ul>
              <Pagination
                page={page}
                totalCount={Number(documents.data.totalCount)}
                onPage={setPage}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
