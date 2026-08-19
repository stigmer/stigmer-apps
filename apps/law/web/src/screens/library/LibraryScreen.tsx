/**
 * The Library (FR-CIT-002 + FR-DOC-005): the firm's public-record
 * shelf. Three honest piles, three simple queries — never one
 * offset-spliced list:
 *
 *   1. Bare acts — the statutes' own texts, case-less by construction,
 *      linked from every matter's Acts tab ("Read the Act").
 *   2. The library's citations — judgments filed directly to the firm
 *      (no owning matter), with each one's reliance trail.
 *   3. Judgments filed on matters — the case-bound collection
 *      (FR-DOC-002), reachable through their own matter's viewer.
 *
 * The front door is HERE: upload a bare act or a standalone citation
 * firm-wide (the byte route enforces the library-categories rule).
 * Reading a library document swaps this frame for the shared viewer
 * (?doc= — the case-detail precedent); marks are a named deferral on
 * library documents, so the panel simply lists none.
 */

import { useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button, ButtonLink, buttonClass } from "../../components/Button.js";
import { FormError, Input, Label, Select } from "../../components/Field.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Pagination } from "../../components/Pagination.js";
import { SectionCard } from "../../components/SectionCard.js";
import {
  DocumentCategory,
  type Document,
} from "../../gen/stigmer/law/document/v1/document_pb.js";
import { formatCalendarDate } from "../../lib/format.js";
import { useCaseList, useCaseSummaryMap } from "../cases/queries.js";
import { DocumentViewer } from "../cases/DocumentViewer.js";
import {
  useCitationUsesByDocument,
  useJudgmentCollection,
  useLibraryDocuments,
  useRecordCitationUse,
  useUploadLibraryDocument,
} from "./queries.js";

function uploadedDay(document: Document): string {
  const seconds = document.metadata?.createdAt?.seconds;
  return seconds
    ? formatCalendarDate(new Date(Number(seconds) * 1000).toISOString().slice(0, 10))
    : "";
}

