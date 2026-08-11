/**
 * Profile (FR-USER-001): read-only identity, plus the one self-service
 * credential act (DD-003 D4): changing your own password, with the
 * current one as proof of possession. Identity DETAILS (email, phone —
 * the WhatsApp binding) stay administrator-managed: self-service there
 * would be an impersonation lever (the proto's Update rationale).
 */

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectError } from "@connectrpc/connect";
import { Button } from "../../components/Button.js";
import { FormError, Input, Label } from "../../components/Field.js";
import { useCurrentUser, useSessionKit } from "../../session/use-session.js";

export function ProfileScreen() {
  const user = useCurrentUser();
  const kit = useSessionKit();
  const navigate = useNavigate();

  async function onSignOut() {
    await kit.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <section aria-label="Profile" className="max-w-lg">
      <h1 className="mb-4 text-lg font-semibold">Profile</h1>
      <dl className="rounded-card border border-line bg-surface p-4">
        <div className="mb-3">
          <dt className="text-xs text-ink-muted">Name</dt>
          <dd>{user.spec?.name || "—"}</dd>
        </div>
        <div className="mb-3">
          <dt className="text-xs text-ink-muted">Email</dt>
          <dd>{user.spec?.email}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Phone (for WhatsApp)</dt>
          <dd>{user.spec?.phone || "Not set"}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-ink-muted">
        To change your details, ask your managing partner.
      </p>

      <ChangePasswordForm />

      <div className="mt-4">
        <Button variant="danger" onClick={() => void onSignOut()}>
          Sign out
        </Button>
      </div>
    </section>
  );
}

function ChangePasswordForm() {
  const kit = useSessionKit();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDone(false);
    if (next !== confirm) {
      setError("The new passwords do not match");
      return;
    }
    setPending(true);
    try {
      // The kit changes the password AND re-signs-in underneath — the
      // server-side session reset never surfaces here.
      await kit.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Change password"
      className="mt-4 rounded-card border border-line bg-surface p-4"
    >
      <h2 className="mb-3 text-sm font-semibold">Change password</h2>

      <Label htmlFor="current-password">Current password</Label>
      <Input
        id="current-password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />

      <Label htmlFor="next-password">New password</Label>
      <Input
        id="next-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />

      <Label htmlFor="confirm-next-password">Repeat the new password</Label>
      <Input
        id="confirm-next-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />

      <FormError message={error} />
      {done && (
        <p role="status" className="mb-4 rounded-card bg-brand-surface px-3 py-2 text-sm">
          Your password is changed.
        </p>
      )}

      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
