/**
 * The firm (FR-MEMBER-001), grouped by role. Two shapes of the same
 * screen, decided by the caller's role (DD-003 D4):
 *
 * - Everyone: the read-only roster (names, roles, bar numbers).
 * - The managing partner: the management surface — add members (with a
 *   shown-once activation code to hand over), change roles, reset
 *   access, deactivate/reactivate. The server is the authority on every
 *   rule; this screen only hides what would be refused (a member's own
 *   deactivate button, the whole surface below managing partner) and
 *   shows the server's sentences verbatim when a rule answers.
 */

import { useState } from "react";
import { ConnectError } from "@connectrpc/connect";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { FormError, InlineSelect } from "../../components/Field.js";
import { PageHeader } from "../../components/PageHeader.js";
import {
  FirmRole,
  type FirmMember,
} from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { firmRoleLabel } from "../../lib/format.js";
import { isManagingPartnerRole, useMyRole } from "../../session/use-firm-member.js";
import { useCurrentUser } from "../../session/use-session.js";
import { ActivationCodeCard } from "./ActivationCodeCard.js";
import { AddMemberForm } from "./AddMemberForm.js";
import { useResetAccess, useUpdateMember, type IssuedActivation } from "./mutations.js";
import { useFirmRoster } from "./queries.js";

/** Seniority order for display — a presentation fact, not a wire one. */
const ROLE_ORDER: readonly FirmRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
  FirmRole.ASSOCIATE,
  FirmRole.JUNIOR,
  FirmRole.CLERK,
  FirmRole.OFFICE_STAFF,
];

export function RosterScreen() {
  const manager = isManagingPartnerRole(useMyRole());
  return manager ? <ManagedRoster /> : <ReadOnlyRoster />;
}

/* ------------------------- everyone's view -------------------------- */

function ReadOnlyRoster() {
  const roster = useFirmRoster();
  return (
    <section aria-label="The firm">
      <PageHeader title="The firm" />
      {roster.isPending && <Loading label="Loading the roster…" />}
      {roster.isError && (
        <ErrorState error={roster.error} onRetry={() => void roster.refetch()} />
      )}
      {roster.isSuccess && roster.data.members.length === 0 && (
        <EmptyState title="No firm members yet" />
      )}
      {roster.isSuccess && roster.data.members.length > 0 && (
        <div className="grid gap-4">
          {ROLE_ORDER.map((role) => {
            const members = roster.data.members.filter((m) => m.spec?.role === role);
            if (members.length === 0) return null;
            return (
              <section
                key={role}
                aria-label={firmRoleLabel(role)}
                className="rounded-card border border-line bg-surface p-4"
              >
                <h2 className="mb-2 text-sm font-semibold">{firmRoleLabel(role)}</h2>
                <ul>
                  {members.map((member) => (
                    <li
                      key={member.metadata?.id}
                      className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 last:border-b-0"
                    >
                      <span className="font-medium">
                        {member.status?.userName || member.status?.userEmail}
                      </span>
                      <span className="text-xs text-ink-muted">{member.status?.userEmail}</span>
                      {member.spec?.barEnrollmentNumber && (
                        <span className="text-xs text-ink-faint">
                          Bar no. {member.spec.barEnrollmentNumber}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="text-sm text-ink-muted">
            Accounts, roles, and access are managed by the firm's managing partner.
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------- the managing partner's view -------------------- */

function ManagedRoster() {
  // The historical register: deactivated members stay visible here —
  // reactivation has to have somewhere to live.
  const roster = useFirmRoster({ includeInactive: true });
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<IssuedActivation | undefined>();

  return (
    <section aria-label="The firm">
      <PageHeader title="The firm">
        {!adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </PageHeader>

      {issued && <ActivationCodeCard issued={issued} onDismiss={() => setIssued(undefined)} />}
      {adding && (
        <AddMemberForm
          onIssued={(activation) => {
            setIssued(activation);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {roster.isPending && <Loading label="Loading the roster…" />}
      {roster.isError && (
        <ErrorState error={roster.error} onRetry={() => void roster.refetch()} />
      )}
      {roster.isSuccess && roster.data.members.length === 0 && (
        <EmptyState title="No firm members yet" />
      )}
      {roster.isSuccess && roster.data.members.length > 0 && (
        <div className="grid gap-4">
          {ROLE_ORDER.map((role) => {
            const members = roster.data.members.filter((m) => m.spec?.role === role);
            if (members.length === 0) return null;
            return (
              <section
                key={role}
                aria-label={firmRoleLabel(role)}
                className="rounded-card border border-line bg-surface p-4"
              >
                <h2 className="mb-2 text-sm font-semibold">{firmRoleLabel(role)}</h2>
                <ul>
                  {members.map((member) => (
                    <ManagedMemberRow
                      key={member.metadata?.id}
                      member={member}
                      onIssued={setIssued}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="text-sm text-ink-muted">
            New members set their own passwords with the activation code you hand them. Nobody —
            including you — can see or set anyone else's password.
          </p>
        </div>
      )}
    </section>
  );
}

function ManagedMemberRow(props: {
  member: FirmMember;
  onIssued: (issued: IssuedActivation) => void;
}) {
  const me = useCurrentUser();
  const update = useUpdateMember();
  const reset = useResetAccess();
  const [error, setError] = useState<string | undefined>();

  const { member } = props;
  const active = member.spec?.active === true;
  const isSelf = member.spec?.userId === me.metadata?.id;
  const displayName = member.status?.userName || member.status?.userEmail || "";
  const email = member.status?.userEmail ?? "";

  async function run(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <li className="border-b border-line py-1.5 last:border-b-0">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
        <span className={active ? "font-medium" : "font-medium text-ink-faint"}>
          {displayName}
        </span>
        <span className="text-xs text-ink-muted">{email}</span>
        {!active && <Badge tone="danger">Deactivated</Badge>}
        <span className="flex-1" />
        {active && (
          <>
            <label className="sr-only" htmlFor={`role-${member.metadata?.id}`}>
              Role of {displayName}
            </label>
            <InlineSelect
              id={`role-${member.metadata?.id}`}
              value={member.spec?.role}
              disabled={update.isPending}
              onChange={(e) =>
                void run(() =>
                  update.mutateAsync({
                    member,
                    changes: { role: Number(e.target.value) as FirmRole },
                  }),
                )
              }
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {firmRoleLabel(r)}
                </option>
              ))}
            </InlineSelect>
            <Button
              variant="outline"
              disabled={reset.isPending}
              onClick={() => void run(async () => props.onIssued(await reset.mutateAsync(email)))}
            >
              Reset access
            </Button>
            {/* One's own deactivate button does not exist — the server
                refuses it, and a control that always fails is a lie. */}
            {!isSelf && (
              <Button
                variant="danger"
                disabled={update.isPending}
                onClick={() =>
                  void run(() => update.mutateAsync({ member, changes: { active: false } }))
                }
              >
                Deactivate
              </Button>
            )}
          </>
        )}
        {!active && (
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={() =>
              void run(() => update.mutateAsync({ member, changes: { active: true } }))
            }
          >
            Reactivate
          </Button>
        )}
      </div>
      {error && (
        <div className="mt-1">
          <FormError message={error} />
        </div>
      )}
    </li>
  );
}
