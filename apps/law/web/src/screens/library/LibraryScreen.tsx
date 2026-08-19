/**
 * The Library (FR-CIT-002): the firm's judgment collection — the pile
 * that compounds (FR-DOC-002's hook, now a screen) — with each
 * judgment's reliance trail beside it: where the firm used it and for
 * what proposition. Judgments enter the library the same way every
 * paper does (filed on a matter with category "judgment", in the app
 * or over WhatsApp); this screen is where they are FOUND again.
 *
 * Reading a judgment opens the owning matter's viewer — a document
 * always belongs to its case (visibility included); the library is a
 * lens, not a second store.
 */

import { useState, type FormEvent } from "react";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button, ButtonLink } from "../../components/Button.js";
import { FormError, Input, Label, Select } from "../../components/Field.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Pagination } from "../../components/Pagination.js";
import { SectionCard } from "../../components/SectionCard.js";
import type { Document } from "../../gen/stigmer/law/document/v1/document_pb.js";
import { formatCalendarDate } from "../../lib/format.js";
import { useCaseList, useCaseSummaryMap } from "../cases/queries.js";
import {
  useCitationUsesByDocument,
  useJudgmentCollection,
  useRecordCitationUse,
} from "./queries.js";

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

function JudgmentRow(props: { document: Document; fileNumber: string }) {
  const { document } = props;
  const id = document.metadata?.id ?? "";
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  // The trail loads only when the row opens — a hundred judgments must
  // not mean a hundred queries on screen entry.
  const uses = useCitationUsesByDocument(id, open);
  const uploadedSeconds = document.metadata?.createdAt?.seconds;
  const uploaded = uploadedSeconds
    ? formatCalendarDate(new Date(Number(uploadedSeconds) * 1000).toISOString().slice(0, 10))
    : "";

  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{document.spec?.fileName}</span>
        <span className="text-xs text-ink-muted">
          filed on {props.fileNumber}
          {uploaded && `, ${uploaded}`}
        </span>
        <span className="ml-auto flex gap-1">
          <ButtonLink to={`/cases/${document.spec?.caseId}?tab=Documents&doc=${id}`}>
            Read
          </ButtonLink>
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
  const [page, setPage] = useState(0);
  const judgments = useJudgmentCollection(page);
  const summaries = useCaseSummaryMap();
  const fileNumberOf = (caseId: string | undefined) =>
    summaries.data?.get(caseId ?? "")?.fileNumber ?? "…";

  return (
    <div className="grid gap-4">
      <PageHeader title="Library" />
      <p className="-mt-2 text-sm text-ink-muted">
        The firm&apos;s judgment collection — every judgment filed anywhere in the practice,
        with where it has been used and for what. Ask the assistant to search inside them.
      </p>

      <SectionCard title="Judgments on file">
        {judgments.isPending && <Loading label="Loading the library…" />}
        {judgments.isError && (
          <ErrorState error={judgments.error} onRetry={() => void judgments.refetch()} />
        )}
        {judgments.isSuccess && judgments.data.items.length === 0 && (
          <EmptyState title="No judgments filed yet">
            File a judgment on any matter (category &ldquo;judgment&rdquo;) and it appears here
            for the whole firm.
          </EmptyState>
        )}
        {judgments.isSuccess && judgments.data.items.length > 0 && (
          <>
            <ul>
              {judgments.data.items.map((document) => (
                <JudgmentRow
                  key={document.metadata?.id}
                  document={document}
                  fileNumber={fileNumberOf(document.spec?.caseId)}
                />
              ))}
            </ul>
            <Pagination
              page={page}
              totalCount={Number(judgments.data.totalCount)}
              onPage={setPage}
            />
          </>
        )}
      </SectionCard>
    </div>
  );
}
