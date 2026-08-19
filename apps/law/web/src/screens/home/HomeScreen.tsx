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

import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { ButtonLink } from "../../components/Button.js";
import { ListRow, RowMeta, RowTitle } from "../../components/ListCard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SectionCard } from "../../components/SectionCard.js";
import type { Deadline } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { OutcomeKind, type Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { addDays, firmToday } from "../../lib/firm-day.js";
import { formatCalendarDate, outcomeKindLabel } from "../../lib/format.js";
import { useCaseList, useCaseSummaryMap } from "../cases/queries.js";
import { useDeadlinesEnteredOn, useMyOpenDeadlines } from "../deadlines/queries.js";
import {
  useHearingsInRange,
  useHearingsScheduledOn,
  useOutcomesRecordedOn,
  useUnrecordedHearings,
} from "../hearings/queries.js";
import { useUnassignedOpenTasks } from "../tasks/queries.js";
import { TaskRow } from "../tasks/TaskRow.js";

function HearingRow(props: { hearing: Hearing; fileNumber: string; today: string }) {
  const { hearing } = props;
  const listing = [
    hearing.spec?.listSerialNumber && `item ${hearing.spec.listSerialNumber}`,
    hearing.spec?.courtHall && `hall ${hearing.spec.courtHall}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ListRow to={`/cases/${hearing.spec?.caseId}`}>
      <RowTitle>{props.fileNumber}</RowTitle>
      <RowMeta>
        {hearing.spec?.date === props.today
          ? "Today"
          : formatCalendarDate(hearing.spec?.date ?? "")}
        {hearing.spec?.purpose && ` — ${hearing.spec.purpose}`}
      </RowMeta>
      {listing && <RowMeta faint>({listing})</RowMeta>}
    </ListRow>
  );
}

/** A recorded outcome as a story line: what happened, and the next
 * date when the court gave one (FR-HEAR-007). */
function OutcomeRow(props: { hearing: Hearing; fileNumber: string }) {
  const { hearing } = props;
  return (
    <ListRow to={`/cases/${hearing.spec?.caseId}`}>
      <RowTitle>{props.fileNumber}</RowTitle>
      <RowMeta>
        {outcomeKindLabel(hearing.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED)}
        {hearing.status?.nextDate && ` — next ${formatCalendarDate(hearing.status.nextDate)}`}
      </RowMeta>
      {hearing.spec?.purpose && <RowMeta faint>{hearing.spec.purpose}</RowMeta>}
    </ListRow>
  );
}

export function HomeScreen() {
  const today = firmToday();
  const board = useHearingsInRange(today, addDays(today, 1));
  const unrecorded = useUnrecordedHearings();
  const deadlines = useMyOpenDeadlines(addDays(today, 7));
  const noNextDate = useCaseList({ noNextDate: true }, 0);
  // The day's story (FR-HEAR-007) + the pickup list (FR-TASK-002).
  const recordedToday = useOutcomesRecordedOn(today);
  const scheduledToday = useHearingsScheduledOn(today);
  const enteredToday = useDeadlinesEnteredOn(today);
  const unassigned = useUnassignedOpenTasks();
  // One summary page joins file numbers onto hearing/deadline rows.
  const summaries = useCaseSummaryMap();

  const fileNumberOf = (caseId: string | undefined) =>
    summaries.data?.get(caseId ?? "")?.fileNumber ?? "…";

  const scheduledOnBoard = (board.data?.items ?? []).filter(
    (h) => (h.status?.outcomeKind ?? OutcomeKind.UNSPECIFIED) === OutcomeKind.UNSPECIFIED,
  );

  return (
    <div className="grid gap-4">
      <PageHeader title="Today">
        <ButtonLink to="/tasks">My open tasks →</ButtonLink>
      </PageHeader>

      {/* The nag renders FIRST when it has content: unrecorded outcomes
          are the one thing the product refuses to let go quiet. */}
      {unrecorded.isSuccess && unrecorded.data.items.length > 0 && (
        <SectionCard title="Hearings awaiting an outcome" tone="warn">
          <p className="mb-2 text-xs text-ink-muted">
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

      {/* The day's story (FR-HEAR-007): the answer to "the lawyers went
          to court and the office doesn't know what happened" — outcomes
          recorded today, new dates on the board, new obligations.
          Renders the same facts the assistant's what_happened_today
          verb answers (one contract, two surfaces). */}
      <SectionCard title="What happened today">
        {(recordedToday.isPending || scheduledToday.isPending || enteredToday.isPending) && (
          <Loading label="Reading the day's diary…" />
        )}
        {(recordedToday.isError || scheduledToday.isError || enteredToday.isError) && (
          <ErrorState
            error={recordedToday.error ?? scheduledToday.error ?? enteredToday.error}
            onRetry={() => {
              void recordedToday.refetch();
              void scheduledToday.refetch();
              void enteredToday.refetch();
            }}
          />
        )}
        {recordedToday.isSuccess && scheduledToday.isSuccess && enteredToday.isSuccess && (
          <>
            {recordedToday.data.items.length === 0 &&
              scheduledToday.data.items.length === 0 &&
              enteredToday.data.items.length === 0 && (
                <EmptyState title="Nothing recorded yet today" />
              )}
            {recordedToday.data.items.length > 0 && (
              <>
                <h3 className="mb-1 text-xs font-medium text-ink-muted">Back from court</h3>
                <ul>
                  {recordedToday.data.items.map((hearing) => (
                    <OutcomeRow
                      key={hearing.metadata?.id}
                      hearing={hearing}
                      fileNumber={fileNumberOf(hearing.spec?.caseId)}
                    />
                  ))}
                </ul>
              </>
            )}
            {scheduledToday.data.items.length > 0 && (
              <>
                <h3 className="mt-2 mb-1 text-xs font-medium text-ink-muted">
                  New dates on the board
                </h3>
                <ul>
                  {scheduledToday.data.items.map((hearing) => (
                    <HearingRow
                      key={hearing.metadata?.id}
                      hearing={hearing}
                      fileNumber={fileNumberOf(hearing.spec?.caseId)}
                      today={today}
                    />
                  ))}
                </ul>
              </>
            )}
            {enteredToday.data.items.length > 0 && (
              <>
                <h3 className="mt-2 mb-1 text-xs font-medium text-ink-muted">
                  New deadlines on the book
                </h3>
                <ul>
                  {enteredToday.data.items.map((deadline: Deadline) => (
                    <ListRow key={deadline.metadata?.id} to={`/cases/${deadline.spec?.caseId}`}>
                      <RowTitle>{deadline.spec?.title}</RowTitle>
                      <RowMeta>due {formatCalendarDate(deadline.spec?.dueDate ?? "")}</RowMeta>
                      <RowMeta faint>{fileNumberOf(deadline.spec?.caseId)}</RowMeta>
                    </ListRow>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </SectionCard>

      {/* The pickup list (FR-TASK-002): follow-up work born from
          outcomes that nobody owns yet — visible so idle hands find it
          the same day, not at the Saturday meeting. */}
      {unassigned.isSuccess && unassigned.data.items.length > 0 && (
        <SectionCard title="Tasks waiting for an owner" tone="warn">
          <p className="mb-2 text-xs text-ink-muted">
            Nobody is assigned to these. Open one and take it, or assign it to someone.
          </p>
          <ul>
            {unassigned.data.items.map((task) => (
              <TaskRow key={task.metadata?.id} task={task} />
            ))}
          </ul>
        </SectionCard>
      )}

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
              <ListRow key={deadline.metadata?.id} to={`/cases/${deadline.spec?.caseId}`}>
                <RowTitle>{deadline.spec?.title}</RowTitle>
                {deadline.status?.overdue ? (
                  <Badge tone="danger">
                    OVERDUE — was due {formatCalendarDate(deadline.spec?.dueDate ?? "")}
                  </Badge>
                ) : (
                  <RowMeta>due {formatCalendarDate(deadline.spec?.dueDate ?? "")}</RowMeta>
                )}
                <RowMeta faint>{fileNumberOf(deadline.spec?.caseId)}</RowMeta>
              </ListRow>
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
            <p className="mb-2 text-xs text-ink-muted">
              Nothing is scheduled on these — open one and put the next date on the board.
            </p>
            <ul>
              {noNextDate.data.items.map((summary) => (
                <ListRow key={summary.id} to={`/cases/${summary.id}`}>
                  <RowTitle>{summary.fileNumber}</RowTitle>
                  <RowMeta>{summary.caption}</RowMeta>
                </ListRow>
              ))}
            </ul>
          </>
        )}
      </SectionCard>
    </div>
  );
}
