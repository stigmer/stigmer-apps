/**
 * The Library (FR-CIT-002 + DD-012 D2): the firm's citation SHELF —
 * one list of Citation entries (identity a lawyer recognizes, never a
 * bare file name), each with its provenance ("filed to the library" /
 * "promoted from <matter>"), its reliance trail on demand, an
 * identity-correction affordance (the entry is mutable so a typo is
 * never permanent), and Read into the shared viewer (?doc= — the
 * case-detail precedent; marks made here are the FIRM layer).
 *
 * The front door takes the identity beside the bytes — the moment of
 * filing is when someone knows what the judgment IS. Judgments filed
 * on matters reach this shelf through "Add to library" on their own
 * case's Documents tab (promotion); the old "judgments filed on
 * matters" pile is gone — the shelf is CURATED, which is what makes
 * it the firm's knowledge rather than a listing.
 *
 * SEARCH: two honest answers side by side — identity hits (the
 * Citation search: "the case I mean") and page-text hits (the same
 * firm-wide pipeline the assistant rides: "the passage I remember"),
 * each hit opening the viewer at the cited page.
 */

import { useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button, buttonClass } from "../../components/Button.js";
import { FormError, InlineInput, Input, Label, Select } from "../../components/Field.js";
import {
  CitationIdentityFields,
  EMPTY_IDENTITY,
  type CitationIdentityDraft,
} from "./CitationIdentityFields.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Pagination } from "../../components/Pagination.js";
import { SectionCard } from "../../components/SectionCard.js";
import {
  type Citation,
  CitationSpecSchema,
} from "../../gen/stigmer/law/citation/v1/citation_pb.js";
import { create } from "@bufbuild/protobuf";
import { citationFacts, formatCalendarDate } from "../../lib/format.js";
import { snippetParts } from "../../lib/snippet.js";
import { useCaseList } from "../cases/queries.js";
import { DocumentViewer } from "../cases/DocumentViewer.js";
import {
  useCitationUsesByDocument,
  useCorrectCitation,
  useLibraryTextSearch,
  useRecordCitationUse,
  useShelf,
  useShelfSearch,
  useUploadLibraryDocument,
} from "./queries.js";

function filedDay(citation: Citation): string {
  const seconds = citation.metadata?.createdAt?.seconds;
  return seconds
    ? formatCalendarDate(new Date(Number(seconds) * 1000).toISOString().slice(0, 10))
    : "";
}

/** The front door: the judgment's bytes AND its identity in one act —
 * a real form, so "case name required" is the browser's own refusal,
 * not a server round trip (error prevention over error messages). */
function LibraryUpload() {
  const upload = useUploadLibraryDocument();
  const [identity, setIdentity] = useState(EMPTY_IDENTITY);
  const [file, setFile] = useState<File | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setConfirmation(undefined);
    if (!file) {
      setError("Pick the judgment's file first.");
      return;
    }
    setError(undefined);
    try {
      await upload.mutateAsync({
        file,
        identity: {
          title: identity.title.trim(),
          court: identity.court.trim() || undefined,
          year: Number(identity.year) || undefined,
          citation: identity.citation.trim() || undefined,
        },
      });
      setConfirmation(`“${identity.title.trim()}” is on the shelf.`);
      setIdentity(EMPTY_IDENTITY);
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <CitationIdentityFields idPrefix="shelf" value={identity} onChange={setIdentity}>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          className="sr-only"
          id="library-upload"
          onChange={(e) => setFile(e.target.files?.[0])}
        />
        <label htmlFor="library-upload" className={`${buttonClass()} cursor-pointer`}>
          Pick the file
        </label>
        <Button type="submit" variant="primary" disabled={upload.isPending}>
          {upload.isPending ? "Adding…" : "Add to the library"}
        </Button>
      </CitationIdentityFields>
      <p className="mt-1 text-xs text-ink-muted">
        {file ? `Picked: ${file.name}. ` : "PDF, PNG, or JPG — up to 25 MB. "}
        Court, year, and citation can be added or corrected later; the paper itself is
        permanent.
      </p>
      {confirmation && (
        <p role="status" className="mt-1 text-sm text-ok">
          {confirmation}
        </p>
      )}
      {error && (
        <div className="mt-1">
          <FormError message={error} />
        </div>
      )}
    </form>
  );
}

function RecordUseForm(props: { documentId: string; onDone: () => void }) {
  const record = useRecordCitationUse(props.documentId);
  // The caller's working case list — the matters they may record a use
  // on (the server re-checks; this is convenience, not authority).
  const cases = useCaseList({}, 0);
  const [caseId, setCaseId] = useState("");
  const [proposition, setProposition] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await record.mutateAsync({ caseId, proposition: proposition.trim() });
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Record a use"
      className="mt-2 rounded-card border border-line p-3"
    >
      <Label htmlFor="use-case">Used in</Label>
      <Select id="use-case" required value={caseId} onChange={(e) => setCaseId(e.target.value)}>
        <option value="">Pick the matter</option>
        {cases.data?.items.map((summary) => (
          <option key={summary.id} value={summary.id}>
            {summary.fileNumber}
          </option>
        ))}
      </Select>
      <Label htmlFor="use-proposition">For what proposition</Label>
      <Input
        id="use-proposition"
        required
        maxLength={500}
        value={proposition}
        onChange={(e) => setProposition(e.target.value)}
        placeholder="bail where the offence carries under seven years"
      />
      <FormError message={error} />
      <Button type="submit" variant="primary" disabled={record.isPending}>
        {record.isPending ? "Recording…" : "Record use"}
      </Button>
    </form>
  );
}

