/**
 * Home = the firm's pulse (journey J1): the screen answers "what needs
 * my attention today?" before it offers anything else. Four sections,
 * each a server-scoped list (partners see the firm, everyone else their
 * cases — the matrix, applied by the backend's query scoping):
 *
 *   1. The board — hearings today and tomorrow.
 *   2. The nag — hearings whose date passed with no recorded outcome
 *      (FR-HEAR-005; it never leaves this screen until a human records
 *      what happened).
 *   3. My deadlines — the caller's own, due within a week or overdue.
 *   4. No next date — matters with nothing scheduled (the silence that
 *      needs breaking).
 *
 * Every row links to where the fix happens. "My open tasks" stays one
 * link away — the MVP's home was a task list, which is an associate's
 * morning, not a partner's.
 */

import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import type { Deadline } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { OutcomeKind, type Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { addDays, firmToday } from "../../lib/firm-day.js";
import { formatCalendarDate } from "../../lib/format.js";
import { useCaseList, useCaseSummaryMap } from "../cases/queries.js";
import { useMyOpenDeadlines } from "../deadlines/queries.js";
import { useHearingsInRange, useUnrecordedHearings } from "../hearings/queries.js";

function SectionCard(props: {
  title: string;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={props.title}
      className={`rounded-card border bg-surface p-4 ${
        props.tone === "warn" ? "border-warn" : "border-line"
      }`}
    >
      <h2 className="mb-2 font-medium">{props.title}</h2>
      {props.children}
    </section>
  );
}

function HearingRow(props: { hearing: Hearing; fileNumber: string; today: string }) {
  const { hearing } = props;
  const listing = [
    hearing.spec?.listSerialNumber && `item ${hearing.spec.listSerialNumber}`,
    hearing.spec?.courtHall && `hall ${hearing.spec.courtHall}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/cases/${hearing.spec?.caseId}`}
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 hover:bg-brand-surface"
      >
        <span className="font-medium">{props.fileNumber}</span>
        <span className="text-sm text-ink-muted">
          {hearing.spec?.date === props.today
            ? "Today"
            : formatCalendarDate(hearing.spec?.date ?? "")}
          {hearing.spec?.purpose && ` — ${hearing.spec.purpose}`}
        </span>
        {listing && <span className="text-sm text-ink-faint">({listing})</span>}
      </Link>
    </li>
  );
}

export function HomeScreen() {
  const today = firmToday();
  const board = useHearingsInRange(today, addDays(today, 1));
  const unrecorded = useUnrecordedHearings();
  const deadlines = useMyOpenDeadlines(addDays(today, 7));
  const noNextDate = useCaseList({ noNextDate: true }, 0);
  // One summary page joins file numbers onto hearing/deadline rows.
  const summaries = useCaseSummaryMap();

  const fileNumberOf = (caseId: string | undefined) =>
    summaries.data?.get(caseId ?? "")?.fileNumber ?? "…";

  const scheduledOnBoard = (board.data?.items ?? []).filter(
    (h) => (h.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED) === OutcomeKind.UNSPECIFIED,
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Today</h1>
        <Link to="/tasks" className="flex h-11 items-center rounded-card px-3 text-sm text-brand hover:bg-brand-surface">
          My open tasks →
        </Link>
      </div>

      {/* The nag renders FIRST when it has content: unrecorded outcomes
          are the one thing the product refuses to let go quiet. */}
      {unrecorded.isSuccess && unrecorded.data.items.length > 0 && (
        <SectionCard title="Hearings awaiting an outcome" tone="warn">
          <p className="mb-2 text-sm text-ink-muted">
            These hearings have passed with nothing recorded. Open the matter and record what
            happened.
          </p>
          <ul>
            {unrecorded.data.items.map((hearing) => (
              <HearingRow
                key={hearing.metadata?.id}
                hearing={hearing}
                fileNumber={fileNumberOf(hearing.spec?.caseId)}
                today={today}
              />
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard title="Hearings today and tomorrow">
        {board.isPending && <Loading label="Loading the board…" />}
        {board.isError && <ErrorState error={board.error} onRetry={() => void board.refetch()} />}
        {board.isSuccess && scheduledOnBoard.length === 0 && (
          <EmptyState title="Nothing listed today or tomorrow" />
        )}
        {board.isSuccess && scheduledOnBoard.length > 0 && (
          <ul>
            {scheduledOnBoard.map((hearing) => (
              <HearingRow
                key={hearing.metadata?.id}
                hearing={hearing}
                fileNumber={fileNumberOf(hearing.spec?.caseId)}
                today={today}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="My deadlines — this week and overdue">
        {deadlines.isPending && <Loading label="Loading deadlines…" />}
        {deadlines.isError && (
          <ErrorState error={deadlines.error} onRetry={() => void deadlines.refetch()} />
        )}
        {deadlines.isSuccess && deadlines.data.items.length === 0 && (
          <EmptyState title="No deadlines landing this week" />
        )}
        {deadlines.isSuccess && deadlines.data.items.length > 0 && (
          <ul>
            {deadlines.data.items.map((deadline: Deadline) => (
              <li key={deadline.metadata?.id} className="border-b border-line last:border-b-0">
                <Link
                  to={`/cases/${deadline.spec?.caseId}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 hover:bg-brand-surface"
                >
                  <span className="font-medium">{deadline.spec?.title}</span>
                  <span
                    className={
                      deadline.status?.overdue
                        ? "rounded-card bg-danger-surface px-2 py-0.5 text-xs font-medium text-danger"
                        : "text-sm text-ink-muted"
                    }
                  >
                    {deadline.status?.overdue
                      ? `OVERDUE — was due ${formatCalendarDate(deadline.spec?.dueDate ?? "")}`
                      : `due ${formatCalendarDate(deadline.spec?.dueDate ?? "")}`}
                  </span>
                  <span className="text-sm text-ink-faint">
                    {fileNumberOf(deadline.spec?.caseId)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Matters with no next date">
        {noNextDate.isPending && <Loading label="Checking the diary…" />}
        {noNextDate.isError && (
          <ErrorState error={noNextDate.error} onRetry={() => void noNextDate.refetch()} />
        )}
        {noNextDate.isSuccess && noNextDate.data.items.length === 0 && (
          <EmptyState title="Every matter has a next hearing on the board" />
        )}
        {noNextDate.isSuccess && noNextDate.data.items.length > 0 && (
          <>
            <p className="mb-2 text-sm text-ink-muted">
              Nothing is scheduled on these — open one and put the next date on the board.
            </p>
            <ul>
              {noNextDate.data.items.map((summary) => (
                <li key={summary.id} className="border-b border-line last:border-b-0">
                  <Link
                    to={`/cases/${summary.id}`}
                    className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 hover:bg-brand-surface"
                  >
                    <span className="font-medium">{summary.fileNumber}</span>
                    <span className="text-sm text-ink-muted">{summary.caption}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </SectionCard>
    </div>
  );
}
