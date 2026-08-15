/**
 * The marks panel (DD-010's consumption surface #2): every mark on the
 * open document — author, date, what was marked, the comment, and
 * jump-to-page — readable without hunting through pages. Append-only
 * like the resource: no edit, no delete, and the panel offers neither.
 *
 * The panel is ALSO where a pending mark becomes real: the draft form
 * renders at the top (comment required — a mark without a comment is
 * not the feature). A panel form instead of an on-page popover is
 * deliberate: it is keyboard-reachable by construction, needs no
 * portal/z-index machinery over the reader, and keeps the page surface
 * for reading. This makes the panel the feature's one a11y surface —
 * drawing has no keyboard path (recorded limitation), consuming and
 * commenting do.
 */

import { useEffect, useState, type FormEvent } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import { FormError, Label, TextArea } from "../../components/Field.js";
import type { MarkRect } from "../../components/marking/rect.js";
import { AnnotationKind } from "../../gen/stigmer/law/documentannotation/v1/documentannotation_pb.js";
import { formatInstant } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import { useAddAnnotation, useDocumentAnnotations } from "./queries.js";

/** A captured-but-uncommented mark, owned by DocumentViewer (it also
 * previews on the page); the panel turns it into the create call. */
export interface MarkDraft {
  readonly page: number;
  readonly kind: "highlight" | "region";
  readonly rects: readonly MarkRect[];
  readonly quotedText: string;
}

export function AnnotationsPanel(props: {
  documentId: string;
  caseId: string;
  draft: MarkDraft | null;
  onDraftDone: () => void;
  onJumpToPage: (page: number) => void;
}) {
  const annotations = useDocumentAnnotations(props.documentId);
  const addAnnotation = useAddAnnotation(props.documentId);
  const roster = useFirmRoster();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | undefined>();

  // A body left half-typed for a previous draft must not leak into a
  // new one; the form's autoFocus puts the caret in the comment box the
  // moment a capture creates it (writing the comment IS the next act).
  const { draft } = props;
  useEffect(() => {
    setBody("");
    setError(undefined);
  }, [draft]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setError(undefined);
    try {
      await addAnnotation.mutateAsync({
        caseId: props.caseId,
        page: draft.page,
        annotationKind:
          draft.kind === "highlight" ? AnnotationKind.HIGHLIGHT : AnnotationKind.REGION,
        rects: draft.rects.map((rect) => ({ ...rect })),
        quotedText: draft.quotedText,
        body: body.trim(),
      });
      props.onDraftDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <section aria-label="Marks" className="flex min-h-0 flex-col">
      <h2 className="mb-2 shrink-0 text-sm font-semibold">Marks</h2>

      {draft && (
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="mb-3 shrink-0 rounded-card border border-line bg-surface p-3"
        >
          <p className="mb-1 text-xs font-medium">
            New mark — page {draft.page}
            {draft.kind === "region" && " (marked region)"}
          </p>
          {draft.quotedText && (
            <p className="mb-2 border-l-2 border-warn pl-2 text-xs italic text-ink-muted">
              {draft.quotedText}
            </p>
          )}
          <Label htmlFor="mark-comment">Comment</Label>
          <TextArea
            id="mark-comment"
            autoFocus
            required
            maxLength={2000}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <FormError message={error} />
          <div className="mt-1 flex gap-2">
            <Button type="submit" variant="primary" disabled={addAnnotation.isPending}>
              {addAnnotation.isPending ? "Saving…" : "Save mark"}
            </Button>
            <Button onClick={props.onDraftDone}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {annotations.isPending && <Loading label="Loading marks…" />}
        {annotations.isError && (
          <ErrorState error={annotations.error} onRetry={() => void annotations.refetch()} />
        )}
        {annotations.isSuccess && annotations.data.items.length === 0 && !draft && (
          <EmptyState title="No marks yet">
            Select text or use “Mark region” to flag a section and leave a comment for the
            case team.
          </EmptyState>
        )}
        {annotations.isSuccess && annotations.data.items.length > 0 && (
          <ul className="rounded-card border border-line bg-surface">
            {annotations.data.items.map((mark) => {
              const createdAt = mark.metadata?.createdAt;
              return (
                <li
                  key={mark.metadata?.id}
                  className="border-b border-line px-3 py-2 last:border-b-0"
                >
                  <p className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">
                      {/* Audit fields carry USER ids; the roster maps them. */}
                      {roster.data?.nameOfUser(mark.metadata?.createdBy?.id ?? "") ?? "…"}
                    </span>
                    {createdAt && <> — {formatInstant(timestampDate(createdAt))}</>}
                  </p>
                  {mark.spec?.quotedText ? (
                    <p className="mt-1 border-l-2 border-warn pl-2 text-xs italic text-ink-muted">
                      {mark.spec.quotedText}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-ink-faint">Marked region</p>
                  )}
                  <p className="mt-1 whitespace-pre-wrap">{mark.spec?.body}</p>
                  <Button onClick={() => props.onJumpToPage(mark.spec?.page ?? 1)}>
                    Page {mark.spec?.page} →
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
