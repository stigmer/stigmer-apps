/**
 * Cases: the summary list line — file number, caption, forum, next
 * hearing date, lifecycle — with the contract's named predicates as
 * simple controls. Ordering is the server's: soonest hearing first,
 * dateless last.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
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
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        to={`/cases/${summary.id}`}
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-brand-surface"
      >
        <span className="font-medium">{summary.fileNumber}</span>
        <span className="flex-1 basis-48 text-sm text-ink-muted">{summary.caption}</span>
        <span className="text-sm text-ink-faint">
          {forumKindLabel(summary.forumKind)}
          {summary.forumName && ` — ${summary.forumName}`}
        </span>
        <span className="text-sm text-ink-muted">
          {summary.nextHearingDate
            ? `Hearing ${formatCalendarDate(summary.nextHearingDate)}`
            : "No next date"}
        </span>
        <span
          className={
            summary.lifecycle === CaseLifecycle.DISPOSED ||
            summary.lifecycle === CaseLifecycle.CLOSED
              ? "rounded-card bg-warn-surface px-2 py-0.5 text-xs font-medium text-warn"
              : "rounded-card bg-brand-surface px-2 py-0.5 text-xs font-medium text-brand"
          }
        >
          {caseLifecycleLabel(summary.lifecycle)}
        </span>
      </Link>
    </li>
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Cases</h1>
        <Link
          to="/cases/new"
          className="flex h-11 items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
        >
          New case
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div>
          <label htmlFor="case-window" className="mr-2 text-ink-muted">
            Show
          </label>
          <select
            id="case-window"
            value={window}
            onChange={(e) => {
              setWindow(e.target.value as (typeof WINDOWS)[number]["value"]);
              resetPage();
            }}
            className="h-11 rounded-card border border-line bg-surface px-2"
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="case-lifecycle" className="mr-2 text-ink-muted">
            Status
          </label>
          <select
            id="case-lifecycle"
            value={lifecycle}
            onChange={(e) => {
              setLifecycle(Number(e.target.value) as CaseLifecycle);
              resetPage();
            }}
            className="h-11 rounded-card border border-line bg-surface px-2"
          >
            <option value={CaseLifecycle.UNSPECIFIED}>Active</option>
            <option value={CaseLifecycle.DISPOSED}>Disposed</option>
            <option value={CaseLifecycle.CLOSED}>Closed</option>
          </select>
        </div>
        <label className="flex h-11 items-center gap-2">
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
          <ul className="rounded-card border border-line bg-surface">
            {list.data.items.map((summary) => (
              <CaseSummaryRow key={summary.id} summary={summary} />
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(list.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
