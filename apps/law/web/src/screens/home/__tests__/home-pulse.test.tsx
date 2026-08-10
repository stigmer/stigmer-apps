/**
 * The pulse (journey J1): each section renders from its own server
 * query, and the nag section appears only when something is actually
 * unrecorded — attention before navigation.
 */

import { create } from "@bufbuild/protobuf";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CaseSummarySchema,
  ListCasesResponseSchema,
} from "../../../gen/stigmer/law/case/v1/case_pb.js";
import {
  ListDeadlinesResponseSchema,
  DeadlineSchema,
  DeadlineState,
} from "../../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import {
  HearingSchema,
  ListHearingsRequestSchema,
  ListHearingsResponseSchema,
  type ListHearingsRequest,
} from "../../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { fakeFirmMembers, renderScreen } from "../../../test-support/render.js";
import { HomeScreen } from "../HomeScreen.js";

const SUMMARY = create(CaseSummarySchema, {
  id: "case_1",
  fileNumber: "CS/2026/042",
  caption: "Meridian Textiles vs Sunrise Traders",
});

function fakeClients(overrides?: {
  unrecordedItems?: MessageInitShape<typeof HearingSchema>[];
}) {
  return {
    hearings: {
      list: vi.fn(async (req: MessageInitShape<typeof ListHearingsRequestSchema>) => {
        const request = req as ListHearingsRequest;
        if (request.unrecordedOnly) {
          return create(ListHearingsResponseSchema, {
            items: (overrides?.unrecordedItems ?? []).map((h) => create(HearingSchema, h)),
            totalCount: BigInt(overrides?.unrecordedItems?.length ?? 0),
          });
        }
        // The board: one hearing today/tomorrow.
        return create(ListHearingsResponseSchema, {
          items: [
            create(HearingSchema, {
              metadata: { id: "hear_1" },
              spec: { caseId: "case_1", date: "2099-01-01", purpose: "evidence" },
            }),
          ],
          totalCount: 1n,
        });
      }),
    },
    deadlines: {
      list: vi.fn(async () =>
        create(ListDeadlinesResponseSchema, {
          items: [
            create(DeadlineSchema, {
              metadata: { id: "dead_1" },
              spec: {
                caseId: "case_1",
                title: "File written statement",
                dueDate: "2026-08-01",
                ownerId: "fmem_me",
              },
              status: { state: DeadlineState.OPEN, overdue: true },
            }),
          ],
          totalCount: 1n,
        }),
      ),
    },
    cases: {
      list: vi.fn(async () =>
        create(ListCasesResponseSchema, { items: [SUMMARY], totalCount: 1n }),
      ),
    },
    firmMembers: fakeFirmMembers(),
  };
}

describe("HomeScreen (the pulse, J1)", () => {
  it("renders the board, my deadlines (overdue loud), and no-next-date matters", async () => {
    renderScreen(
      fakeClients() as never,
      [{ path: "/", element: <HomeScreen /> }],
      "/",
    );

    // The board row carries the file number and the purpose.
    expect(await screen.findAllByText("CS/2026/042")).not.toHaveLength(0);
    expect(screen.getByText(/evidence/)).toBeInTheDocument();
    // The overdue deadline says so in words, with the date it was due.
    expect(screen.getByText(/OVERDUE — was due 01\/08\/2026/)).toBeInTheDocument();
    // No unrecorded hearings ⇒ the nag section does not exist at all.
    expect(screen.queryByText(/awaiting an outcome/i)).not.toBeInTheDocument();
  });

  it("surfaces the unrecorded-outcome nag FIRST when a hearing went quiet (FR-HEAR-005)", async () => {
    renderScreen(
      fakeClients({
        unrecordedItems: [
          {
            metadata: { id: "hear_old" },
            spec: { caseId: "case_1", date: "2026-08-01", purpose: "directions" },
          },
        ],
      }) as never,
      [{ path: "/", element: <HomeScreen /> }],
      "/",
    );

    const nag = await screen.findByRole("region", { name: "Hearings awaiting an outcome" });
    expect(nag).toHaveTextContent("CS/2026/042");
    expect(nag).toHaveTextContent(/record what happened/i);
  });
});
