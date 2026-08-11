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
      <h1 className="mb-4 text-xl font-semibold">Profile</h1>
      <dl className="rounded-card border border-line bg-surface p-4">
        <div className="mb-3">
          <dt className="text-sm text-ink-muted">Name</dt>
          <dd>{user.spec?.name || "—"}</dd>
        </div>
        <div className="mb-3">
          <dt className="text-sm text-ink-muted">Email</dt>
          <dd>{user.spec?.email}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-muted">Phone (for WhatsApp)</dt>
          <dd>{user.spec?.phone || "Not set"}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-ink-muted">
        To change your details, ask your managing partner.
      </p>

      <ChangePasswordForm />

      <button
        type="button"
        onClick={() => void onSignOut()}
        className="mt-4 h-11 rounded-card border border-line px-4 font-medium text-danger hover:bg-danger-surface"
      >
        Sign out
      </button>
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
      <h2 className="mb-3 font-medium">Change password</h2>

      <label htmlFor="current-password" className="mb-1 block text-sm font-medium">
        Current password
      </label>
      <input
        id="current-password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
      />

      <label htmlFor="next-password" className="mb-1 block text-sm font-medium">
        New password
      </label>
      <input
        id="next-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
      />

      <label htmlFor="confirm-next-password" className="mb-1 block text-sm font-medium">
        Repeat the new password
      </label>
      <input
        id="confirm-next-password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
      />

      {error && (
        <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mb-4 rounded-card bg-brand-surface px-3 py-2 text-sm">
          Your password is changed.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-card border border-line px-4 font-medium hover:bg-brand-surface disabled:opacity-60"
      >
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