/** The front door: pick the shelf (act or judgment), pick the file. */
function LibraryUpload() {
  const upload = useUploadLibraryDocument();
  const [category, setCategory] = useState<"act" | "judgment">("judgment");
  const [error, setError] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  async function onPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(undefined);
    setConfirmation(undefined);
    try {
      for (const file of files) {
        await upload.mutateAsync({ file, category });
      }
      setConfirmation(
        `${files.length > 1 ? `${files.length} files` : `“${files[0]?.name}”`} added to the library.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : ConnectError.from(err).rawMessage);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor="library-category">Add to the library as</Label>
        <Select
          id="library-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as "act" | "judgment")}
        >
          <option value="judgment">Judgment / citation</option>
          <option value="act">Bare act (the statute's text)</option>
        </Select>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="application/pdf,image/png,image/jpeg"
        className="sr-only"
        id="library-upload"
        onChange={(e) => void onPicked(e.target.files)}
      />
      <label htmlFor="library-upload" className={`${buttonClass("primary")} cursor-pointer`}>
        {upload.isPending ? "Uploading…" : "Upload to library"}
      </label>
      {confirmation && (
        <p role="status" className="w-full text-sm text-ok">
          {confirmation}
        </p>
      )}
      {error && (
        <div className="w-full">
          <FormError message={error} />
        </div>
      )}
    </div>
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

/** One judgment (either pile) with its reliance trail on demand. */
function JudgmentRow(props: {
  document: Document;
  fileNumber?: string;
  onRead: () => void;
}) {
  const { document } = props;
  const id = document.metadata?.id ?? "";
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  // The trail loads only when the row opens — a hundred judgments must
  // not mean a hundred queries on screen entry.
  const uses = useCitationUsesByDocument(id, open);
  const uploaded = uploadedDay(document);

  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{document.spec?.fileName}</span>
        <span className="text-xs text-ink-muted">
          {props.fileNumber ? `filed on ${props.fileNumber}` : "Firm library"}
          {uploaded && `, ${uploaded}`}
        </span>
        <span className="ml-auto flex gap-1">
          {props.fileNumber ? (
            <ButtonLink
              to={`/cases/${document.spec?.caseId}?tab=Documents&doc=${id}`}
            >
              Read
            </ButtonLink>
          ) : (
            <Button onClick={props.onRead}>Read</Button>
          )}
          <Button onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Where we used it"}
          </Button>
        </span>
      </div>

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
          {recording && <RecordUseForm documentId={id} onDone={() => setRecording(false)} />}
        </div>
      )}
    </li>
  );
}

export function LibraryScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [actsPage, setActsPage] = useState(0);
  const [shelfPage, setShelfPage] = useState(0);
  const [mattersPage, setMattersPage] = useState(0);
  const acts = useLibraryDocuments(DocumentCategory.ACT, actsPage);
  const shelf = useLibraryDocuments(DocumentCategory.JUDGMENT, shelfPage);
  const onMatters = useJudgmentCollection(mattersPage);
  const summaries = useCaseSummaryMap();
  const fileNumberOf = (caseId: string | undefined) =>
    summaries.data?.get(caseId ?? "")?.fileNumber ?? "…";

  // The open document swaps the whole frame for the shared reading
  // view — the case-detail precedent (T09.2); Get/download authorize
  // server-side, so a foreign id fails closed inside the frame.
  const viewedDocumentId = searchParams.get("doc");
  const requestedPage = Number(searchParams.get("page"));
  const documentPage =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : undefined;

  function openDocument(id: string) {
    setSearchParams((params) => {
      params.set("doc", id);
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
        The firm&apos;s public-record shelf: bare acts and citations, filed once for everyone.
        Ask the assistant to search inside them — &ldquo;what does Section 420 say?&rdquo;
      </p>

      <SectionCard title="Add to the library">
        <LibraryUpload />
      </SectionCard>

      <SectionCard title="Bare acts">
        {acts.isPending && <Loading label="Loading the acts…" />}
        {acts.isError && <ErrorState error={acts.error} onRetry={() => void acts.refetch()} />}
        {acts.isSuccess && acts.data.items.length === 0 && (
          <EmptyState title="No act texts yet">
            Upload a bare act (IPC, NI Act…) and every matter&apos;s Acts tab can link straight
            to its sections.
          </EmptyState>
        )}
        {acts.isSuccess && acts.data.items.length > 0 && (
          <>
            <ul>
              {acts.data.items.map((document) => (
                <li
                  key={document.metadata?.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
                >
                  <span className="font-medium">{document.spec?.fileName}</span>
                  <span className="text-xs text-ink-muted">{uploadedDay(document)}</span>
                  <span className="ml-auto">
                    <Button onClick={() => openDocument(document.metadata?.id ?? "")}>
                      Read
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <Pagination
              page={actsPage}
              totalCount={Number(acts.data.totalCount)}
              onPage={setActsPage}
            />
          </>
        )}
      </SectionCard>

      <SectionCard title="Citations in the library">
        {shelf.isPending && <Loading label="Loading the shelf…" />}
        {shelf.isError && (
          <ErrorState error={shelf.error} onRetry={() => void shelf.refetch()} />
        )}
        {shelf.isSuccess && shelf.data.items.length === 0 && (
          <EmptyState title="No standalone citations yet">
            Upload a judgment here when it belongs to the firm&apos;s knowledge, not to one
            matter.
          </EmptyState>
        )}
        {shelf.isSuccess && shelf.data.items.length > 0 && (
          <>
            <ul>
              {shelf.data.items.map((document) => (
                <JudgmentRow
                  key={document.metadata?.id}
                  document={document}
                  onRead={() => openDocument(document.metadata?.id ?? "")}
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

      <SectionCard title="Judgments filed on matters">
        {onMatters.isPending && <Loading label="Loading the collection…" />}
        {onMatters.isError && (
          <ErrorState error={onMatters.error} onRetry={() => void onMatters.refetch()} />
        )}
        {onMatters.isSuccess && onMatters.data.items.length === 0 && (
          <EmptyState title="No judgments filed on matters yet" />
        )}
        {onMatters.isSuccess && onMatters.data.items.length > 0 && (
          <>
            <ul>
              {onMatters.data.items.map((document) => (
                <JudgmentRow
                  key={document.metadata?.id}
                  document={document}
                  fileNumber={fileNumberOf(document.spec?.caseId)}
                  onRead={() => undefined}
                />
              ))}
            </ul>
            <Pagination
              page={mattersPage}
              totalCount={Number(onMatters.data.totalCount)}
              onPage={setMattersPage}
            />
          </>
        )}
      </SectionCard>
    </div>
  );
}
