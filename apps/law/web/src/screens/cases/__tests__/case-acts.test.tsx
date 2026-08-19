/**
 * The statutory frame (FR-ACT-001): manual entry with comma-separated
 * sections parsed to a list, corrections as in-place edits (no delete
 * exists — the session-27 corrections model), and the register order
 * coming from the server untouched.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CaseActSchema,
  ListCaseActsResponseSchema,
  type CaseAct,
} from "../../../gen/stigmer/law/caseact/v1/caseact_pb.js";
import { renderScreen } from "../../../test-support/render.js";
import { CaseActs } from "../CaseActs.js";

const FRAME: CaseAct[] = [
  create(CaseActSchema, {
    metadata: { id: "cact_1" },
    spec: {
      caseId: "case_1",
      act: "Indian Penal Code",
      sections: ["420", "468"],
      note: "the fraud counts",
    },
  }),
  create(CaseActSchema, {
    metadata: { id: "cact_2" },
    spec: { caseId: "case_1", act: "Negotiable Instruments Act", sections: ["138"] },
  }),
];

function fakeCaseActs(items: CaseAct[] = FRAME) {
  return {
    list: vi.fn(async () =>
      create(ListCaseActsResponseSchema, { items, totalCount: BigInt(items.length) }),
    ),
    create: vi.fn(async (act: unknown) => act),
    update: vi.fn(async (act: unknown) => act),
  };
}

describe("CaseActs (the statutory frame, FR-ACT-001)", () => {
  it("renders the register with sections and notes, in the server's order", async () => {
    renderScreen(
      { caseActs: fakeCaseActs() as never },
      [{ path: "/", element: <CaseActs caseId="case_1" /> }],
      "/",
    );

    expect(await screen.findByText("Indian Penal Code")).toBeInTheDocument();
    expect(screen.getByText("420, 468")).toBeInTheDocument();
    expect(screen.getByText("the fraud counts")).toBeInTheDocument();
    expect(screen.getByText("Negotiable Instruments Act")).toBeInTheDocument();
    // Manual entry is stated on the surface itself.
    expect(screen.getByText(/entered by the team/)).toBeInTheDocument();
  });

  it("adds an act with comma-separated sections parsed to a list", async () => {
    const caseActs = fakeCaseActs([]);
    renderScreen(
      { caseActs: caseActs as never },
      [{ path: "/", element: <CaseActs caseId="case_1" /> }],
      "/",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add act" }));
    await userEvent.type(screen.getByLabelText("Act"), "IPC");
    await userEvent.type(screen.getByLabelText(/Sections/), "420, 468, 34 r/w 120B");
    // The header toggle now reads "Close", so the form's submit is the
    // only button still named "Add act".
    await userEvent.click(screen.getByRole("button", { name: "Add act" }));

    await waitFor(() =>
      expect(caseActs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spec: expect.objectContaining({
            caseId: "case_1",
            act: "IPC",
            sections: ["420", "468", "34 r/w 120B"],
          }),
        }),
      ),
    );
  });

  it("corrects an entry in place — the edit form is the whole correction story", async () => {
    const caseActs = fakeCaseActs();
    renderScreen(
      { caseActs: caseActs as never },
      [{ path: "/", element: <CaseActs caseId="case_1" /> }],
      "/",
    );

    await userEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]!);
    const sections = screen.getByLabelText(/Sections/);
    await userEvent.clear(sections);
    await userEvent.type(sections, "420, 471");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(caseActs.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "cact_1" }),
          spec: expect.objectContaining({ sections: ["420", "471"] }),
        }),
      ),
    );
    // No delete control exists anywhere on the register.
    expect(screen.queryByRole("button", { name: /delete|remove/i })).not.toBeInTheDocument();
  });
});
