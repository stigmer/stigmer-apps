/**
 * Task screen behavior on the rebuilt contract: assignees are
 * FirmMembers (the roster is the picker), the derived reference is the
 * firm FILE number, and the standalone entrance resolves it through the
 * natural-key Get. Server facts arrive exactly as the contract sends
 * them: derived case_file_number and overdue on status, list order as
 * given, bigint total_count.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ListTasksResponseSchema,
  TaskPriority,
  TaskSchema,
  TaskState,
  type Task,
} from "../../../gen/stigmer/law/task/v1/task_pb.js";
import { CaseSchema, ClientRole } from "../../../gen/stigmer/law/case/v1/case_pb.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { TaskCreateScreen } from "../TaskCreateScreen.js";
import { TaskListScreen } from "../TaskListScreen.js";

function makeTask(overrides: {
  id: string;
  title: string;
  caseFileNumber?: string;
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
      caseFileNumber: overrides.caseFileNumber ?? "CS/2026/001",
    },
  });
}

describe("TaskListScreen (FR-TASK-001: My Tasks by contract)", () => {
  it("renders server facts as received: file number, DD/MM/YYYY due date, overdue badge", async () => {
    const tasks = {
      list: vi.fn(async () =>
        create(ListTasksResponseSchema, {
          items: [
            makeTask({
              id: "task_1",
              title: "Draft rejoinder",
              caseFileNumber: "CS/2026/042",
              dueDate: "2026-08-20",
              overdue: true,
            }),
          ],
          totalCount: 1n,
        }),
      ),
    };
    renderScreen(
      { tasks: tasks as never, firmMembers: fakeFirmMembers() as never },
      [{ path: "/tasks", element: <TaskListScreen /> }],
      "/tasks",
    );

    expect(await screen.findByText("Draft rejoinder")).toBeInTheDocument();
    expect(screen.getByText("CS/2026/042")).toBeInTheDocument();
    expect(screen.getByText("Due 20/08/2026")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    // The contract's My Tasks default: NO filter fields sent.
    expect(tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "", caseId: "", pageOffset: 0 }),
    );
  });

  it("picking a colleague names the scope explicitly with their FirmMember id", async () => {
    const tasks = {
      list: vi.fn(async () =>
        create(ListTasksResponseSchema, { items: [], totalCount: 0n }),
      ),
    };
    renderScreen(
      { tasks: tasks as never, firmMembers: fakeFirmMembers() as never },
      [{ path: "/tasks", element: <TaskListScreen /> }],
      "/tasks",
    );

    await screen.findByRole("option", { name: "Ravi Iyer" });
    await userEvent.selectOptions(screen.getByLabelText("Assigned to"), "fmem_ravi");
    await waitFor(() =>
      expect(tasks.list).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: "fmem_ravi" }),
      ),
    );
  });

  it("failure path: shows the server sentence and recovers on retry", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("[unavailable] connection lost"))
      .mockResolvedValue(create(ListTasksResponseSchema, { items: [], totalCount: 0n }));
    renderScreen(
      { tasks: { list } as never, firmMembers: fakeFirmMembers() as never },
      [{ path: "/tasks", element: <TaskListScreen /> }],
      "/tasks",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/connection lost/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No tasks here")).toBeInTheDocument();
  });
});

describe("TaskCreateScreen (FR-TASK-001; standalone entrance)", () => {
  const resolvedCase = create(CaseSchema, {
    metadata: { id: "case_77" },
    spec: {
      fileNumber: "WP/2026/77",
      clientId: "client_1",
      clientRole: ClientRole.PETITIONER,
      caseType: "writ",
      leadLawyerId: "fmem_me",
      forum: { name: "High Court" },
    },
  });

  it("resolves the typed FILE number through the natural-key Get, then creates", async () => {
    const cases = { get: vi.fn(async () => resolvedCase) };
    const created = makeTask({ id: "task_new", title: "New one" });
    const tasks = { create: vi.fn(async (_input: Task) => created) };

    const router = renderScreen(
      {
        tasks: tasks as never,
        cases: cases as never,
        firmMembers: fakeFirmMembers() as never,
      },
      [
        { path: "/tasks/new", element: <TaskCreateScreen /> },
        { path: "/tasks/:id", element: <p>detail screen</p> },
      ],
      "/tasks/new",
    );

    await userEvent.type(screen.getByLabelText("File number"), "WP/2026/77");
    await userEvent.type(screen.getByLabelText("Title"), "New one");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/tasks/task_new"));
    expect(cases.get).toHaveBeenCalledWith({ fileNumber: "WP/2026/77" });
    const sent = tasks.create.mock.calls[0]?.[0] as Task;
    expect(sent.spec?.caseId).toBe("case_77");
    expect(sent.spec?.title).toBe("New one");
  });

  it("a typo'd file number shows the server's not-found sentence and creates nothing", async () => {
    const cases = {
      get: vi.fn(async () => {
        throw new Error("[not_found] Case 'WP/2026/99' not found");
      }),
    };
    const tasks = { create: vi.fn() };
    renderScreen(
      {
        tasks: tasks as never,
        cases: cases as never,
        firmMembers: fakeFirmMembers() as never,
      },
      [{ path: "/tasks/new", element: <TaskCreateScreen /> }],
      "/tasks/new",
    );

    await userEvent.type(screen.getByLabelText("File number"), "WP/2026/99");
    await userEvent.type(screen.getByLabelText("Title"), "Doomed");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/WP\/2026\/99.*not found/);
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
