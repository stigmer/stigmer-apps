/**
 * The route table (T04b D6) and the session gate. Client-routed paths are
 * served by the backend's SPA fallback (D1), so every route here is
 * reachable by deep link and by refresh.
 */

import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { ActivateScreen } from "./screens/activate/ActivateScreen.js";
import { LoginScreen } from "./screens/login/LoginScreen.js";
import { HomeScreen } from "./screens/home/HomeScreen.js";
import { NotFoundScreen } from "./screens/NotFoundScreen.js";
import { CaseCreateScreen } from "./screens/cases/CaseCreateScreen.js";
import { CaseDetailScreen } from "./screens/cases/CaseDetailScreen.js";
import { CaseListScreen } from "./screens/cases/CaseListScreen.js";
import { ClientCreateScreen } from "./screens/clients/ClientCreateScreen.js";
import { ClientDetailScreen } from "./screens/clients/ClientDetailScreen.js";
import { ClientListScreen } from "./screens/clients/ClientListScreen.js";
import { InboxScreen } from "./screens/inbox/InboxScreen.js";
import { RosterScreen } from "./screens/members/RosterScreen.js";
import { MoneyScreen } from "./screens/money/MoneyScreen.js";
import { ProfileScreen } from "./screens/profile/ProfileScreen.js";
import { TaskCreateScreen } from "./screens/tasks/TaskCreateScreen.js";
import { TaskDetailScreen } from "./screens/tasks/TaskDetailScreen.js";
import { TaskListScreen } from "./screens/tasks/TaskListScreen.js";
import { AppShell } from "./shell/AppShell.js";
import { useSessionState } from "./session/use-session.js";

/**
 * Router-level session gate: `starting` shows a neutral boot state (the
 * refresh-cookie resume is in flight — flashing the login form at a
 * signed-in user would be a lie), `signed-out` lands on /login, and only
 * `signed-in` renders the shell.
 */
function RequireSession() {
  const state = useSessionState();
  if (state.status === "starting") {
    return (
      <main className="flex min-h-screen items-center justify-center" aria-busy="true">
        <p className="text-ink-muted">Loading…</p>
      </main>
    );
  }
  if (state.status === "signed-out") {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

export function createAppRouter() {
  return createBrowserRouter([
    { path: "/login", element: <LoginScreen /> },
    // Anonymous by design (DD-003 D4): a new member has no session yet —
    // the activation code is their credential.
    { path: "/activate", element: <ActivateScreen /> },
    {
      element: <RequireSession />,
      children: [
        {
          element: <AppShell />,
          children: [
            { path: "/", element: <HomeScreen /> },
            { path: "/tasks", element: <TaskListScreen /> },
            { path: "/tasks/new", element: <TaskCreateScreen /> },
            { path: "/tasks/:id", element: <TaskDetailScreen /> },
            { path: "/cases", element: <CaseListScreen /> },
            { path: "/cases/new", element: <CaseCreateScreen /> },
            { path: "/cases/:id", element: <CaseDetailScreen /> },
            { path: "/clients", element: <ClientListScreen /> },
            { path: "/clients/new", element: <ClientCreateScreen /> },
            { path: "/clients/:id", element: <ClientDetailScreen /> },
            { path: "/money", element: <MoneyScreen /> },
            { path: "/members", element: <RosterScreen /> },
            { path: "/inbox", element: <InboxScreen /> },
            { path: "/profile", element: <ProfileScreen /> },
            { path: "*", element: <NotFoundScreen /> },
          ],
        },
      ],
    },
  ]);
}
