/**
 * Case notes (FR-CASE-006): append-only running record, newest first BY
 * CONTRACT — no edit, no delete, and the screen offers neither. Author
 * and time come from the envelope's audit fields.
 */

import { useState, type FormEvent } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { formatInstant } from "../../lib/format.js";
import { useUserDirectory } from "../users/queries.js";
import { useAddCaseNote, useCaseNotes } from "./queries.js";

export function CaseNotes(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const notes = useCaseNotes(props.caseId, page);
  const addNote = useAddCaseNote(props.caseId);
  const directory = useUserDirectory();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await addNote.mutateAsync(content.trim());
      setContent("");
      setPage(0); // the new note is newest — jump to where it landed
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <section aria-label="Notes" className="mt-6">
      <h2 className="mb-2 font-medium">Notes</h2>

      <form onSubmit={(e) => void onSubmit(e)} className="mb-3">
        <label htmlFor="new-note" className="mb-1 block text-sm font-medium">
          Add a note
        </label>
        <textarea
          id="new-note"
          required
          maxLength={5000}
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="mb-2 block w-full rounded-card border border-line bg-surface px-3 py-2"
        />
        {error && (
          <p role="alert" className="mb-2 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={addNote.isPending}
          className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
        >
          {addNote.isPending ? "Adding…" : "Add note"}
        </button>
      </form>

      {notes.isPending && <Loading label="Loading notes…" />}
      {notes.isError && <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />}
      {notes.isSuccess && notes.data.items.length === 0 && (
        <EmptyState title="No notes yet">
          The running record of this case — newest first.
        </EmptyState>
      )}
      {notes.isSuccess && notes.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {notes.data.items.map((note) => {
              const createdAt = note.metadata?.createdAt;
              return (
                <li key={note.metadata?.id} className="border-b border-line px-3 py-2 last:border-b-0">
                  <p className="text-sm text-ink-muted">
                    <span className="font-medium text-ink">
                      {directory.data?.nameOf(note.metadata?.createdBy?.id ?? "") ?? "…"}
                    </span>
                    {createdAt && <> — {formatInstant(timestampDate(createdAt))}</>}
                  </p>
                  <p className="whitespace-pre-wrap">{note.spec?.content}</p>
                </li>
              );
            })}
          </ul>
          <Pagination page={page} totalCount={Number(notes.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
