/**
 * Onboarding (DD-003 D4): the managing partner creates the account and
 * profile in one submit and receives the activation code to hand over.
 * Resumable: submitting an email that already exists continues the
 * earlier onboarding instead of failing it (mutations.ts).
 */

import { useState, type FormEvent } from "react";
import { ConnectError } from "@connectrpc/connect";
import { Button } from "../../components/Button.js";
import { InlineInput, InlineSelect, Label } from "../../components/Field.js";
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
      <h2 className="mb-3 text-sm font-semibold">Add a firm member</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="member-name">Name</Label>
          <InlineInput
            id="member-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full"
          />
        </div>
        <div>
          <Label htmlFor="member-email">Email</Label>
          <InlineInput
            id="member-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="block w-full"
          />
        </div>
        <div>
          <Label htmlFor="member-phone">
            Phone for WhatsApp{" "}
            <span className="font-normal text-ink-muted">(optional, +country code)</span>
          </Label>
          <InlineInput
            id="member-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91…"
            className="block w-full"
          />
        </div>
        <div>
          <Label htmlFor="member-role">Role</Label>
          <InlineSelect
            id="member-role"
            value={role}
            onChange={(e) => setRole(Number(e.target.value) as FirmRole)}
            className="block w-full"
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {firmRoleLabel(r)}
              </option>
            ))}
          </InlineSelect>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Button type="submit" variant="primary" disabled={onboard.isPending}>
          {onboard.isPending ? "Adding…" : "Add member and get code"}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
