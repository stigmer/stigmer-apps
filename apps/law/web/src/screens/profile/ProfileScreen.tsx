/**
 * Profile (FR-USER-001): read-only identity — the contract exposes no
 * self-service update or password change (reset is an operator action,
 * FR-ADMIN-001), so the screen says who to ask instead of pretending.
 */

import { useNavigate } from "react-router-dom";
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
        To change your details or reset your password, ask your administrator.
      </p>
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
