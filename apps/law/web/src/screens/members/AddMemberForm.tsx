/**
 * Onboarding (DD-003 D4): the managing partner creates the account and
 * profile in one submit and receives the activation code to hand over.
 * Resumable: submitting an email that already exists continues the
 * earlier onboarding instead of failing it (mutations.ts).
 */

import { useState, type FormEvent } from "react";
import { ConnectError } from "@connectrpc/connect";
import { FirmRole } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { firmRoleLabel } from "../../lib/format.js";
import { useOnboardMember, type IssuedActivation } from "./mutations.js";

/** Assignable roles, seniority order — UNSPECIFIED is not a role. */
const ASSIGNABLE_ROLES: readonly FirmRole[] = [
  FirmRole.MANAGING_PARTNER,
  FirmRole.PARTNER,
  FirmRole.ASSOCIATE,
  FirmRole.JUNIOR,
  FirmRole.CLERK,
  FirmRole.OFFICE_STAFF,
];

export function AddMemberForm(props: {
  onIssued: (issued: IssuedActivation) => void;
  onCancel: () => void;
}) {
  const onboard = useOnboardMember();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<FirmRole>(FirmRole.ASSOCIATE);
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      props.onIssued(await onboard.mutateAsync({ name, email, phone, role }));
    } catch (err) {
      // The server's own sentence (validation, permission, lockout) —
      // never rewritten.
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Add a firm member"
      className="mb-4 rounded-card border border-line bg-surface p-4"
    >
      <h2 className="mb-3 font-medium">Add a firm member</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="member-name" className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input
            id="member-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block h-11 w-full rounded-card border border-line bg-surface px-3"
          />
        </div>
        <div>
          <label htmlFor="member-email" className="mb-1 block text-sm font-medium">
            Email
          </label>
          <input
            id="member-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="block h-11 w-full rounded-card border border-line bg-surface px-3"
          />
        </div>
        <div>
          <label htmlFor="member-phone" className="mb-1 block text-sm font-medium">
            Phone for WhatsApp <span className="font-normal text-ink-muted">(optional, +country code)</span>
          </label>
          <input
            id="member-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91…"
            className="block h-11 w-full rounded-card border border-line bg-surface px-3"
          />
        </div>
        <div>
          <label htmlFor="member-role" className="mb-1 block text-sm font-medium">
            Role
          </label>
          <select
            id="member-role"
            value={role}
            onChange={(e) => setRole(Number(e.target.value) as FirmRole)}
            className="block h-11 w-full rounded-card border border-line bg-surface px-3"
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {firmRoleLabel(r)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={onboard.isPending}
          className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
        >
          {onboard.isPending ? "Adding…" : "Add member and get code"}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-11 rounded-card px-3 text-sm text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
