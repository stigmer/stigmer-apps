/**
 * The capture moment (journey J3): recording an outcome submits the
 * single write path with the next date (which auto-schedules), the
 * confirmation says what got scheduled, and a COMPLETED hearing offers
 * no recording controls at all — the UI never offers what the server
 * would refuse.
 */

import { create } from "@bufbuild/protobuf";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  HearingSchema,
  ListHearingsResponseSchema,
  OutcomeKind,
  RecordOutcomeResponseSchema,
  type RecordOutcomeRequest,
} from "../../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { CaseDiary } from "../CaseDiary.js";

const SCHEDULED = create(HearingSchema, {
  metadata: { id: "hear_1" },
  spec: { caseId: "case_1", date: "2026-08-09", purpose: "written statement" },
});

const COMPLETED = create(HearingSchema, {
  metadata: { id: "hear_0" },
  spec: { caseId: "case_1", date: "2026-08-01", purpose: "filing" },
  status: { outcomeKind: OutcomeKind.ADJOURNED, outcomeNotes: "time granted" },
});

describe("CaseDiary — recording an outcome (J3, FR-HEAR-002)", () => {
  it("submits the outcome with the next date and confirms the auto-scheduling", async () => {
    const hearings = {
      list: vi.fn(async () =>
        create(ListHearingsResponseSchema, { items: [SCHEDULED], totalCount: 1n }),
      ),
      recordOutcome: vi.fn(async (req: RecordOutcomeRequest) =>
        create(RecordOutcomeResponseSchema, {
          hearing: create(HearingSchema, {
            metadata: SCHEDULED.metadata,
            spec: SCHEDULED.spec,
            status: { outcomeKind: req.outcomeKind },
          }),
          nextHearing: create(HearingSchema, {
            metadata: { id: "hear_2" },
            spec: { caseId: "case_1", date: req.nextDate ?? "", purpose: req.nextPurpose ?? "" },
          }),
        }),
      ),
    };
    renderScreen(
      { hearings: hearings as never, firmMembers: fakeFirmMembers() as never },
      [{ path: "/", element: <CaseDiary caseId="case_1" /> }],
      "/",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Record outcome" }));
    await userEvent.selectOptions(screen.getByLabelText("What happened"), "Adjourned");
    await userEvent.type(screen.getByLabelText(/Next date/), "2026-09-12");
    await userEvent.type(screen.getByLabelText("Listed for"), "evidence");
    await userEvent.click(screen.getByRole("button", { name: "Record outcome" }));

    await waitFor(() =>
      expect(hearings.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "hear_1",
          outcomeKind: OutcomeKind.ADJOURNED,
          nextDate: "2026-09-12",
          nextPurpose: "evidence",
        }),
      ),
    );
    // The confirmation teaches the mechanism: the next hearing exists.
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Next hearing scheduled for 12\/09\/2026/,
    );
  });

  it("a completed hearing is read-only: no record button, the outcome as words", async () => {
    const hearings = {
      list: vi.fn(async () =>
        create(ListHearingsResponseSchema, { items: [COMPLETED], totalCount: 1n }),
      ),
      recordOutcome: vi.fn(),
    };
    renderScreen(
      { hearings: hearings as never, firmMembers: fakeFirmMembers() as never },
      [{ path: "/", element: <CaseDiary caseId="case_1" /> }],
      "/",
    );

    expect(await screen.findByText("Adjourned")).toBeInTheDocument();
    expect(screen.getByText("time granted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record outcome" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cause-list details" })).not.toBeInTheDocument();
  });
});
