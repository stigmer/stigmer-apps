/**
 * The matter's citations (DD-012 D2 — the case-first citing flow the
 * library-only entry point inverted): what this matter relies on, and
 * the "Cite a judgment" act in the lawyer's own order — search the
 * firm's shelf, pick the precedent (or put it on the shelf right
 * here), say the proposition, done. The Library screen keeps the
 * reverse view ("Where we used it"); both read the same trail.
 *
 * The shelf search is identity search (title + citation string, the
 * Citation resource) — "find the case I mean", not "find the passage";
 * the passage search lives beside the reader and the assistant.
 * Reading a cited judgment opens the shared viewer IN CASE CONTEXT
 * (?doc= — the T09.2 precedent), so a mark made while reading carries
 * this matter as its badge (the two-layer marks model).
 */

import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import { FormError, InlineInput, Input, Label } from "../../components/Field.js";
import { Pagination } from "../../components/Pagination.js";
import type { Citation } from "../../gen/stigmer/law/citation/v1/citation_pb.js";
import { citationFacts } from "../../lib/format.js";
import { useShelfSearch, useUploadLibraryDocument } from "../library/queries.js";
import { useCaseCitationUses, useCiteJudgment } from "./queries.js";

/** One shelf hit in the citing flow: identity first (the recognition
 * handle), the paper's file name as the small print. */
function ShelfHit(props: { citation: Citation; onPick: () => void; picked: boolean }) {
  const spec = props.citation.spec;
  const facts = citationFacts(spec ?? {});
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0">
      <span className="min-w-0 flex-1 basis-48">
        <span className="block font-medium">{spec?.title}</span>
        <span className="block text-xs text-ink-muted">
          {facts && `${facts} · `}
          {props.citation.status?.documentFileName}
        </span>
      </span>
      <Button variant={props.picked ? "primary" : undefined} onClick={props.onPick}>
        {props.picked ? "Picked" : "Cite this"}
      </Button>
    </li>
  );
}

function CiteFlow(props: { caseId: string; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Citation | undefined>();
  const [proposition, setProposition] = useState("");
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | undefined>();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | undefined>();
  const search = useShelfSearch(query);
  const upload = useUploadLibraryDocument();
  const cite = useCiteJudgment(props.caseId);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      let documentId = picked?.spec?.documentId ?? "";
      if (uploading) {
        if (!file) return;
        // Not on the shelf yet: file it there first (the shelf rule —
        // the trail only ever keys library papers), then cite it.
        const uploaded = await upload.mutateAsync({
          file,
          identity: { title: title.trim() || undefined },
        });
        documentId = uploaded.metadata?.id ?? "";
      }
      if (!documentId) {
        setError("Pick a judgment from the shelf, or upload one.");
        return;
      }
      await cite.mutateAsync({ documentId, proposition: proposition.trim() });
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  const hits = search.data?.items ?? [];
  const pending = upload.isPending || cite.isPending;

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Cite a judgment"
      className="mb-4 rounded-card border border-line bg-surface p-3"
    >
      {!uploading && (
        <>
          <Label htmlFor="cite-search">Find it on the firm&apos;s shelf</Label>
          <InlineInput
            id="cite-search"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked(undefined);
            }}
            placeholder="Case name or citation, e.g. 'Arnesh' or 'AIR 2014'"
            className="mb-2 block w-full"
          />
          {query.trim().length >= 1 && (
            <>
              {search.isPending && <Loading label="Searching the shelf…" />}
              {search.isError && (
                <ErrorState error={search.error} onRetry={() => void search.refetch()} />
              )}
              {search.isSuccess && hits.length === 0 && (
                <p className="mb-2 text-sm text-ink-muted">
                  Nothing on the shelf matches — upload the judgment below and it becomes
                  part of the firm&apos;s library.
                </p>
              )}
              {hits.length > 0 && (
                <ul aria-label="Shelf matches" className="mb-2 rounded-card border border-line">
                  {hits.map((citation) => (
                    <ShelfHit
                      key={citation.metadata?.id}
                      citation={citation}
                      picked={picked?.metadata?.id === citation.metadata?.id}
                      onPick={() => setPicked(citation)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
          <Button onClick={() => setUploading(true)}>Not on the shelf — upload it</Button>
        </>
      )}

      {uploading && (
        <>
          <Label htmlFor="cite-file">The judgment (PDF, PNG, or JPG — up to 25 MB)</Label>
          <input
            id="cite-file"
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            className="mb-2 block text-sm"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
          <Label htmlFor="cite-title">Case name (as the firm cites it)</Label>
          <Input
            id="cite-title"
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Arnesh Kumar vs State of Bihar"
          />
          <Button onClick={() => setUploading(false)}>Back to the shelf search</Button>
        </>
      )}

      <Label htmlFor="cite-proposition">For what proposition</Label>
      <Input
        id="cite-proposition"
        required
        maxLength={500}
        value={proposition}
        onChange={(e) => setProposition(e.target.value)}
        placeholder="bail where the offence carries under seven years"
      />
      <FormError message={error} />
      <div className="mt-1 flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Recording…" : "Record the citation"}
        </Button>
        <Button onClick={props.onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function CaseCitations(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [citing, setCiting] = useState(false);
  const uses = useCaseCitationUses(props.caseId, page);
  const [, setSearchParams] = useSearchParams();

  function onRead(documentId: string) {
    // PUSH like the Documents tab's View; the viewer opens in THIS
    // case's context, so marks made while reading carry the matter.
    setSearchParams((params) => {
      params.set("doc", documentId);
      return params;
    });
  }

  return (
    <section aria-label="Citations" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Citations</h2>
        <Button variant="primary" onClick={() => setCiting((v) => !v)}>
          {citing ? "Close" : "Cite a judgment"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        The precedents this matter relies on, each with its proposition. The judgments
        themselves live on the firm&apos;s shelf (the Library) — a judgment filed on this
        matter joins the shelf through &ldquo;Add to library&rdquo; on the Documents tab.
      </p>

      {citing && <CiteFlow caseId={props.caseId} onDone={() => setCiting(false)} />}

      {uses.isPending && <Loading label="Loading the citations…" />}
      {uses.isError && <ErrorState error={uses.error} onRetry={() => void uses.refetch()} />}
      {uses.isSuccess && uses.data.items.length === 0 && !citing && (
        <EmptyState title="Nothing cited yet">
          When a judgment carries an argument in this matter, record it here — the trail
          is how the next person knows what worked.
        </EmptyState>
      )}
      {uses.isSuccess && uses.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {uses.data.items.map((use) => (
              <li
                key={use.metadata?.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium">{use.status?.documentFileName}</span>
                  <span className="block text-sm text-ink-muted">
                    {use.spec?.proposition}
                  </span>
                </span>
                <Button onClick={() => onRead(use.spec?.documentId ?? "")}>Read</Button>
              </li>
            ))}
          </ul>
          <Pagination
            page={page}
            totalCount={Number(uses.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
