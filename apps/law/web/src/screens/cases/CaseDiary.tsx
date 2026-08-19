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
import { Button } from "../../components/Button.js";
import {
  FormError,
  InlineInput,
  Input,
  Label,
  Select,
  TextArea,
} from "../../components/Field.js";
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
import { DeadlineSpecSchema, useCreateDeadline } from "../deadlines/queries.js";
import { TaskSpecSchema, useCreateTask } from "../tasks/queries.js";

const OUTCOME_CHOICES: readonly OutcomeKind[] = [
  OutcomeKind.ADJOURNED,
  OutcomeKind.HEARD,
  OutcomeKind.ORDERS_RESERVED,
  OutcomeKind.ORDER_PRONOUNCED,
  OutcomeKind.NOT_LISTED,
  OutcomeKind.NOT_REACHED,
  OutcomeKind.OTHER,
];

function isScheduled(hearing: Hearing): boolean {
  return (hearing.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED) === OutcomeKind.UNSPECIFIED;
}

/** The J3 form: what happened, and the next date if the court gave one. */
function RecordOutcomeForm(props: {
  hearing: Hearing;
  onDone: (message: string, nextDate?: string) => void;
}) {
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
        result.nextHearing?.spec?.date,
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
      <Label htmlFor="outcome-kind">What happened</Label>
      <Select
        id="outcome-kind"
        required
        value={outcome}
        onChange={(e) => setOutcome(Number(e.target.value) as OutcomeKind)}
      >
        <option value={OutcomeKind.UNSPECIFIED} disabled>
          Pick the outcome
        </option>
        {OUTCOME_CHOICES.map((kind) => (
          <option key={kind} value={kind}>
            {outcomeKindLabel(kind)}
          </option>
        ))}
      </Select>

      <Label htmlFor="outcome-notes">
        Notes <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <TextArea
        id="outcome-notes"
        rows={2}
        maxLength={5000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <fieldset className="mb-3">
        <legend className="mb-1 text-sm font-medium">Who appeared</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {roster.data?.members.map((member) => (
            <label key={member.metadata?.id} className="flex h-8 items-center gap-2 text-sm">
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

      <Label htmlFor="outcome-next-date">
        Next date{" "}
        <span className="font-normal text-ink-muted">
          (if the court gave one — scheduling happens automatically)
        </span>
      </Label>
      <Input
        id="outcome-next-date"
        type="date"
        value={nextDate}
        onChange={(e) => setNextDate(e.target.value)}
      />

      {nextDate && (
        <>
          <Label htmlFor="outcome-next-purpose">Listed for</Label>
          <Input
            id="outcome-next-purpose"
            value={nextPurpose}
            onChange={(e) => setNextPurpose(e.target.value)}
            placeholder="evidence, arguments…"
          />
        </>
      )}

      <p className="mb-3 text-xs text-ink-muted">
        A recorded outcome is permanent — check the details before saving.
      </p>
      <FormError message={error} />
      <Button type="submit" variant="primary" disabled={recordOutcome.isPending}>
        {recordOutcome.isPending ? "Recording…" : "Record outcome"}
      </Button>
    </form>
  );
}

/**
 * Capture at the source (FR-HEAR-007): the follow-up work an outcome
 * implies — "file written statement by the 29th" — created in the same
 * motion as the outcome itself, so the gap between "the court said"
 * and "someone owns it" never opens. Repeatable on purpose: one
 * appearance routinely produces several follow-ups. Rides the existing
 * Task/Deadline create contracts; assignment here is optional — an
 * unassigned task lands on the home screen's pickup list (FR-TASK-002).
 */
function FollowUpForms(props: { caseId: string; nextDate?: string }) {
  const createTask = useCreateTask();
  const createDeadline = useCreateDeadline();
  const roster = useFirmRoster();
  const [mode, setMode] = useState<"none" | "task" | "deadline">("none");
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [personId, setPersonId] = useState("");
  const [basis, setBasis] = useState("");
  const [created, setCreated] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | undefined>();

  function reset(nextMode: "none" | "task" | "deadline") {
    setMode(nextMode);
    setTitle("");
    // The next hearing date is the natural first guess for when
    // follow-up work must be done by; the person edits it when the
    // court said otherwise.
    setDueDate(props.nextDate ?? "");
    setPersonId("");
    setBasis("");
    setError(undefined);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      if (mode === "task") {
        await createTask.mutateAsync(
          create(TaskSpecSchema, {
            caseId: props.caseId,
            title: title.trim(),
            assigneeId: personId || undefined,
            dueDate: dueDate || undefined,
          }),
        );
        setCreated((lines) => [
          ...lines,
          `Task “${title.trim()}” ${personId ? "assigned" : "created — waiting for an owner"}.`,
        ]);
      } else {
        await createDeadline.mutateAsync(
          create(DeadlineSpecSchema, {
            caseId: props.caseId,
            title: title.trim(),
            dueDate,
            statutoryBasis: basis.trim(),
            ownerId: personId,
          }),
        );
        setCreated((lines) => [...lines, `Deadline “${title.trim()}” on the book.`]);
      }
      reset("none");
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  const pending = createTask.isPending || createDeadline.isPending;

  return (
    <div className="mt-2 rounded-card border border-line bg-surface p-3">
      {created.map((line) => (
        <p key={line} role="status" className="mb-1 text-sm text-ok">
          {line}
        </p>
      ))}
      <p className="mb-2 text-xs text-ink-muted">
        Anything to do before the next date? Capture it now so it reaches the board.
      </p>
      <div className="flex gap-1">
        <Button onClick={() => reset(mode === "task" ? "none" : "task")}>
          {mode === "task" ? "Close" : "Add a follow-up task"}
        </Button>
        <Button onClick={() => reset(mode === "deadline" ? "none" : "deadline")}>
          {mode === "deadline" ? "Close" : "Add a deadline"}
        </Button>
      </div>

      {mode !== "none" && (
        <form
          onSubmit={(e) => void onSubmit(e)}
          aria-label={mode === "task" ? "Add a follow-up task" : "Add a deadline"}
          className="mt-3"
        >
          <Label htmlFor="follow-up-title">
            {mode === "task" ? "What has to be done" : "What must happen"}
          </Label>
          <Input
            id="follow-up-title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={mode === "task" ? "Prepare evidence affidavit" : "File written statement"}
          />

          <Label htmlFor="follow-up-due">
            {mode === "task" ? (
              <>
                Due date <span className="font-normal text-ink-muted">(optional)</span>
              </>
            ) : (
              "Due date"
            )}
          </Label>
          <Input
            id="follow-up-due"
            type="date"
            required={mode === "deadline"}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />

          {mode === "deadline" && (
            <>
              <Label htmlFor="follow-up-basis">
                Where the date comes from{" "}
                <span className="font-normal text-ink-muted">(optional)</span>
              </Label>
              <Input
                id="follow-up-basis"
                maxLength={500}
                value={basis}
                onChange={(e) => setBasis(e.target.value)}
                placeholder="O.VIII R.1 — 30 days from summons"
              />
            </>
          )}

          <Label htmlFor="follow-up-person">
            {mode === "task" ? (
              <>
                Assign to{" "}
                <span className="font-normal text-ink-muted">
                  (leave empty — it shows as waiting for an owner)
                </span>
              </>
            ) : (
              "Answerable"
            )}
          </Label>
          <Select
            id="follow-up-person"
            required={mode === "deadline"}
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
          >
            <option value="">{mode === "task" ? "Nobody yet" : "Pick a person"}</option>
            {roster.data?.members.map((member) => (
              <option key={member.metadata?.id} value={member.metadata?.id}>
                {member.status?.userName || member.status?.userEmail}
              </option>
            ))}
          </Select>

          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : mode === "task" ? "Add task" : "Add deadline"}
          </Button>
        </form>
      )}
    </div>
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
        <Label htmlFor="listing-serial">List item no.</Label>
        <InlineInput
          id="listing-serial"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          placeholder="47"
          className="block w-28"
        />
      </div>
      <div>
        <Label htmlFor="listing-hall">Court hall</Label>
        <InlineInput
          id="listing-hall"
          value={hall}
          onChange={(e) => setHall(e.target.value)}
          placeholder="3"
          className="block w-28"
        />
      </div>
      <Button type="submit" variant="primary" disabled={updateHearing.isPending}>
        {updateHearing.isPending ? "Saving…" : "Save"}
      </Button>
      {error && (
        <div className="w-full">
          <FormError message={error} />
        </div>
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
        <Label htmlFor="hearing-date">Date</Label>
        <InlineInput
          id="hearing-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="block"
        />
      </div>
      <div className="min-w-48 flex-1">
        <Label htmlFor="hearing-purpose">Listed for</Label>
        <InlineInput
          id="hearing-purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="filing, evidence, arguments…"
          className="block w-full"
        />
      </div>
      <Button type="submit" variant="primary" disabled={schedule.isPending}>
        {schedule.isPending ? "Scheduling…" : "Schedule"}
      </Button>
      {error && (
        <div className="w-full">
          <FormError message={error} />
        </div>
      )}
    </form>
  );
}

function DiaryEntry(props: { hearing: Hearing; rosterName: (id: string) => string }) {
  const { hearing } = props;
  const [recording, setRecording] = useState(false);
  const [editingListing, setEditingListing] = useState(false);
  const [confirmation, setConfirmation] = useState<string | undefined>();
  // Set the moment an outcome is recorded — the capture window for the
  // follow-up work it implies (FR-HEAR-007). Carries the auto-scheduled
  // next date as the follow-up forms' due-date default.
  const [followUp, setFollowUp] = useState<{ offered: boolean; nextDate?: string }>({
    offered: false,
  });

  const scheduled = isScheduled(hearing);
  const listing = [
    hearing.spec?.listSerialNumber && `item ${hearing.spec.listSerialNumber}`,
    hearing.spec?.courtHall && `hall ${hearing.spec.courtHall}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{formatCalendarDate(hearing.spec?.date ?? "")}</span>
        {hearing.spec?.purpose && (
          <span className="text-xs text-ink-muted">for {hearing.spec.purpose}</span>
        )}
        {listing && <span className="text-xs text-ink-faint">({listing})</span>}
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
            <Button onClick={() => setRecording((v) => !v)}>
              {recording ? "Close" : "Record outcome"}
            </Button>
            <Button onClick={() => setEditingListing((v) => !v)}>
              {editingListing ? "Close" : "Cause-list details"}
            </Button>
          </span>
        )}
      </div>

      {!scheduled && (
        <div className="mt-1 text-xs text-ink-muted">
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
      {followUp.offered && (
        <FollowUpForms caseId={hearing.spec?.caseId ?? ""} nextDate={followUp.nextDate} />
      )}
      {recording && scheduled && (
        <RecordOutcomeForm
          hearing={hearing}
          onDone={(message, nextDate) => {
            setRecording(false);
            setConfirmation(message);
            setFollowUp({ offered: true, nextDate });
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
        <h2 className="text-sm font-semibold">Diary</h2>
        <Button onClick={() => setScheduling((v) => !v)}>
          {scheduling ? "Close" : "Schedule a hearing"}
        </Button>
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
