/**
 * Task screen behavior with a faked client surface (the ApiClients
 * context is the seam — screens never construct transports). Server
 * facts arrive exactly as the contract sends them: derived case_number
 * and overdue on status (D9), list order as given, bigint total_count.
 */

import { create } from "@bufbuild/protobuf";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiClientsProvider, type ApiClients } from "../../../api/clients.js";
import {
  ListTasksResponseSchema,
  TaskPriority,
  TaskSchema,
  TaskState,
  type Task,
} from "../../../gen/stigmer/law/task/v1/task_pb.js";
import { CaseSchema } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import {
  ListUsersResponseSchema,
  UserSchema,
  type User,
} from "../../../gen/stigmer/identity/user/v1/user_pb.js";
import type { SessionKit } from "../../../session/session.js";
import { SessionProvider } from "../../../session/use-session.js";
import { HomeScreen } from "../../home/HomeScreen.js";
import { TaskCreateScreen } from "../TaskCreateScreen.js";

const ME: User = create(UserSchema, {
  metadata: { id: "usr_me" },
  spec: { email: "asha@acme.example", name: "Asha Rao" },
});

function fakeSessionKit(): SessionKit {
  // Stable snapshot reference — useSyncExternalStore loops on a getState
  // that manufactures a new object per call (the same reason the real
  // kit holds one state object between transitions).
  const state = { status: "signed-in", user: ME } as const;
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    getAccessToken: async () => "tok_test",
    invalidateAccessToken: () => undefined,
  };
}

function makeTask(overrides: {
  id: string;
  title: string;
  caseNumber?: string;
  dueDate?: string;
  overdue?: boolean;
  state?: TaskState;
  priority?: TaskPriority;
}): Task {
  return create(TaskSchema, {
    metadata: { id: overrides.id },
    spec: {
      caseId: "case_1",
      title: overrides.title,
      dueDate: overrides.dueDate,
      priority: overrides.priority ?? TaskPriority.MEDIUM,
    },
    status: {
      state: overrides.state ?? TaskState.OPEN,
      overdue: overrides.overdue ?? false,
      caseNumber: overrides.caseNumber ?? "WP-1/2026",
    },
  });
}

/** Screens under the real providers, with the client surface faked. */
function renderScreen(
  clients: Partial<ApiClients>,
  routes: { path: string; element: ReactNode }[],
  initialPath: string,
) {
  const router = createMemoryRouter(
    routes.map((r) => ({ path: r.path, element: r.element })),
    { initialEntries: [initialPath] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider kit={fakeSessionKit()}>
        <ApiClientsProvider clients={clients as ApiClients}>
          <RouterProvider router={router} />
        </ApiClientsProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return router;
}

const emptyUsers = {
  list: vi.fn(async () =>
    create(ListUsersResponseSchema, { items: [ME], totalCount: 1n }),
  ),
};

describe("HomeScreen (My Tasks — FR-APP-001 transfer)", () => {
  it("renders server facts as received: case number, DD/MM/YYYY due date, overdue badge", async () => {
    const tasks = {
      list: vi.fn(async () =>
        create(ListTasksResponseSchema, {
          items: [
            makeTask({
              id: "task_1",
              title: "Draft rejoinder",
              caseNumber: "WP-1234/2026",
              dueDate: "2026-08-20",
              overdue: true,
            }),
          ],
          totalCount: 1n,
        }),
      ),
    };
    renderScreen(
      { tasks: tasks as never, users: emptyUsers as never },
      [{ path: "/", element: <HomeScreen /> }],
      "/",
    );

    expect(await screen.findByText("Draft rejoinder")).toBeInTheDocument();
    expect(screen.getByText("WP-1234/2026")).toBeInTheDocument();
    expect(screen.getByText("Due 20/08/2026")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    // The contract's My Tasks default: NO filter fields sent.
    expect(tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "", caseId: "", pageOffset: 0 }),
    );
  });

  it("failure path: shows the server sentence and recovers on retry", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("[unavailable] connection lost"))
      .mockResolvedValue(create(ListTasksResponseSchema, { items: [], totalCount: 0n }));
    renderScreen(
      { tasks: { list } as never, users: emptyUsers as never },
      [{ path: "/", element: <HomeScreen /> }],
      "/",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/connection lost/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No tasks assigned to you")).toBeInTheDocument();
  });
});

describe("TaskCreateScreen (FR-TASK-001; standalone entrance)", () => {
  it("resolves the typed court case number through the natural-key Get, then creates", async () => {
    const resolved = create(CaseSchema, {
      metadata: { id: "case_77" },
      spec: { caseNumber: "WP-77/2026", clientName: "Acme", caseType: "writ", assignedLawyerId: "usr_me" },
    });
    const cases = { get: vi.fn(async () => resolved) };
    const created = makeTask({ id: "task_new", title: "New one" });
    const tasks = { create: vi.fn(async (_input: Task) => created) };

    const router = renderScreen(
      { tasks: tasks as never, cases: cases as never, users: emptyUsers as never },
      [
        { path: "/tasks/new", element: <TaskCreateScreen /> },
        { path: "/tasks/:id", element: <p>detail screen</p> },
      ],
      "/tasks/new",
    );

    await userEvent.type(screen.getByLabelText("Case number"), "WP-77/2026");
    await userEvent.type(screen.getByLabelText("Title"), "New one");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/task_new"));
    expect(cases.get).toHaveBeenCalledWith({ caseNumber: "WP-77/2026" });
    const sent = tasks.create.mock.calls[0]?.[0] as Task;
    expect(sent.spec?.caseId).toBe("case_77");
    expect(sent.spec?.title).toBe("New one");
  });

  it("a typo'd case number shows the server's not-found sentence and creates nothing", async () => {
    const cases = {
      get: vi.fn(async () => {
        throw new Error("[not_found] Case 'WP-99/2026' not found");
      }),
    };
    const tasks = { create: vi.fn() };
    renderScreen(
      { tasks: tasks as never, cases: cases as never, users: emptyUsers as never },
      [{ path: "/tasks/new", element: <TaskCreateScreen /> }],
      "/tasks/new",
    );

    await userEvent.type(screen.getByLabelText("Case number"), "WP-99/2026");
    await userEvent.type(screen.getByLabelText("Title"), "Doomed");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/WP-99\/2026.*not found/);
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
