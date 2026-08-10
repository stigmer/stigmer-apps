/**
 * The firm roster (FR-MEMBER-001), grouped by role — read-only:
 * accounts and profiles are provisioned through the operator path
 * (FR-AUTH-002), and deactivation is an operator/managing-partner act
 * performed there, not a button beside a colleague's name.
 */

import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { FirmRole } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { firmRoleLabel } from "../../lib/format.js";
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
  const roster = useFirmRoster();

  return (
    <section aria-label="The firm">
      <h1 className="mb-4 text-xl font-semibold">The firm</h1>
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
                <h2 className="mb-2 font-medium">{firmRoleLabel(role)}</h2>
                <ul>
                  {members.map((member) => (
                    <li
                      key={member.metadata?.id}
                      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-b-0"
                    >
                      <span className="font-medium">
                        {member.status?.userName || member.status?.userEmail}
                      </span>
                      <span className="text-sm text-ink-muted">{member.status?.userEmail}</span>
                      {member.spec?.barEnrollmentNumber && (
                        <span className="text-sm text-ink-faint">
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
            Accounts, roles, and deactivation are managed through the firm's operator — there is
            deliberately no self-service here.
          </p>
        </div>
      )}
    </section>
  );
}
