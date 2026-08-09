/**
 * Case documents (FR-CASE-005, FR-INTEG-001): upload through the byte
 * route (multi-file = repeated create, AC10), list newest first, and the
 * two read actions — View (object URL in a new tab; the route's
 * attachment disposition doesn't apply to object URLs) and Download
 * (triggered save). Both fetch WITH the bearer — a bare link would
 * arrive at the server with no identity.
 */

import { useRef, useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { useApiClients } from "../../api/clients.js";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import { useCaseDocuments, useUploadDocuments } from "./queries.js";

function formatSize(bytes: bigint): string {
  const n = Number(bytes);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function CaseDocuments(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const documents = useCaseDocuments(props.caseId, page);
  const upload = useUploadDocuments(props.caseId);
  const { files } = useApiClients();
  const fileInput = useRef<HTMLInputElement>(null);
  const [actionError, setActionError] = useState<string | undefined>();

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

  async function withBlobUrl(doc: Document, use: (url: string) => void) {
    setActionError(undefined);
    try {
      const blob = await files.downloadDocument(doc.metadata?.id ?? "");
      const url = URL.createObjectURL(blob);
      use(url);
      // Long enough for the tab/save to take the bytes; then release.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setActionError(ConnectError.from(err).rawMessage);
    }
  }

  function onView(doc: Document) {
    // An anchor, not window.open: Chromium blocks top-frame blob
    // navigation from a noopener window.open, leaving a blank tab.
    void withBlobUrl(doc, (url) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.click();
    });
  }

  function onDownload(doc: Document) {
    void withBlobUrl(doc, (url) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.spec?.fileName ?? "document";
      anchor.click();
    });
  }

  return (
    <section aria-label="Documents" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Documents</h2>
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
          <label
            htmlFor="document-upload"
            className="flex h-11 cursor-pointer items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
          >
            {upload.isPending ? "Uploading…" : "Upload documents"}
          </label>
        </div>
      </div>
      <p className="mb-2 text-sm text-ink-muted">PDF, PNG, or JPG — up to 25 MB each.</p>

      {actionError && (
        <p role="alert" className="mb-2 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {actionError}
        </p>
      )}

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
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="flex-1 basis-48 font-medium">{doc.spec?.fileName}</span>
                <span className="text-sm text-ink-faint">
                  {formatSize(doc.spec?.sizeBytes ?? 0n)}
                </span>
                <button
                  type="button"
                  onClick={() => onView(doc)}
                  className="h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
                >
                  View
                </button>
                <button
                  type="button"
                  onClick={() => onDownload(doc)}
                  className="h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
                >
                  Download
                </button>
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
    </section>
  );
}
