/**
 * The case story (journey J6) on the DD-005 detail frame: the tabbed
 * story (the diary first — it IS the case — then deadlines, tasks,
 * notes, documents, the working team, and for PARTNERS money and
 * history) in the reading column; the matter's facts, lifecycle, and a
 * team glance in the context rail, so "next hearing" and "who's on
 * this" survive however deep the diary scrolls.
 *
 * The active tab lives in the URL (?tab=…) and is DERIVED on every
 * render, validated against the caller's currently-allowed tab set —
 * never copied into state. That makes the role-resolution race
 * unrepresentable: while the caller's role is still loading, a deep
 * link to a partner tab renders the Diary, and the real tab appears
 * the moment the role confirms. The server refuses non-partners
 * regardless; the URL merely selects among tabs the caller may see.
 * An open document (?doc=…, T09.2) rides the same contract and swaps
 * the whole frame for the in-app reading view (DocumentViewer).
 *
 * Editing facts is full-spec replacement through CaseForm; the
 * lifecycle moves ONLY through its own control (a spec edit cannot
 * close a matter — DD-A6's single-write-path rule, visible in the UI).
 */

import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { AskAiAboutCaseButton } from "../../assistant/AskAiButton.js";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { DetailLayout } from "../../components/DetailLayout.js";
import { FormError, InlineSelect } from "../../components/Field.js";
import { MetaItem, MetaPanel } from "../../components/MetaPanel.js";
import {
  CaseLifecycle,
  type Case,
} from "../../gen/stigmer/law/case/v1/case_pb.js";
import { RoleOnCase } from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import {
  caseLifecycleLabel,
  clientRoleLabel,
  formatCalendarDate,
  forumKindLabel,
} from "../../lib/format.js";
import { isPartnerRole, useMyRole } from "../../session/use-firm-member.js";
import { useFirmRoster } from "../members/queries.js";
import { useClient } from "../clients/queries.js";
import { CaseDeadlines } from "./CaseDeadlines.js";
import { CaseDiary } from "./CaseDiary.js";
import { CaseActs } from "./CaseActs.js";
import { CaseDocuments } from "./CaseDocuments.js";
import { DocumentViewer } from "./DocumentViewer.js";
import { CaseForm } from "./CaseForm.js";
import { CaseHistory } from "./CaseHistory.js";
import { CaseMembersSection } from "./CaseMembersSection.js";
import { CaseMoney } from "./CaseMoney.js";
import { CaseNotes } from "./CaseNotes.js";
import { CaseTasks } from "./CaseTasks.js";
import { useCase, useCaseMembers, useUpdateCase, useUpdateCaseLifecycle } from "./queries.js";

const TABS = ["Diary", "Deadlines", "Tasks", "Notes", "Documents", "Acts", "Team"] as const;
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

/**
 * The rail's read-only team glance: who works this matter, always
 * visible beside the story. Management lives on the Team tab; the one
 * action here is the jump to it. Shares the Team tab's query — React
 * Query serves both from one fetch.
 */
