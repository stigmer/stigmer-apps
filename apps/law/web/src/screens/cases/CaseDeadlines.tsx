/**
 * A case's deadlines: lawyer-entered dates with their statutory basis
 * in the lawyer's own words (FR-DEAD-003 — the system never computes
 * one), resolved only by explicit human acts. Overdue is the server's
 * fact and renders loud.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import {
  DeadlineState,
  type Deadline,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { deadlineStateLabel, formatCalendarDate } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import {
  DeadlineSpecSchema,
  useCaseDeadlines,
  useCreateDeadline,
  useUpdateDeadlineState,
} from "../deadlines/queries.js";
import { useFirmMember } from "../../session/use-firm-member.js";

const field = "mb-3 block h-11 w-full rounded-card border border-line bg-surface px-3";
const label = "mb-1 block text-sm font-medium";
const primaryButton =
  "h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60";
const quietButton = "h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface";

function AddDeadlineForm(props: { caseId: string; onDone: () => void }) {
  const createDeadline = useCreateDeadline();
  const roster = useFirmRoster();
  const me = useFirmMember();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [basis, setBasis] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState<string | undefined>();

  // The person entering the deadline usually owns it.
  const effectiveOwner = ownerId || me.data?.metadata?.id || "";

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await createDeadline.mutateAsync(
        create(DeadlineSpecSchema, {
          caseId: props.caseId,
          title: title.trim(),
          dueDate,
          statutoryBasis: basis.trim(),
          ownerId: effectiveOwner,
        }),
      );
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="New deadline"
      className="mb-3 rounded-card border border-line bg-surface p-3"
    >
      <label htmlFor="deadline-title" className={label}>
        What must happen
      </label>
      <input
        id="deadline-title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="File written statement"
        className={field}
      />
      <label htmlFor="deadline-due" className={label}>
        Due date
      </label>
      <input
        id="deadline-due"
        type="date"
        required
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        className={field}
      />
      <label htmlFor="deadline-basis" className={label}>
        Where the date comes from{" "}
        <span className="font-normal text-ink-muted">(in your words — nothing is computed)</span>
      </label>
      <input
        id="deadline-basis"
        maxLength={500}
        value={basis}
        onChange={(e) => setBasis(e.target.value)}
        placeholder="O.VIII R.1 — 30 days from summons served 12/08"
        className={field}
      />
      <label htmlFor="deadline-owner" className={label}>
        Owner
      </label>
      <select
        id="deadline-owner"
        required
        value={effectiveOwner}
        onChange={(e) => setOwnerId(e.target.value)}
        className={field}
      >
        {roster.data?.members.map((member) => (
          <option key={member.metadata?.id} value={member.metadata?.id}>
            {member.status?.userName || member.status?.userEmail}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="mb-3 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={createDeadline.isPending} className={primaryButton}>
        {createDeadline.isPending ? "Adding…" : "Add deadline"}
      </button>
    </form>
  );
}

function DeadlineRow(props: { deadline: Deadline; ownerName: string }) {
  const { deadline } = props;
  const updateState = useUpdateDeadlineState();
  const [error, setError] = useState<string | undefined>();
  const state = deadline.status?.state ?? DeadlineState.OPEN;
  const open = state === DeadlineState.OPEN || state === DeadlineState.UNSPECIFIED;

  async function resolve(next: DeadlineState) {
    setError(undefined);
    try {
      await updateState.mutateAsync({ id: deadline.metadata?.id ?? "", state: next });
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{deadline.spec?.title}</span>
        <span
          className={
            deadline.status?.overdue
              ? "rounded-card bg-danger-surface px-2 py-0.5 text-xs font-medium text-danger"
              : "text-sm text-ink-muted"
          }
        >
          {deadline.status?.overdue ? "OVERDUE — was due" : "due"}{" "}
          {formatCalendarDate(deadline.spec?.dueDate ?? "")}
        </span>
        <span className="text-sm text-ink-faint">{props.ownerName}</span>
        {!open && (
          <span className="rounded-card bg-surface px-2 py-0.5 text-xs font-medium text-ink-muted ring-1 ring-line">
            {deadlineStateLabel(state)}
          </span>
        )}
        {open && (
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={() => void resolve(DeadlineState.MET)} className={quietButton}>
              Met
            </button>
            <button
              type="button"
              onClick={() => void resolve(DeadlineState.MISSED)}
              className="h-11 rounded-card px-3 text-sm text-danger hover:bg-danger-surface"
            >
              Missed
            </button>
            <button
              type="button"
              onClick={() => void resolve(DeadlineState.WITHDRAWN)}
              className={quietButton}
            >
              Withdrawn
            </button>
          </span>
        )}
      </div>
      {deadline.spec?.statutoryBasis && (
        <p className="mt-1 text-sm text-ink-muted">{deadline.spec.statutoryBasis}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function CaseDeadlines(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const deadlines = useCaseDeadlines(props.caseId, page);
  const roster = useFirmRoster();

  return (
    <section aria-label="Deadlines" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Deadlines</h2>
        <button type="button" onClick={() => setAdding((v) => !v)} className={quietButton}>
          {adding ? "Close" : "Add deadline"}
        </button>
      </div>
      {adding && <AddDeadlineForm caseId={props.caseId} onDone={() => setAdding(false)} />}

      {deadlines.isPending && <Loading label="Loading deadlines…" />}
      {deadlines.isError && (
        <ErrorState error={deadlines.error} onRetry={() => void deadlines.refetch()} />
      )}
      {deadlines.isSuccess && deadlines.data.items.length === 0 && (
        <EmptyState title="No deadlines on this matter" />
      )}
      {deadlines.isSuccess && deadlines.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {deadlines.data.items.map((deadline) => (
              <DeadlineRow
                key={deadline.metadata?.id}
                deadline={deadline}
                ownerName={roster.data?.nameOf(deadline.spec?.ownerId ?? "") ?? "…"}
              />
            ))}
          </ul>
          <Pagination
            page={page}
            totalCount={Number(deadlines.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
