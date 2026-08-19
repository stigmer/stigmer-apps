/**
 * The matter's statutory frame (FR-ACT-001): which Acts and sections
 * apply, entered MANUALLY by the team — the firm's own rule, and the
 * FR-DEAD-003 boundary extended: nothing here computes a consequence
 * from an act. Reads as a register (act name ascending, the server's
 * order); corrections are edits in place — there is no delete
 * (session-27 corrections model), so the row's edit form is the whole
 * story.
 *
 * Sections are typed comma-separated and stored as a list — the FIR's
 * own reading order ("420, 468, 471"), one input on a phone-width
 * screen instead of a row of fiddly chips.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import { FormError, Input, Label } from "../../components/Field.js";
import { Pagination } from "../../components/Pagination.js";
import {
  type CaseAct,
  CaseActSpecSchema,
} from "../../gen/stigmer/law/caseact/v1/caseact_pb.js";
import { useAddCaseAct, useCaseActs, useUpdateCaseAct } from "./queries.js";

/** "420, 468, 34 r/w 120B" → ["420", "468", "34 r/w 120B"]. */
function parseSections(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ActForm(props: {
  caseId: string;
  existing?: CaseAct;
  onDone: () => void;
}) {
  const add = useAddCaseAct(props.caseId);
  const update = useUpdateCaseAct(props.caseId);
  const [act, setAct] = useState(props.existing?.spec?.act ?? "");
  const [sections, setSections] = useState(props.existing?.spec?.sections.join(", ") ?? "");
  const [note, setNote] = useState(props.existing?.spec?.note ?? "");
  const [error, setError] = useState<string | undefined>();
  const pending = add.isPending || update.isPending;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      if (props.existing) {
        await update.mutateAsync({
          existing: props.existing,
          spec: create(CaseActSpecSchema, {
            caseId: props.caseId,
            act: act.trim(),
            sections: parseSections(sections),
            note: note.trim(),
          }),
        });
      } else {
        await add.mutateAsync({
          act: act.trim(),
          sections: parseSections(sections),
          note: note.trim(),
        });
      }
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label={props.existing ? `Edit ${props.existing.spec?.act}` : "Add an act"}
      className="mb-3 rounded-card border border-line bg-surface p-3"
    >
      <Label htmlFor="act-name">Act</Label>
      <Input
        id="act-name"
        required
        maxLength={200}
        value={act}
        onChange={(e) => setAct(e.target.value)}
        placeholder="IPC"
      />
      <Label htmlFor="act-sections">
        Sections <span className="font-normal text-ink-muted">(comma-separated)</span>
      </Label>
      <Input
        id="act-sections"
        value={sections}
        onChange={(e) => setSections(e.target.value)}
        placeholder="420, 468, 34 r/w 120B"
      />
      <Label htmlFor="act-note">
        Note <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input
        id="act-note"
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="the fraud counts"
      />
      <FormError message={error} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : props.existing ? "Save changes" : "Add act"}
      </Button>
    </form>
  );
}

function ActRow(props: { caseId: string; act: CaseAct }) {
  const [editing, setEditing] = useState(false);
  const { act } = props;
  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{act.spec?.act}</span>
        {(act.spec?.sections.length ?? 0) > 0 && (
          <span className="text-xs text-ink-muted">{act.spec?.sections.join(", ")}</span>
        )}
        <span className="ml-auto">
          <Button onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</Button>
        </span>
      </div>
      {act.spec?.note && <p className="mt-1 text-xs text-ink-muted">{act.spec.note}</p>}
      {editing && (
        <div className="mt-2">
          <ActForm caseId={props.caseId} existing={act} onDone={() => setEditing(false)} />
        </div>
      )}
    </li>
  );
}

export function CaseActs(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const acts = useCaseActs(props.caseId, page);

  return (
    <section aria-label="Acts" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Acts &amp; sections</h2>
        <Button onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "Add act"}</Button>
      </div>
      <p className="mb-2 text-xs text-ink-muted">
        The statutory frame is entered by the team — nothing here is computed or suggested.
      </p>
      {adding && <ActForm caseId={props.caseId} onDone={() => setAdding(false)} />}

      {acts.isPending && <Loading label="Loading the frame…" />}
      {acts.isError && <ErrorState error={acts.error} onRetry={() => void acts.refetch()} />}
      {acts.isSuccess && acts.data.items.length === 0 && (
        <EmptyState title="No acts entered yet">
          Add the acts and sections from the FIR or the plaint — the frame grows from there.
        </EmptyState>
      )}
      {acts.isSuccess && acts.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {acts.data.items.map((act) => (
              <ActRow key={act.metadata?.id} caseId={props.caseId} act={act} />
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(acts.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