function TeamGlance(props: { caseId: string; leadMemberId: string; onManage: () => void }) {
  const members = useCaseMembers(props.caseId);
  const roster = useFirmRoster();

  return (
    <section aria-label="Team glance" className="rounded-card border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Team</h2>
        <Button onClick={props.onManage}>Manage</Button>
      </div>
      {members.isPending && <Loading label="Loading the team…" />}
      {members.isError && (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      )}
      {members.isSuccess && members.data.items.length === 0 && (
        <p className="text-xs text-ink-muted">Nobody on this matter yet.</p>
      )}
      {members.isSuccess && members.data.items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {members.data.items.map((membership) => {
            const memberId = membership.spec?.memberId ?? "";
            return (
              <li key={membership.metadata?.id} className="flex items-center gap-2">
                <span className="min-w-0 truncate">
                  {roster.data?.nameOf(memberId) ?? memberId}
                </span>
                <span className="text-xs text-ink-muted">
                  {membership.spec?.roleOnCase === RoleOnCase.CLERK ? "Clerk" : "Lawyer"}
                </span>
                {memberId === props.leadMemberId && <Badge>Lead</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function CaseDetailScreen() {
  const { id = "" } = useParams();
  const matter = useCase(id);
  const client = useClient(matter.data?.spec?.clientId ?? "");
  const updateCase = useUpdateCase();
  const partner = isPartnerRole(useMyRole());
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);

  const tabs: readonly Tab[] = partner ? [...TABS, ...PARTNER_TABS] : TABS;
  // Derived, never stored: unknown or not-yet-allowed values render the
  // Diary; the URL stays authoritative when the role resolves.
  const requested = searchParams.get("tab");
  const tab: Tab = tabs.find((name) => name === requested) ?? "Diary";

  // The open document, derived the same way (T09.2). The id is not
  // validated here — DocumentService.Get authorizes membership, so a
  // foreign or invented id fails closed with the server's sentence
  // inside the reading frame.
  const viewedDocumentId = searchParams.get("doc");
  const requestedPage = Number(searchParams.get("page"));
  const documentPage =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : undefined;

  function onSelectTab(name: Tab) {
    setSearchParams(
      (params) => {
        if (name === "Diary") params.delete("tab");
        else params.set("tab", name);
        return params;
      },
      { replace: true },
    );
  }

  function onCloseDocument() {
    // Replace, not push: opening PUSHED, so open→close leaves history
    // exactly where it started; landing on the Documents tab keeps a
    // deep-linked close from dropping the reader onto the Diary.
    setSearchParams(
      (params) => {
        params.delete("doc");
        params.delete("page");
        params.set("tab", "Documents");
        return params;
      },
      { replace: true },
    );
  }

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

  // The reading frame swaps the WHOLE detail frame (the edit-mode
  // precedent) — a court order deserves the full content width, not a
  // column beside the rail.
  if (viewedDocumentId) {
    return (
      <DocumentViewer
        documentId={viewedDocumentId}
        page={documentPage}
        onClose={onCloseDocument}
      />
    );
  }

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
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{spec.fileNumber}</h1>
        <AskAiAboutCaseButton fileNumber={spec.fileNumber} />
      </div>

      <DetailLayout
        railLabel="Matter facts"
        rail={
          <>
            <MetaPanel footer={<Button onClick={() => setEditing(true)}>Edit details</Button>}>
              <MetaItem label="Client">
                <Link
                  to={`/clients/${spec.clientId}`}
                  className="font-medium text-brand hover:underline"
                >
                  {client.data?.spec?.displayName ?? "…"}
                </Link>{" "}
                <span className="text-xs text-ink-muted">
                  ({clientRoleLabel(spec.clientRole)})
                </span>
              </MetaItem>
              {parties.length > 0 && <MetaItem label="Versus">{parties.join("; ")}</MetaItem>}
              <MetaItem label="Forum">
                {forumKindLabel(spec.forum?.forumKind ?? 0)}
                {spec.forum?.name && ` — ${spec.forum.name}`}
                {spec.forum?.bench && `, ${spec.forum.bench}`}
              </MetaItem>
              {spec.stage && <MetaItem label="Stage">{spec.stage}</MetaItem>}
              {spec.caseType && <MetaItem label="Case type">{spec.caseType}</MetaItem>}
              <MetaItem label="Court number">
                {spec.courtCaseNumber || "Not assigned yet"}
              </MetaItem>
              {spec.cnr && <MetaItem label="CNR">{spec.cnr}</MetaItem>}
              <MetaItem label="Next hearing">
                {matter.data.status?.nextHearingDate ? (
                  formatCalendarDate(matter.data.status.nextHearingDate)
                ) : (
                  <Badge tone="warn">No next date — nothing is scheduled on this matter</Badge>
                )}
              </MetaItem>
              <MetaItem label="Matter status">
                <LifecycleControl matter={matter.data} />
              </MetaItem>
            </MetaPanel>
            <TeamGlance
              caseId={id}
              leadMemberId={spec.leadLawyerId}
              onManage={() => onSelectTab("Team")}
            />
          </>
        }
      >
        <nav aria-label="Matter sections" className="flex flex-wrap gap-1 border-b border-line">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelectTab(name)}
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
        {tab === "Acts" && <CaseActs caseId={id} />}
        {tab === "Team" && <CaseMembersSection caseId={id} leadMemberId={spec.leadLawyerId} />}
        {tab === "Money" && partner && <CaseMoney caseId={id} />}
        {tab === "History" && partner && <CaseHistory caseId={id} />}
      </DetailLayout>
    </section>
  );
}
