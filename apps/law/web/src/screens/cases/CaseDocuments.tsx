/**
 * Case documents (FR-CASE-005, FR-INTEG-001): upload through the byte
 * route (multi-file = repeated create, AC10), list newest first, and the
 * two read actions — View (the in-app reading frame: writing ?doc=<id>
 * swaps the detail frame for DocumentViewer, T09.2) and Download
 * (bearer fetch → triggered save; a bare link would arrive at the
 * server with no identity).
 *
 * CATEGORY (DD-012 session): the picker beside Upload names what kind
 * of paper is being filed (the header the backend always accepted but
 * the web never sent — every earlier upload landed uncategorized), and
 * the chips re-query the list server-side per category — a real filter
 * on the store's registered column, never a client-side sieve over one
 * page. Legacy uncategorized rows render the Other label and appear
 * under All (an UNSPECIFIED row cannot match the OTHER chip — the
 * proto's honest-bucket rule; they thin out as papers are re-filed).
 *
 * A judgment on the file can be PROMOTED to the library shelf
 * (DD-012 D2): the row's "Add to library" takes the citation identity
 * and the server copies the paper case-less — deliberately widening it
 * to the whole firm, which is why the act asks for the identity a
 * colleague will recognize.
 *
 * The search box rides the same Search pipeline as the assistant's
 * search_documents verb (FR-DOC-004), scoped to this matter; a typed
 * query swaps the list for page-cited hits (the register's pattern),
 * and opening a hit deep-links the reading frame at the cited page
 * (?doc + ?page — the T09.2 citation seam's first consumer). No role
 * gating here: anyone who can see this tab already passes the exact
 * case-content rule Search enforces.
 */

import { useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { useApiClients } from "../../api/clients.js";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button, buttonClass } from "../../components/Button.js";
import { FormError, InlineInput, Input, Label, Select } from "../../components/Field.js";
import { Pagination } from "../../components/Pagination.js";
import {
  DocumentCategory,
  type Document,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import { documentCategoryLabel } from "../../lib/format.js";
import { snippetParts } from "../../lib/snippet.js";
import {
  useCaseDocumentNames,
  useCaseDocumentSearch,
  useCaseDocuments,
  usePromoteToLibrary,
  useUploadDocuments,
} from "./queries.js";

/** The upload vocabulary: the byte route's category words beside their
 * enum (store-document.ts parseCategoryWord) — one source for the
 * picker and the chips. */
const CATEGORIES: readonly { word: string; value: DocumentCategory }[] = [
  { word: "pleading", value: DocumentCategory.PLEADING },
  { word: "application", value: DocumentCategory.APPLICATION },
  { word: "evidence", value: DocumentCategory.EVIDENCE },
  { word: "order_judgment", value: DocumentCategory.ORDER_JUDGMENT },
  { word: "correspondence", value: DocumentCategory.CORRESPONDENCE },
  { word: "vakalatnama", value: DocumentCategory.VAKALATNAMA },
  { word: "judgment", value: DocumentCategory.JUDGMENT },
  { word: "other", value: DocumentCategory.OTHER },
];

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

/** The promote form (DD-012 D2): the identity a colleague recognizes,
 * asked for at the moment of sharing — title required (the shelf's
 * own rule), the rest refinable later on the Library screen. */
function PromoteForm(props: {
  document: Document;
  onPromoted: () => void;
  onCancel: () => void;
}) {
  const promote = usePromoteToLibrary();
  const [title, setTitle] = useState("");
  const [court, setCourt] = useState("");
  const [year, setYear] = useState("");
  const [citation, setCitation] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await promote.mutateAsync({
        sourceDocumentId: props.document.metadata?.id ?? "",
        title: title.trim(),
        court: court.trim(),
        year: Number(year) || 0,
        citation: citation.trim(),
      });
      props.onPromoted();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Add to library"
      className="mt-2 w-full rounded-card border border-line p-3"
    >
      <p className="mb-2 text-xs text-ink-muted">
        A copy goes on the firm&apos;s citation shelf, readable by everyone who works
        cases. The matter&apos;s own copy stays here, unchanged.
      </p>
      <Label htmlFor="promote-title">Case name (as the firm cites it)</Label>
      <Input
        id="promote-title"
        required
        maxLength={300}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Arnesh Kumar vs State of Bihar"
      />
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 basis-40">
          <Label htmlFor="promote-court">Court</Label>
          <Input
            id="promote-court"
            maxLength={200}
            value={court}
            onChange={(e) => setCourt(e.target.value)}
          />
        </div>
        <div className="w-24">
          <Label htmlFor="promote-year">Year</Label>
          <Input
            id="promote-year"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </div>
        <div className="flex-1 basis-40">
          <Label htmlFor="promote-citation">Citation</Label>
          <Input
            id="promote-citation"
            maxLength={200}
            value={citation}
            onChange={(e) => setCitation(e.target.value)}
            placeholder="AIR 2014 SC 2756"
          />
        </div>
      </div>
      <FormError message={error} />
      <div className="mt-1 flex gap-2">
        <Button type="submit" variant="primary" disabled={promote.isPending}>
          {promote.isPending ? "Adding…" : "Add to library"}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function CaseDocuments(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  // UNSPECIFIED = the All chip (no server filter).
  const [filter, setFilter] = useState<DocumentCategory>(DocumentCategory.UNSPECIFIED);
  const documents = useCaseDocuments(props.caseId, page, filter);
  const upload = useUploadDocuments(props.caseId);
  const { files } = useApiClients();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] = useState("");
  const [actionError, setActionError] = useState<string | undefined>();
  const [promotingId, setPromotingId] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState<string | undefined>();
  const [, setSearchParams] = useSearchParams();

  async function onPicked(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setActionError(undefined);
    try {
      await upload.mutateAsync({ picked: [...picked], category: uploadCategory || undefined });
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
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold">Documents</h2>
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="upload-category">Filing as</Label>
            <Select
              id="upload-category"
              value={uploadCategory}
              onChange={(e) => setUploadCategory(e.target.value)}
            >
              <option value="">Uncategorized</option>
              {CATEGORIES.map(({ word, value }) => (
                <option key={word} value={word}>
                  {documentCategoryLabel(value)}
                </option>
              ))}
            </Select>
          </div>
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
      {confirmation && (
        <p role="status" className="mb-2 text-sm text-ok">
          {confirmation}
        </p>
      )}

      {query.length > 0 ? (
        <DocumentSearchResults caseId={props.caseId} query={query} onOpen={onOpenHit} />
      ) : (
        <>
          <div role="group" aria-label="Filter by category" className="mb-3 flex flex-wrap gap-1">
            <Button
              variant={filter === DocumentCategory.UNSPECIFIED ? "primary" : undefined}
              onClick={() => {
                setFilter(DocumentCategory.UNSPECIFIED);
                setPage(0);
              }}
            >
              All
            </Button>
            {CATEGORIES.map(({ word, value }) => (
              <Button
                key={word}
                variant={filter === value ? "primary" : undefined}
                onClick={() => {
                  setFilter(value);
                  setPage(0);
                }}
              >
                {documentCategoryLabel(value)}
              </Button>
            ))}
          </div>

          {documents.isPending && <Loading label="Loading documents…" />}
          {documents.isError && (
            <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
          )}
          {documents.isSuccess && documents.data.items.length === 0 && (
            <EmptyState
              title={
                filter === DocumentCategory.UNSPECIFIED
                  ? "No documents yet"
                  : `No ${documentCategoryLabel(filter).toLowerCase()} papers`
              }
            >
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
                    <Badge>{documentCategoryLabel(doc.spec?.category ?? DocumentCategory.UNSPECIFIED)}</Badge>
                    <span className="text-xs text-ink-faint">
                      {formatSize(doc.spec?.sizeBytes ?? 0n)}
                    </span>
                    <Button onClick={() => onView(doc)}>View</Button>
                    <Button onClick={() => void onDownload(doc)}>Download</Button>
                    {doc.spec?.category === DocumentCategory.JUDGMENT && (
                      <Button
                        onClick={() => {
                          setConfirmation(undefined);
                          setPromotingId((current) =>
                            current === doc.metadata?.id ? undefined : doc.metadata?.id,
                          );
                        }}
                      >
                        Add to library
                      </Button>
                    )}
                    {promotingId === doc.metadata?.id && (
                      <PromoteForm
                        document={doc}
                        onCancel={() => setPromotingId(undefined)}
                        onPromoted={() => {
                          setPromotingId(undefined);
                          setConfirmation(
                            `“${doc.spec?.fileName}” is on the library shelf — the whole firm can cite it now.`,
                          );
                        }}
                      />
                    )}
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
