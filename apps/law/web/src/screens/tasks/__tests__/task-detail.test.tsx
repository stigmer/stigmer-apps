/**
 * Task detail on the DD-005 frame: the facts live in the context rail
 * (a named landmark), the status select there is still the ONLY
 * lifecycle write path (UpdateStatus — FR-TASK-004), its failure
 * renders the server's sentence beside the control, and Edit swaps the
 * whole frame for the focused form (the uniform edit rule — a stale
 * rail beside a live form would lie).
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListTaskCommentsResponseSchema } from "../../../gen/stigmer/law/taskcomment/v1/taskcomment_pb.js";
import {
  TaskPriority,
  TaskSchema,
  TaskState,
  type Task,
} from "../../../gen/stigmer/law/task/v1/task_pb.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { TaskDetailScreen } from "../TaskDetailScreen.js";

const TASK: Task = create(TaskSchema, {
  metadata: { id: "task_1" },
  spec: {
    caseId: "case_1",
    title: "Draft rejoinder",
    description: "Cover grounds 1 to 4; cite the interim order.",
    assigneeId: "fmem_ravi",
    dueDate: "2026-08-20",
    priority: TaskPriority.HIGH,
  },
  status: { state: TaskState.OPEN, overdue: true, caseFileNumber: "CS/2026/042" },
});

function fakeClients(overrides?: { updateStatus?: ReturnType<typeof vi.fn> }) {
  return {
    tasks: {
      get: vi.fn(async () => TASK),
      updateStatus: overrides?.updateStatus ?? vi.fn(async () => TASK),
    },
    taskComments: {
      list: vi.fn(async () => create(ListTaskCommentsResponseSchema, { items: [] })),
    },
    firmMembers: fakeFirmMembers(),
  };
}

function renderDetail(clients: ReturnType<typeof fakeClients>) {
  return renderScreen(
    clients as never,
    [{ path: "/tasks/:id", element: <TaskDetailScreen /> }],
    "/tasks/task_1",
  );
}

describe("TaskDetailScreen (DD-005 detail frame)", () => {
  it("shows the story in the reading column and the facts in the rail", async () => {
    renderDetail(fakeClients());

    expect(
      await screen.findByText("Cover grounds 1 to 4; cite the interim order."),
    ).toBeInTheDocument();

    const rail = screen.getByRole("complementary", { name: "Task facts" });
    expect(rail).toHaveTextContent("Ravi Iyer");
    expect(rail).toHaveTextContent("20/08/2026");
    expect(rail).toHaveTextContent("High");
    expect(rail).toHaveTextContent("Overdue");
    const caseLink = screen.getByRole("link", { name: "CS/2026/042" });
    expect(caseLink).toHaveAttribute("href", "/cases/case_1");
  });

  it("the rail's status select fires UpdateStatus — the one lifecycle write path", async () => {
    const updateStatus = vi.fn(async () => TASK);
    renderDetail(fakeClients({ updateStatus }));

    await screen.findByRole("complementary", { name: "Task facts" });
    await userEvent.selectOptions(screen.getByLabelText("Status"), String(TaskState.CLOSED));

    await waitFor(() =>
      expect(updateStatus).toHaveBeenCalledWith({ id: "task_1", state: TaskState.CLOSED }),
    );
  });

  it("a refused status change renders the server's sentence beside the control", async () => {
    const updateStatus = vi
      .fn()
      .mockRejectedValue(new Error("[permission_denied] Only case members may work this matter"));
    renderDetail(fakeClients({ updateStatus }));

    await screen.findByRole("complementary", { name: "Task facts" });
    await userEvent.selectOptions(screen.getByLabelText("Status"), String(TaskState.CLOSED));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Only case members may work this matter/,
    );
  });

  it("Edit swaps the whole frame for the focused form, and Cancel restores it", async () => {
    renderDetail(fakeClients());

    await screen.findByRole("complementary", { name: "Task facts" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit Draft rejoinder" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByRole("complementary", { name: "Task facts" }),
    ).toBeInTheDocument();
  });
});
