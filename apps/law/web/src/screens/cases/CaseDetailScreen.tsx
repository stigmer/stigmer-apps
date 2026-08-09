/**
 * Case detail (FR-CASE-003/004): the case's whole working surface — facts
 * with edit (full-spec, D10), its open work (tasks filtered by case, with
 * creation pre-bound via ?case=), the running record (notes), and the
 * file (documents). The derived document_count renders as received
 * (FR-CASE-005 AC8).
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { formatCalendarDate } from "../../lib/format.js";
import { useCurrentUser } from "../../session/use-session.js";
import { TaskRow } from "../tasks/TaskRow.js";
import { useTaskList } from "../tasks/queries.js";
import { useUserDirectory } from "../users/queries.js";
import { CaseDocuments } from "./CaseDocuments.js";
import { CaseForm } from "./CaseForm.js";
import { CaseNotes } from "./CaseNotes.js";
import { useCase, useUpdateCase } from "./queries.js";

export function CaseDetailScreen() {
  const { id = "" } = useParams();
  const caseQuery = useCase(id);
  const updateCase = useUpdateCase();
  const directory = useUserDirectory();
  // useCurrentUser anchors the screen behind RequireSession; the tasks
  // section below is case-filtered, not caller-filtered.
  useCurrentUser();
  const caseTasks = useTaskList({ caseId: id }, 0);
  const [editing, setEditing] = useState(false);

  if (caseQuery.isPending) return <Loading label="Loading case…" />;
  if (caseQuery.isError) {
    return <ErrorState error={caseQuery.error} onRetry={() => void caseQuery.refetch()} />;
  }
  const c = caseQuery.data;

  return (
    <section aria-label="Case">
      <div className="mb-1 text-sm text-ink-muted">
        <Link to="/cases" className="text-brand underline">
          Cases
        </Link>{" "}
        / {c.spec?.caseNumber}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">
          {c.spec?.caseNumber} — {c.spec?.clientName}
        </h1>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <CaseForm
          initial={c.spec}
          submitLabel="Save changes"
          pending={updateCase.isPending}
          onSubmit={async (spec) => {
            await updateCase.mutateAsync({ existing: c, spec });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-card border border-line bg-surface p-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-muted">Next hearing</dt>
            <dd>
              {c.spec?.nextHearingDate
                ? formatCalendarDate(c.spec.nextHearingDate)
                : "No hearing scheduled"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Case type</dt>
            <dd>{c.spec?.caseType}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Assigned lawyer</dt>
            <dd>{directory.data?.nameOf(c.spec?.assignedLawyerId ?? "") ?? "…"}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">Documents</dt>
            <dd>{c.status?.documentCount ?? 0}</dd>
          </div>
        </dl>
      )}

      <section aria-label="Tasks on this case" className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Tasks</h2>
          <Link to={`/tasks/new?case=${id}`} className="text-sm text-brand underline">
            New task
          </Link>
        </div>
        {caseTasks.isPending && <Loading label="Loading tasks…" />}
        {caseTasks.isError && (
          <ErrorState error={caseTasks.error} onRetry={() => void caseTasks.refetch()} />
        )}
        {caseTasks.isSuccess && caseTasks.data.items.length === 0 && (
          <EmptyState title="No tasks on this case" />
        )}
        {caseTasks.isSuccess && caseTasks.data.items.length > 0 && (
          <ul className="rounded-card border border-line bg-surface">
            {caseTasks.data.items.map((task) => (
              <TaskRow
                key={task.metadata?.id}
                task={task}
                showAssignee={
                  task.spec?.assigneeId
                    ? directory.data?.nameOf(task.spec.assigneeId)
                    : "Unassigned"
                }
              />
            ))}
          </ul>
        )}
      </section>

      <CaseDocuments caseId={id} />
      <CaseNotes caseId={id} />
    </section>
  );
}
