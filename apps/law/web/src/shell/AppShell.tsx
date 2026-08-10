/**
 * The signed-in frame: one header carrying navigation (grows through
 * T04b.2–4: Home / Cases / Tasks / Inbox / Profile — the FR-APP-002
 * transfer) and the session exit. Screens render into the outlet.
 */

import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useUnreadCount } from "../screens/inbox/queries.js";
import { isPartnerRole, useMyRole } from "../session/use-firm-member.js";
import { useCurrentUser, useSessionKit } from "../session/use-session.js";

/** aria-current styling comes free with NavLink; words, not color alone. */
function navClass(props: { isActive: boolean }): string {
  return props.isActive
    ? "flex h-11 items-center rounded-card px-2 font-medium text-brand"
    : "flex h-11 items-center rounded-card px-2 text-ink-muted hover:text-ink";
}

export function AppShell() {
  const user = useCurrentUser();
  const kit = useSessionKit();
  const navigate = useNavigate();
  // The caller's firm role decides which nav the shell offers: money is
  // a partner surface (the server refuses everyone else — the UI only
  // hides what would be refused).
  const partner = isPartnerRole(useMyRole());
  // The derived unread badge (FR-NOTIF-004): the server's total_count,
  // never a client-side count.
  const unread = useUnreadCount();
  const unreadCount = unread.data ?? 0;

  async function onSignOut() {
    await kit.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <Link to="/" className="font-semibold">
            Stigmer Law
          </Link>
          <nav aria-label="Primary" className="flex flex-1 items-center gap-2 text-sm">
            <NavLink to="/" end className={navClass}>
              Home
            </NavLink>
            <NavLink to="/cases" className={navClass}>
              Cases
            </NavLink>
            <NavLink to="/clients" className={navClass}>
              Clients
            </NavLink>
            <NavLink to="/tasks" className={navClass}>
              Tasks
            </NavLink>
            {partner && (
              <NavLink to="/money" className={navClass}>
                Money
              </NavLink>
            )}
            <NavLink to="/members" className={navClass}>
              The firm
            </NavLink>
            <NavLink
              to="/inbox"
              className={navClass}
              aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread` : "Inbox"}
            >
              Inbox
              {unreadCount > 0 && (
                <span
                  aria-hidden="true"
                  className="ml-1 rounded-card bg-brand px-1.5 py-0.5 text-xs font-medium text-on-brand"
                >
                  {unreadCount}
                </span>
              )}
            </NavLink>
          </nav>
          <Link to="/profile" className="text-sm text-ink-muted hover:text-ink">
            {user.spec?.name || user.spec?.email}
          </Link>
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
