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
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { FormError, Input, Label, Select } from "../../components/Field.js";
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
      <Label htmlFor="deadline-title">What must happen</Label>
      <Input
        id="deadline-title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="File written statement"
      />
      <Label htmlFor="deadline-due">Due date</Label>
      <Input
        id="deadline-due"
        type="date"
        required
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
      />
      <Label htmlFor="deadline-basis">
        Where the date comes from{" "}
        <span className="font-normal text-ink-muted">(in your words — nothing is computed)</span>
      </Label>
      <Input
        id="deadline-basis"
        maxLength={500}
        value={basis}
        onChange={(e) => setBasis(e.target.value)}
        placeholder="O.VIII R.1 — 30 days from summons served 12/08"
      />
      <Label htmlFor="deadline-owner">Owner</Label>
      <Select
        id="deadline-owner"
        required
        value={effectiveOwner}
        onChange={(e) => setOwnerId(e.target.value)}
      >
        {roster.data?.members.map((member) => (
          <option key={member.metadata?.id} value={member.metadata?.id}>
            {member.status?.userName || member.status?.userEmail}
          </option>
        ))}
      </Select>
      <FormError message={error} />
      <Button type="submit" variant="primary" disabled={createDeadline.isPending}>
        {createDeadline.isPending ? "Adding…" : "Add deadline"}
      </Button>
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
        {deadline.status?.overdue ? (
          <Badge tone="danger">
            OVERDUE — was due {formatCalendarDate(deadline.spec?.dueDate ?? "")}
          </Badge>
        ) : (
          <span className="text-xs text-ink-muted">
            due {formatCalendarDate(deadline.spec?.dueDate ?? "")}
          </span>
        )}
        <span className="text-xs text-ink-faint">{props.ownerName}</span>
        {!open && (
          <span className="rounded-card bg-surface px-2 py-0.5 text-xs font-medium text-ink-muted ring-1 ring-line">
            {deadlineStateLabel(state)}
          </span>
        )}
        {open && (
          <span className="ml-auto flex gap-1">
            <Button onClick={() => void resolve(DeadlineState.MET)}>Met</Button>
            <Button variant="danger" onClick={() => void resolve(DeadlineState.MISSED)}>
              Missed
            </Button>
            <Button onClick={() => void resolve(DeadlineState.WITHDRAWN)}>Withdrawn</Button>
          </span>
        )}
      </div>
      {deadline.spec?.statutoryBasis && (
        <p className="mt-1 text-xs text-ink-muted">{deadline.spec.statutoryBasis}</p>
      )}
      {error && (
        <div className="mt-1">
          <FormError message={error} />
        </div>
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
        <h2 className="text-sm font-semibold">Deadlines</h2>
        <Button onClick={() => setAdding((v) => !v)}>
          {adding ? "Close" : "Add deadline"}
        </Button>
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
