/**
 * Cases: the summary list line — file number, caption, forum, next
 * hearing date, lifecycle — with the contract's named predicates as
 * simple controls. Ordering is the server's: soonest hearing first,
 * dateless last.
 */

import { useState } from "react";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { ButtonLink } from "../../components/Button.js";
import { InlineSelect } from "../../components/Field.js";
import { ListCard, ListRow, RowMeta, RowTitle } from "../../components/ListCard.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Pagination } from "../../components/Pagination.js";
import { CaseLifecycle, type CaseSummary } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  caseLifecycleLabel,
  formatCalendarDate,
  forumKindLabel,
} from "../../lib/format.js";
import { useCaseList, type CaseListPredicates } from "./queries.js";

/** The hearing-window control's positions, in the user's words. */
const WINDOWS = [
  { value: "all", label: "All matters" },
  { value: "7", label: "Hearings within 7 days" },
  { value: "30", label: "Hearings within 30 days" },
  { value: "none", label: "No next date" },
] as const;

export function CaseSummaryRow(props: { summary: CaseSummary }) {
  const { summary } = props;
  const settled =
    summary.lifecycle === CaseLifecycle.DISPOSED || summary.lifecycle === CaseLifecycle.CLOSED;
  return (
    <ListRow to={`/cases/${summary.id}`}>
      <RowTitle>{summary.fileNumber}</RowTitle>
      <RowMeta grow>{summary.caption}</RowMeta>
      <RowMeta faint>
        {forumKindLabel(summary.forumKind)}
        {summary.forumName && ` — ${summary.forumName}`}
      </RowMeta>
      <RowMeta>
        {summary.nextHearingDate
          ? `Hearing ${formatCalendarDate(summary.nextHearingDate)}`
          : "No next date"}
      </RowMeta>
      <Badge tone={settled ? "warn" : "brand"}>{caseLifecycleLabel(summary.lifecycle)}</Badge>
    </ListRow>
  );
}

export function CaseListScreen() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]["value"]>("all");
  const [mine, setMine] = useState(false);
  const [lifecycle, setLifecycle] = useState<CaseLifecycle>(CaseLifecycle.UNSPECIFIED);
  const [page, setPage] = useState(0);

  const predicates: CaseListPredicates = {
    hearingWithinDays: window === "7" || window === "30" ? Number(window) : 0,
    noNextDate: window === "none",
    mine,
    lifecycle,
  };
  const list = useCaseList(predicates, page);

  function resetPage() {
    setPage(0);
  }

  return (
    <section aria-label="Cases">
      <PageHeader title="Cases">
        <ButtonLink to="/cases/new" variant="primary">
          New case
        </ButtonLink>
      </PageHeader>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div>
          <label htmlFor="case-window" className="mr-2 text-ink-muted">
            Show
          </label>
          <InlineSelect
            id="case-window"
            value={window}
            onChange={(e) => {
              setWindow(e.target.value as (typeof WINDOWS)[number]["value"]);
              resetPage();
            }}
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </InlineSelect>
        </div>
        <div>
          <label htmlFor="case-lifecycle" className="mr-2 text-ink-muted">
            Status
          </label>
          <InlineSelect
            id="case-lifecycle"
            value={lifecycle}
            onChange={(e) => {
              setLifecycle(Number(e.target.value) as CaseLifecycle);
              resetPage();
            }}
          >
            <option value={CaseLifecycle.UNSPECIFIED}>Active</option>
            <option value={CaseLifecycle.DISPOSED}>Disposed</option>
            <option value={CaseLifecycle.CLOSED}>Closed</option>
          </InlineSelect>
        </div>
        <label className="flex h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => {
              setMine(e.target.checked);
              resetPage();
            }}
          />
          My matters
        </label>
      </div>

      {list.isPending && <Loading label="Loading cases…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState title="No matters here">
          {window === "none"
            ? "Every matter has a next hearing date — nothing needs scheduling."
            : "Open the firm's first matter to start the diary."}
        </EmptyState>
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <ListCard>
            {list.data.items.map((summary) => (
              <CaseSummaryRow key={summary.id} summary={summary} />
            ))}
          </ListCard>
          <Pagination page={page} totalCount={Number(list.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
