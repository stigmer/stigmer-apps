/**
 * The case diary (journey J6) and the capture moment (J3): the dated
 * stream of hearings, newest first, with the record-outcome flow inline
 * where the scheduled hearing sits — post-court capture must be one
 * screen and under thirty seconds, not a navigation exercise.
 *
 * Completed hearings render read-only (the server freezes them; the UI
 * never offers the dead end). Recording a next date auto-schedules the
 * next hearing — the confirmation says so, because that is the moment
 * the diary teaches how it works.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import {
  OutcomeKind,
  type Hearing,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { formatCalendarDate, outcomeKindLabel } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import {
  HearingSpecSchema,
  useCaseDiary,
  useRecordOutcome,
  useScheduleHearing,
  useUpdateHearing,
} from "../hearings/queries.js";

const OUTCOME_CHOICES: readonly OutcomeKind[] = [
  OutcomeKind.ADJOURNED,
  OutcomeKind.HEARD,
  OutcomeKind.ORDERS_RESERVED,
  OutcomeKind.ORDER_PRONOUNCED,
  OutcomeKind.NOT_LISTED,
  OutcomeKind.NOT_REACHED,
  OutcomeKind.OTHER,
];

const field = "mb-3 block h-11 w-full rounded-card border border-line bg-surface px-3";
const label = "mb-1 block text-sm font-medium";
const primaryButton =
  "h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60";
const quietButton = "h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface";

function isScheduled(hearing: Hearing): boolean {
  return (hearing.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED) === OutcomeKind.UNSPECIFIED;
}

/** The J3 form: what happened, and the next date if the court gave one. */
function RecordOutcomeForm(props: { hearing: Hearing; onDone: (message: string) => void }) {
  const recordOutcome = useRecordOutcome();
  const roster = useFirmRoster();
  const [outcome, setOutcome] = useState<OutcomeKind>(OutcomeKind.UNSPECIFIED);
  const [notes, setNotes] = useState("");
  const [attendedBy, setAttendedBy] = useState<readonly string[]>([]);
  const [nextDate, setNextDate] = useState("");
  const [nextPurpose, setNextPurpose] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const result = await recordOutcome.mutateAsync({
        id: props.hearing.metadata?.id ?? "",
        outcomeKind: outcome,
        outcomeNotes: notes.trim(),
        attendedBy: [...attendedBy],
        nextDate: nextDate || undefined,
        nextPurpose: nextDate ? nextPurpose.trim() || undefined : undefined,
      });
      props.onDone(
        result.nextHearing
          ? `Recorded. Next hearing scheduled for ${formatCalendarDate(
              result.nextHearing.spec?.date ?? "",
            )}.`
          : "Recorded. No next date given — this matter now shows under “no next date” until one is scheduled.",
      );
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  function toggleAttendee(memberId: string) {
    setAttendedBy((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    );
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label={`Record outcome for the hearing on ${formatCalendarDate(props.hearing.spec?.date ?? "")}`}
      className="mt-2 rounded-card border border-brand bg-brand-surface p-3"
    >
      <label htmlFor="outcome-kind" className={label}>
        What happened
      </label>
      <select
        id="outcome-kind"
        required
        value={outcome}
        onChange={(e) => setOutcome(Number(e.target.value) as OutcomeKind)}
        className={field}
      >
        <option value={OutcomeKind.UNSPECIFIED} disabled>
          Pick the outcome
        </option>
        {OUTCOME_CHOICES.map((kind) => (
          <option key={kind} value={kind}>
            {outcomeKindLabel(kind)}
          </option>
        ))}
      </select>

      <label htmlFor="outcome-notes" className={label}>
        Notes <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <textarea
        id="outcome-notes"
        rows={2}
        maxLength={5000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="mb-3 block w-full rounded-card border border-line bg-surface px-3 py-2"
      />

      <fieldset className="mb-3">
        <legend className={label}>Who appeared</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {roster.data?.members.map((member) => (
            <label key={member.metadata?.id} className="flex h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={attendedBy.includes(member.metadata?.id ?? "")}
                onChange={() => toggleAttendee(member.metadata?.id ?? "")}
              />
              {member.status?.userName || member.status?.userEmail}
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor="outcome-next-date" className={label}>
        Next date <span className="font-normal text-ink-muted">(if the court gave one — scheduling happens automatically)</span>
      </label>
      <input
        id="outcome-next-date"
        type="date"
        value={nextDate}
        onChange={(e) => setNextDate(e.target.value)}
        className={field}
      />

      {nextDate && (
        <>
          <label htmlFor="outcome-next-purpose" className={label}>
            Listed for
          </label>
          <input
            id="outcome-next-purpose"
            value={nextPurpose}
            onChange={(e) => setNextPurpose(e.target.value)}
            placeholder="evidence, arguments…"
            className={field}
          />
        </>
      )}

      <p className="mb-3 text-sm text-ink-muted">
        A recorded outcome is permanent — check the details before saving.
      </p>
      {error && (
        <p role="alert" className="mb-3 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={recordOutcome.isPending} className={primaryButton}>
        {recordOutcome.isPending ? "Recording…" : "Record outcome"}
      </button>
    </form>
  );
}

/** The clerk's evening capture (J2, FR-HEAR-006): serial number + hall. */
function ListingDetailsForm(props: { hearing: Hearing; onDone: () => void }) {
  const updateHearing = useUpdateHearing();
  const [serial, setSerial] = useState(props.hearing.spec?.listSerialNumber ?? "");
  const [hall, setHall] = useState(props.hearing.spec?.courtHall ?? "");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const spec = props.hearing.spec;
    if (!spec) return;
    try {
      await updateHearing.mutateAsync({
        existing: props.hearing,
        spec: create(HearingSpecSchema, {
          caseId: spec.caseId,
          date: spec.date,
          purpose: spec.purpose,
          listSerialNumber: serial.trim() || undefined,
          courtHall: hall.trim() || undefined,
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
      aria-label="Cause-list details"
      className="mt-2 flex flex-wrap items-end gap-2 rounded-card border border-line p-3"
    >
      <div>
        <label htmlFor="listing-serial" className={label}>
          List item no.
        </label>
        <input
          id="listing-serial"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          placeholder="47"
          className="block h-11 w-28 rounded-card border border-line bg-surface px-3"
        />
      </div>
      <div>
        <label htmlFor="listing-hall" className={label}>
          Court hall
        </label>
        <input
          id="listing-hall"
          value={hall}
          onChange={(e) => setHall(e.target.value)}
          placeholder="3"
          className="block h-11 w-28 rounded-card border border-line bg-surface px-3"
        />
      </div>
      <button type="submit" disabled={updateHearing.isPending} className={primaryButton}>
        {updateHearing.isPending ? "Saving…" : "Save"}
      </button>
      {error && (
        <p role="alert" className="w-full rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function ScheduleHearingForm(props: { caseId: string; onDone: () => void }) {
  const schedule = useScheduleHearing();
  const [date, setDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await schedule.mutateAsync(
        create(HearingSpecSchema, { caseId: props.caseId, date, purpose: purpose.trim() }),
      );
      props.onDone();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Schedule a hearing"
      className="mb-3 flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface p-3"
    >
      <div>
        <label htmlFor="hearing-date" className={label}>
          Date
        </label>
        <input
          id="hearing-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="block h-11 rounded-card border border-line bg-surface px-3"
        />
      </div>
      <div className="min-w-48 flex-1">
        <label htmlFor="hearing-purpose" className={label}>
          Listed for
        </label>
        <input
          id="hearing-purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="filing, evidence, arguments…"
          className="block h-11 w-full rounded-card border border-line bg-surface px-3"
        />
      </div>
      <button type="submit" disabled={schedule.isPending} className={primaryButton}>
        {schedule.isPending ? "Scheduling…" : "Schedule"}
      </button>
      {error && (
        <p role="alert" className="w-full rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function DiaryEntry(props: { hearing: Hearing; rosterName: (id: string) => string }) {
  const { hearing } = props;
  const [recording, setRecording] = useState(false);
  const [editingListing, setEditingListing] = useState(false);
  const [confirmation, setConfirmation] = useState<string | undefined>();

  const scheduled = isScheduled(hearing);
  const listing = [
    hearing.spec?.listSerialNumber && `item ${hearing.spec.listSerialNumber}`,
    hearing.spec?.courtHall && `hall ${hearing.spec.courtHall}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li className="border-b border-line px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{formatCalendarDate(hearing.spec?.date ?? "")}</span>
        {hearing.spec?.purpose && (
          <span className="text-sm text-ink-muted">for {hearing.spec.purpose}</span>
        )}
        {listing && <span className="text-sm text-ink-faint">({listing})</span>}
        <span
          className={
            scheduled
              ? "rounded-card bg-brand-surface px-2 py-0.5 text-xs font-medium text-brand"
              : "rounded-card bg-surface px-2 py-0.5 text-xs font-medium text-ink-muted ring-1 ring-line"
          }
        >
          {outcomeKindLabel(hearing.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED)}
        </span>
        {scheduled && (
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={() => setRecording((v) => !v)} className={quietButton}>
              {recording ? "Close" : "Record outcome"}
            </button>
            <button
              type="button"
              onClick={() => setEditingListing((v) => !v)}
              className={quietButton}
            >
              {editingListing ? "Close" : "Cause-list details"}
            </button>
          </span>
        )}
      </div>

      {!scheduled && (
        <div className="mt-1 text-sm text-ink-muted">
          {hearing.status?.outcomeNotes && (
            <p className="whitespace-pre-wrap">{hearing.status.outcomeNotes}</p>
          )}
          {(hearing.status?.attendedBy.length ?? 0) > 0 && (
            <p>
              Appeared: {hearing.status?.attendedBy.map((id) => props.rosterName(id)).join(", ")}
            </p>
          )}
          {hearing.status?.nextDate && (
            <p>Next date given: {formatCalendarDate(hearing.status.nextDate)}</p>
          )}
        </div>
      )}

      {confirmation && (
        <p role="status" className="mt-2 rounded-card bg-ok/10 px-3 py-2 text-sm text-ok">
          {confirmation}
        </p>
      )}
      {recording && scheduled && (
        <RecordOutcomeForm
          hearing={hearing}
          onDone={(message) => {
            setRecording(false);
            setConfirmation(message);
          }}
        />
      )}
      {editingListing && scheduled && (
        <ListingDetailsForm hearing={hearing} onDone={() => setEditingListing(false)} />
      )}
    </li>
  );
}

export function CaseDiary(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const [scheduling, setScheduling] = useState(false);
  const diary = useCaseDiary(props.caseId, page);
  const roster = useFirmRoster();

  return (
    <section aria-label="Diary" className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">Diary</h2>
        <button type="button" onClick={() => setScheduling((v) => !v)} className={quietButton}>
          {scheduling ? "Close" : "Schedule a hearing"}
        </button>
      </div>
      {scheduling && (
        <ScheduleHearingForm caseId={props.caseId} onDone={() => setScheduling(false)} />
      )}

      {diary.isPending && <Loading label="Loading the diary…" />}
      {diary.isError && <ErrorState error={diary.error} onRetry={() => void diary.refetch()} />}
      {diary.isSuccess && diary.data.items.length === 0 && (
        <EmptyState title="No hearings yet">
          Schedule the first hearing — the diary grows from there.
        </EmptyState>
      )}
      {diary.isSuccess && diary.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {diary.data.items.map((hearing) => (
              <DiaryEntry
                key={hearing.metadata?.id}
                hearing={hearing}
                rosterName={(id) => roster.data?.nameOf(id) ?? id}
              />
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(diary.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
