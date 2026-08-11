/**
 * The case story (journey J6): everything about one matter, tabbed by
 * how the day uses it — the diary first (it IS the case), then
 * deadlines, tasks-by-case live on the tasks screen, notes, documents,
 * the working team, and for PARTNERS the money and history tabs (the
 * server refuses everyone else; the tabs simply don't render).
 *
 * Editing facts is full-spec replacement through CaseForm; the
 * lifecycle moves ONLY through its own control (a spec edit cannot
 * close a matter — DD-A6's single-write-path rule, visible in the UI).
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { FormError, InlineSelect } from "../../components/Field.js";
import {
  CaseLifecycle,
  type Case,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  caseLifecycleLabel,
  clientRoleLabel,
  formatCalendarDate,
  forumKindLabel,
} from "../../lib/format.js";
import { isPartnerRole, useMyRole } from "../../session/use-firm-member.js";
import { useClient } from "../clients/queries.js";
import { CaseDeadlines } from "./CaseDeadlines.js";
import { CaseDiary } from "./CaseDiary.js";
import { CaseDocuments } from "./CaseDocuments.js";
import { CaseForm } from "./CaseForm.js";
import { CaseHistory } from "./CaseHistory.js";
import { CaseMembersSection } from "./CaseMembersSection.js";
import { CaseMoney } from "./CaseMoney.js";
import { CaseNotes } from "./CaseNotes.js";
import { CaseTasks } from "./CaseTasks.js";
import { useCase, useUpdateCase, useUpdateCaseLifecycle } from "./queries.js";

const TABS = ["Diary", "Deadlines", "Tasks", "Notes", "Documents", "Team"] as const;
const PARTNER_TABS = ["Money", "History"] as const;
type Tab = (typeof TABS)[number] | (typeof PARTNER_TABS)[number];

function LifecycleControl(props: { matter: Case }) {
  const updateLifecycle = useUpdateCaseLifecycle();
  const [error, setError] = useState<string | undefined>();
  const current = props.matter.status?.lifecycle ?? CaseLifecycle.ACTIVE;

  async function onChange(next: CaseLifecycle) {
    setError(undefined);
    try {
      await updateLifecycle.mutateAsync({ id: props.matter.metadata?.id ?? "", lifecycle: next });
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <div>
      <label htmlFor="case-lifecycle-control" className="sr-only">
        Matter status
      </label>
      <InlineSelect
        id="case-lifecycle-control"
        value={current === CaseLifecycle.UNSPECIFIED ? CaseLifecycle.ACTIVE : current}
        onChange={(e) => void onChange(Number(e.target.value) as CaseLifecycle)}
        disabled={updateLifecycle.isPending}
      >
        <option value={CaseLifecycle.ACTIVE}>{caseLifecycleLabel(CaseLifecycle.ACTIVE)}</option>
        <option value={CaseLifecycle.DISPOSED}>
          {caseLifecycleLabel(CaseLifecycle.DISPOSED)}
        </option>
        <option value={CaseLifecycle.CLOSED}>{caseLifecycleLabel(CaseLifecycle.CLOSED)}</option>
      </InlineSelect>
      {error && (
        <div className="mt-1">
          <FormError message={error} />
        </div>
      )}
    </div>
  );
}

export function CaseDetailScreen() {
  const { id = "" } = useParams();
  const matter = useCase(id);
  const client = useClient(matter.data?.spec?.clientId ?? "");
  const updateCase = useUpdateCase();
  const partner = isPartnerRole(useMyRole());
  const [tab, setTab] = useState<Tab>("Diary");
  const [editing, setEditing] = useState(false);

  if (matter.isPending) return <Loading label="Loading the matter…" />;
  if (matter.isError) {
    // The membership denial lands here for non-members — the server's
    // sentence IS the explanation (they still saw the list line).
    return <ErrorState error={matter.error} onRetry={() => void matter.refetch()} />;
  }
  const spec = matter.data.spec;
  if (!spec) return <EmptyState title="This matter has no details" />;

  const parties = spec.opposingParties.map((p) =>
    p.counselName ? `${p.name} (counsel: ${p.counselName})` : p.name,
  );
  const tabs: readonly Tab[] = partner ? [...TABS, ...PARTNER_TABS] : TABS;

  if (editing) {
    return (
      <section aria-label={`Edit ${spec.fileNumber}`}>
        <h1 className="mb-4 text-lg font-semibold">Edit {spec.fileNumber}</h1>
        <CaseForm
          initial={spec}
          initialClientName={client.data?.spec?.displayName ?? ""}
          submitLabel="Save changes"
          pending={updateCase.isPending}
          onSubmit={async (nextSpec) => {
            await updateCase.mutateAsync({ existing: matter.data, spec: nextSpec });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section aria-label={spec.fileNumber}>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{spec.fileNumber}</h1>
        <LifecycleControl matter={matter.data} />
        <Button onClick={() => setEditing(true)}>Edit details</Button>
      </div>

      <div className="mb-4 rounded-card border border-line bg-surface p-4 text-sm">
        <p>
          <Link to={`/clients/${spec.clientId}`} className="font-medium text-brand hover:underline">
            {client.data?.spec?.displayName ?? "…"}
          </Link>{" "}
          <span className="text-ink-muted">({clientRoleLabel(spec.clientRole)})</span>
          {parties.length > 0 && <span> vs {parties.join("; ")}</span>}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          {forumKindLabel(spec.forum?.forumKind ?? 0)}
          {spec.forum?.name && ` — ${spec.forum.name}`}
          {spec.forum?.bench && `, ${spec.forum.bench}`}
          {spec.stage && ` · stage: ${spec.stage}`}
          {spec.caseType && ` · ${spec.caseType}`}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          {spec.courtCaseNumber
            ? `Court no. ${spec.courtCaseNumber}`
            : "Court number not assigned yet"}
          {spec.cnr && ` · CNR ${spec.cnr}`}
        </p>
        <p className="mt-1">
          {matter.data.status?.nextHearingDate ? (
            <>Next hearing {formatCalendarDate(matter.data.status.nextHearingDate)}</>
          ) : (
            <Badge tone="warn">No next date — nothing is scheduled on this matter</Badge>
          )}
        </p>
      </div>

      <nav aria-label="Matter sections" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-current={tab === name ? "page" : undefined}
            className={
              tab === name
                ? "h-9 rounded-t-card border-b-2 border-brand px-3 text-sm font-medium text-brand"
                : "h-9 rounded-t-card px-3 text-sm text-ink-muted hover:text-ink"
            }
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === "Diary" && <CaseDiary caseId={id} />}
      {tab === "Deadlines" && <CaseDeadlines caseId={id} />}
      {tab === "Tasks" && <CaseTasks caseId={id} />}
      {tab === "Notes" && <CaseNotes caseId={id} />}
      {tab === "Documents" && <CaseDocuments caseId={id} />}
      {tab === "Team" && <CaseMembersSection caseId={id} leadMemberId={spec.leadLawyerId} />}
      {tab === "Money" && partner && <CaseMoney caseId={id} />}
      {tab === "History" && partner && <CaseHistory caseId={id} />}
    </section>
  );
}
