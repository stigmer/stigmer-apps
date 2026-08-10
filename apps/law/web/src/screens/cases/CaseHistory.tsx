/**
 * The matter's change history (FR-AUDIT-001, partner-only — mounted
 * only for partner roles; the server refuses everyone else regardless):
 * who changed what, when, field by field. Read-only by nature — an
 * audit trail that could be edited would not be one.
 */

import { useState } from "react";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { ChangeType } from "../../gen/stigmer/law/auditentry/v1/auditentry_pb.js";
import { formatInstant } from "../../lib/format.js";
import { useFirmRoster } from "../members/queries.js";
import { useCaseHistory } from "./queries.js";

/** Wire kinds → the profession's words (one place, like format.ts). */
const SUBJECT_LABELS: Record<string, string> = {
  Case: "the matter",
  Hearing: "a hearing",
  Deadline: "a deadline",
  FeeArrangement: "the fee arrangement",
  LedgerEntry: "a ledger entry",
};

export function CaseHistory(props: { caseId: string }) {
  const [page, setPage] = useState(0);
  const history = useCaseHistory(props.caseId, page);
  const roster = useFirmRoster();

  function actorName(actorId: string, actorKind: string): string {
    if (actorKind === "system") return "the system";
    if (actorKind === "operator") return "the operator";
    return roster.data?.nameOfUser(actorId) ?? actorId;
  }

  return (
    <section aria-label="History" className="mt-6">
      <h2 className="mb-2 font-medium">History</h2>
      {history.isPending && <Loading label="Loading the history…" />}
      {history.isError && (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      )}
      {history.isSuccess && history.data.items.length === 0 && (
        <EmptyState title="No changes recorded yet" />
      )}
      {history.isSuccess && history.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {history.data.items.map((entry) => {
              const createdAt = entry.metadata?.createdAt;
              const created = entry.spec?.changeType === ChangeType.CREATED;
              return (
                <li key={entry.metadata?.id} className="border-b border-line px-3 py-2 last:border-b-0">
                  <p className="text-sm">
                    <span className="font-medium">
                      {actorName(entry.spec?.actorId ?? "", entry.spec?.actorKind ?? "")}
                    </span>{" "}
                    {created ? "added" : "changed"}{" "}
                    {SUBJECT_LABELS[entry.spec?.subjectKind ?? ""] ?? entry.spec?.subjectKind}
                    {createdAt && (
                      <span className="text-ink-faint"> — {formatInstant(timestampDate(createdAt))}</span>
                    )}
                  </p>
                  {!created && (entry.spec?.changes.length ?? 0) > 0 && (
                    <ul className="mt-1 text-sm text-ink-muted">
                      {entry.spec?.changes.map((change) => (
                        <li key={change.fieldPath}>
                          {change.fieldPath}:{" "}
                          <span className="line-through decoration-ink-faint">
                            {change.oldValue || "—"}
                          </span>{" "}
                          → {change.newValue || "—"}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <Pagination
            page={page}
            totalCount={Number(history.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
