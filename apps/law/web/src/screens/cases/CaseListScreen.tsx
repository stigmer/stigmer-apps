/**
 * Cases (FR-CASE-002): the at-a-glance pair is case number + next hearing
 * (the transcript's own emphasis), ordered by the server — soonest
 * hearing first, dateless last. No search by decree (FR-CASE-007
 * excluded): at this firm's scale the hearing-ordered list IS the
 * workflow.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { formatCalendarDate } from "../../lib/format.js";
import { useCaseList } from "./queries.js";

export function CaseListScreen() {
  const [page, setPage] = useState(0);
  const list = useCaseList(page);

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

      {list.isPending && <Loading label="Loading cases…" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState title="No cases yet">
          Create the firm's first case to start tracking hearings, tasks, and documents.
        </EmptyState>
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {list.data.items.map((c) => (
              <li key={c.metadata?.id} className="border-b border-line last:border-b-0">
                <Link
                  to={`/cases/${c.metadata?.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-brand-surface"
                >
                  <span className="font-medium">{c.spec?.caseNumber}</span>
                  <span className="flex-1 basis-40 text-sm text-ink-muted">
                    {c.spec?.clientName}
                  </span>
                  <span className="text-sm text-ink-faint">{c.spec?.caseType}</span>
                  <span className="text-sm text-ink-muted">
                    {c.spec?.nextHearingDate
                      ? `Hearing ${formatCalendarDate(c.spec.nextHearingDate)}`
                      : "No hearing scheduled"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={page} totalCount={Number(list.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
