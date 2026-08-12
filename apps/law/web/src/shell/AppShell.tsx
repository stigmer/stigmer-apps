/**
 * The signed-in frame, on the Stigmer console's pattern: no top bar — a
 * full-window flex row of one collapsible left sidebar (brand, primary
 * navigation, the caller in a footer band), the content column, and the
 * Ask AI dock on the right edge (AssistantDock — content reflows around
 * it, which is why the content wrapper is a CSS @container).
 * Screens render into a centered, width-capped container (the console's
 * own convention — DD-005): one width for every screen means zero layout
 * shift between list and detail, and no screen can forget to cap itself.
 * Content-scoped caps (forms, search boxes) stay inside the screens.
 *
 * The sidebar collapses on every viewport (a floating reopen button
 * appears when closed); below lg it overlays the content instead of
 * pushing it, and choosing a destination closes it — the corridor-phone
 * case. State is deliberately session-local: no persistence until a real
 * user asks for it.
 */

import { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  BookOpen,
  Briefcase,
  Building2,
  House,
  Inbox,
  IndianRupee,
  ListChecks,
  LogOut,
  PanelLeft,
  Users,
} from "lucide-react";
import { AskAiButton } from "../assistant/AskAiButton.js";
import { AssistantDock } from "../assistant/AssistantDock.js";
import { AssistantProvider } from "../assistant/assistant-context.js";
import { useUnreadCount } from "../screens/inbox/queries.js";
import { isPartnerRole, useMyRole } from "../session/use-firm-member.js";
import { useCurrentUser, useSessionKit } from "../session/use-session.js";

const DESKTOP = "(min-width: 1024px)";

/** aria-current styling comes free with NavLink; words, not color alone. */
function navClass(props: { isActive: boolean }): string {
  return props.isActive
    ? "flex h-8 items-center gap-2 rounded-card px-2 text-sm font-medium bg-brand-surface text-brand"
    : "flex h-8 items-center gap-2 rounded-card px-2 text-sm text-sidebar-ink hover:bg-brand-surface";
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

  // Open on a desk, closed in the corridor — sized once at mount; the
  // toggle owns it from there.
  const [open, setOpen] = useState(() => window.matchMedia(DESKTOP).matches);

  /** Below lg the sidebar overlays content, so navigation closes it. */
  function onNavigate() {
    if (!window.matchMedia(DESKTOP).matches) setOpen(false);
  }

  async function onSignOut() {
    await kit.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <AssistantProvider>
    <div className="flex h-screen">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          className="fixed top-2 left-2 z-40 flex size-8 items-center justify-center rounded-card border border-line bg-surface text-ink-muted hover:text-ink"
        >
          <PanelLeft className="size-4" aria-hidden="true" />
        </button>
      )}

      {/* Below lg the open sidebar floats over the content; the backdrop
          is the tap-anywhere way back out. */}
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-ink/20 lg:hidden"
        />
      )}

      <div
        className={`shrink-0 overflow-hidden border-r border-sidebar-line bg-sidebar transition-[width] duration-200 ease-in-out motion-reduce:transition-none ${
          open ? "w-64" : "w-0"
        } max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:shadow-lg`}
      >
        <div className="flex h-full w-64 flex-col">
          <div className="flex h-12 items-center justify-between pr-2 pl-4">
            <Link to="/" onClick={onNavigate} className="text-sm font-semibold">
              Stigmer Law
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              className="flex size-8 items-center justify-center rounded-card text-sidebar-muted hover:text-ink"
            >
              <PanelLeft className="size-4" aria-hidden="true" />
            </button>
          </div>

          <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            <NavLink to="/" end className={navClass} onClick={onNavigate}>
              <House className="size-4" aria-hidden="true" />
              Home
            </NavLink>
            <NavLink to="/cases" className={navClass} onClick={onNavigate}>
              <Briefcase className="size-4" aria-hidden="true" />
              Cases
            </NavLink>
            <NavLink to="/clients" className={navClass} onClick={onNavigate}>
              <Users className="size-4" aria-hidden="true" />
              Clients
            </NavLink>
            <NavLink to="/tasks" className={navClass} onClick={onNavigate}>
              <ListChecks className="size-4" aria-hidden="true" />
              Tasks
            </NavLink>
            {partner && (
              <NavLink to="/money" className={navClass} onClick={onNavigate}>
                <IndianRupee className="size-4" aria-hidden="true" />
                Money
              </NavLink>
            )}
            <NavLink to="/members" className={navClass} onClick={onNavigate}>
              <Building2 className="size-4" aria-hidden="true" />
              The firm
            </NavLink>
            <NavLink
              to="/inbox"
              className={navClass}
              onClick={onNavigate}
              aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread` : "Inbox"}
            >
              <Inbox className="size-4" aria-hidden="true" />
              Inbox
              {unreadCount > 0 && (
                <span
                  aria-hidden="true"
                  className="ml-auto rounded-card bg-brand px-1.5 py-0.5 text-xs font-medium text-on-brand"
                >
                  {unreadCount}
                </span>
              )}
            </NavLink>
            {/* Every role gets the Guide: it EXPLAINS the boundaries
                (why a clerk's sidebar has no Money entry), so hiding
                it from anyone would defeat it. */}
            <NavLink to="/guide" className={navClass} onClick={onNavigate}>
              <BookOpen className="size-4" aria-hidden="true" />
              Guide
            </NavLink>
            {/* The assistant entry sits with navigation (it goes
                somewhere: the panel), rendered only when the deployment
                has an assistant configured — and only below lg, where
                the dock's right-edge strip does not exist (the button
                owns that rule; see AskAiButton). */}
            <AskAiButton />
          </nav>

          <div className="flex items-center gap-1 border-t border-sidebar-line p-2">
            <Link
              to="/profile"
              onClick={onNavigate}
              className="min-w-0 flex-1 truncate rounded-card px-2 py-1.5 text-sm text-sidebar-ink hover:bg-brand-surface"
            >
              {user.spec?.name || user.spec?.email}
            </Link>
            <button
              type="button"
              onClick={() => void onSignOut()}
              aria-label="Sign out"
              title="Sign out"
              className="flex size-8 shrink-0 items-center justify-center rounded-card text-sidebar-muted hover:bg-brand-surface hover:text-brand"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* tabIndex: main IS the scroll container, and a screen made of
          pure prose (the Guide) has no focusable children — without a
          tab stop a keyboard user cannot scroll it at all
          (axe: scrollable-region-focusable). */}
      <main tabIndex={0} aria-label="Content" className="min-w-0 flex-1 overflow-y-auto">
        {/* @container: screens size themselves by the width the content
            ACTUALLY has (the assistant dock takes its share from this
            column), never by the window — see DetailLayout. */}
        <div className="mx-auto w-full max-w-6xl p-4 @container">
          <Outlet />
        </div>
      </main>

      {/* A flex sibling of the content column: the docked assistant
          pushes, never overlays. Mounted at the shell so the panel
          survives navigation; the heavy chunk loads only on the first
          expand (AssistantDock). */}
      <AssistantDock />
    </div>
    </AssistantProvider>
  );
}