/** Identity corrections in place (DD-012 D2): the words, never the
 * paper — the server refuses a re-pointed document link. */
function CorrectIdentityForm(props: { citation: Citation; onDone: () => void }) {
  const correct = useCorrectCitation();
  const spec = props.citation.spec;
  const [identity, setIdentity] = useState<CitationIdentityDraft>({
    title: spec?.title ?? "",
    court: spec?.court ?? "",
    year: spec?.year ? String(spec.year) : "",
    citation: spec?.citation ?? "",
  });
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await correct.mutateAsync({
        existing: props.citation,
        spec: create(CitationSpecSchema, {
          // The immutable links carry over verbatim; only words change
          // (the server refuses anything else — verify-immutable-links).
          documentId: spec?.documentId ?? "",
          promotedFromCaseId: spec?.promotedFromCaseId ?? "",
          promotedFromDocumentId: spec?.promotedFromDocumentId ?? "",
          title: identity.title.trim(),
          court: identity.court.trim(),
          year: Number(identity.year) || 0,
          citation: identity.citation.trim(),
        }),
      });
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Correct the identity"
      className="mt-2 w-full rounded-card border border-line p-3"
    >
      <CitationIdentityFields idPrefix="fix" value={identity} onChange={setIdentity} />
      <div className="mt-2">
        <FormError message={error} />
      </div>
      <div className="mt-1 flex gap-2">
        <Button type="submit" variant="primary" disabled={correct.isPending}>
          {correct.isPending ? "Saving…" : "Save"}
        </Button>
        <Button onClick={props.onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** One shelf entry: identity, provenance, trail on demand. */
function ShelfRow(props: { citation: Citation; onRead: () => void }) {
  const { citation } = props;
  const documentId = citation.spec?.documentId ?? "";
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [fixing, setFixing] = useState(false);
  // The trail loads only when the row opens — a hundred judgments must
  // not mean a hundred queries on screen entry.
  const uses = useCitationUsesByDocument(documentId, open);
  const facts = citationFacts(citation.spec ?? {});
  const filed = filedDay(citation);

  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 basis-56">
          <span className="block font-medium">{citation.spec?.title}</span>
          <span className="block text-xs text-ink-muted">
            {facts && `${facts} · `}
            {citation.status?.documentFileName}
            {filed && ` · ${filed}`}
          </span>
        </span>
        {citation.status?.promotedFromFileNumber ? (
          <Badge>from {citation.status.promotedFromFileNumber}</Badge>
        ) : (
          <Badge>Library</Badge>
        )}
        <span className="flex gap-1">
          <Button onClick={props.onRead}>Read</Button>
          <Button onClick={() => setFixing((v) => !v)}>{fixing ? "Close" : "Edit"}</Button>
          <Button onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Where we used it"}
          </Button>
        </span>
      </div>

      {fixing && (
        <CorrectIdentityForm citation={citation} onDone={() => setFixing(false)} />
      )}

      {open && (
        <div className="mt-2">
          {uses.isPending && <Loading label="Loading the trail…" />}
          {uses.isError && (
            <ErrorState error={uses.error} onRetry={() => void uses.refetch()} />
          )}
          {uses.isSuccess && uses.data.items.length === 0 && (
            <p className="text-xs text-ink-muted">
              No recorded uses yet — record one when this judgment carries an argument.
            </p>
          )}
          {uses.isSuccess && uses.data.items.length > 0 && (
            <ul className="grid gap-1">
              {uses.data.items.map((use) => (
                <li key={use.metadata?.id} className="text-xs">
                  <span className="font-medium">{use.status?.caseFileNumber}</span>
                  {" — "}
                  {use.spec?.proposition}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <Button onClick={() => setRecording((v) => !v)}>
              {recording ? "Close" : "Record a use"}
            </Button>
          </div>
          {recording && <RecordUseForm documentId={documentId} onDone={() => setRecording(false)} />}
        </div>
      )}
    </li>
  );
}

/** The search box's two honest answers: identity hits and page-text
 * hits, each labeled for what it is. */
function LibrarySearchResults(props: {
  query: string;
  onOpen: (documentId: string, page?: number) => void;
}) {
  const trimmed = props.query.trim();
  const identity = useShelfSearch(trimmed);
  const text = useLibraryTextSearch(trimmed);

  return (
    <SectionCard title={`Search: “${trimmed}”`}>
      <h3 className="mb-1 text-xs font-semibold text-ink-muted">Matching citations</h3>
      {identity.isPending && <Loading label="Searching the shelf…" />}
      {identity.isError && (
        <ErrorState error={identity.error} onRetry={() => void identity.refetch()} />
      )}
      {identity.isSuccess && identity.data.items.length === 0 && (
        <p className="mb-2 text-sm text-ink-muted">No shelf entry matches the name.</p>
      )}
      {identity.isSuccess && identity.data.items.length > 0 && (
        <ul className="mb-3 rounded-card border border-line">
          {identity.data.items.map((citation) => {
            const facts = citationFacts(citation.spec ?? {});
            return (
              <li
                key={citation.metadata?.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium">{citation.spec?.title}</span>
                  <span className="block text-xs text-ink-muted">
                    {facts && `${facts} · `}
                    {citation.status?.documentFileName}
                  </span>
                </span>
                <Button onClick={() => props.onOpen(citation.spec?.documentId ?? "")}>
                  Read
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mb-1 text-xs font-semibold text-ink-muted">
        Matching passages (page-cited)
      </h3>
      {trimmed.length < 2 && (
        <p className="text-sm text-ink-muted">Type at least two letters to search inside pages.</p>
      )}
      {text.isPending && trimmed.length >= 2 && <Loading label="Searching pages…" />}
      {text.isError && <ErrorState error={text.error} onRetry={() => void text.refetch()} />}
      {text.isSuccess && text.data.items.length === 0 && (
        <p className="text-sm text-ink-muted">
          No page matches. Matching is exact — a different word may find it.
        </p>
      )}
      {text.isSuccess && text.data.items.length > 0 && (
        <ul aria-label="Matching pages" className="rounded-card border border-line">
          {text.data.items.map((hit) => {
            const parts = snippetParts(hit.spec?.text ?? "", trimmed);
            return (
              <li
                key={hit.metadata?.id}
                className="border-b border-line px-3 py-2 last:border-b-0"
              >
                <button
                  type="button"
                  className="font-medium text-brand hover:underline"
                  onClick={() => props.onOpen(hit.spec?.documentId ?? "", hit.spec?.page)}
                >
                  Page {hit.spec?.page}
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
      )}
    </SectionCard>
  );
}

export function LibraryScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [shelfPage, setShelfPage] = useState(0);
  const [query, setQuery] = useState("");
  const shelf = useShelf(shelfPage);

  // The open document swaps the whole frame for the shared reading
  // view — the case-detail precedent (T09.2); Get/download authorize
  // server-side, so a foreign id fails closed inside the frame.
  const viewedDocumentId = searchParams.get("doc");
  const requestedPage = Number(searchParams.get("page"));
  const documentPage =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : undefined;

  function openDocument(id: string, page?: number) {
    setSearchParams((params) => {
      params.set("doc", id);
      if (page) params.set("page", String(page));
      return params;
    });
  }
  function onCloseDocument() {
    setSearchParams(
      (params) => {
        params.delete("doc");
        params.delete("page");
        return params;
      },
      { replace: true },
    );
  }

  if (viewedDocumentId) {
    return (
      <DocumentViewer
        documentId={viewedDocumentId}
        page={documentPage}
        onClose={onCloseDocument}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <PageHeader title="Library" />
      <p className="-mt-2 text-sm text-ink-muted">
        The firm&apos;s citation shelf: the judgments the firm relies on, filed once with
        the name a colleague recognizes, each carrying where it worked before.
      </p>

      <SectionCard title="Add to the library">
        <LibraryUpload />
      </SectionCard>

      <div>
        <label htmlFor="library-search" className="mb-1 block text-sm font-medium">
          Search the shelf
        </label>
        <InlineInput
          id="library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A case name, a citation, or a phrase from the judgment"
          className="block w-full max-w-xl"
        />
      </div>

      {query.trim().length > 0 ? (
        <LibrarySearchResults query={query} onOpen={openDocument} />
      ) : (
        <SectionCard title="Citations on the shelf">
          {shelf.isPending && <Loading label="Loading the shelf…" />}
          {shelf.isError && (
            <ErrorState error={shelf.error} onRetry={() => void shelf.refetch()} />
          )}
          {shelf.isSuccess && shelf.data.items.length === 0 && (
            <EmptyState title="Nothing on the shelf yet">
              Upload a judgment the firm relies on — or promote one from a matter&apos;s
              Documents tab (&ldquo;Add to library&rdquo;) — and it becomes citable
              everywhere.
            </EmptyState>
          )}
          {shelf.isSuccess && shelf.data.items.length > 0 && (
            <>
              <ul>
                {shelf.data.items.map((citation) => (
                  <ShelfRow
                    key={citation.metadata?.id}
                    citation={citation}
                    onRead={() => openDocument(citation.spec?.documentId ?? "")}
                  />
                ))}
              </ul>
              <Pagination
                page={shelfPage}
                totalCount={Number(shelf.data.totalCount)}
                onPage={setShelfPage}
              />
            </>
          )}
        </SectionCard>
      )}
    </div>
  );
}
