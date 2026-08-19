/**
 * The pulse (journey J1): each section renders from its own server
 * query, and the nag section appears only when something is actually
 * unrecorded — attention before navigation.
 */

import { create } from "@bufbuild/protobuf";
import { screen, within } from "@testing-library/react";
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
import {
  ListDeadlinesRequestSchema,
  type ListDeadlinesRequest,
} from "../../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import {
  ListTasksResponseSchema,
  TaskSchema,
  TaskState,
} from "../../../gen/stigmer/law/task/v1/task_pb.js";
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
  recordedTodayItems?: MessageInitShape<typeof HearingSchema>[];
  scheduledTodayItems?: MessageInitShape<typeof HearingSchema>[];
  enteredTodayItems?: MessageInitShape<typeof DeadlineSchema>[];
  unassignedItems?: MessageInitShape<typeof TaskSchema>[];
}) {
  const hearingPage = (items: MessageInitShape<typeof HearingSchema>[] = []) =>
    create(ListHearingsResponseSchema, {
      items: items.map((h) => create(HearingSchema, h)),
      totalCount: BigInt(items.length),
    });
  return {
    hearings: {
      list: vi.fn(async (req: MessageInitShape<typeof ListHearingsRequestSchema>) => {
        const request = req as ListHearingsRequest;
        if (request.unrecordedOnly) return hearingPage(overrides?.unrecordedItems);
        if (request.recordedOn) return hearingPage(overrides?.recordedTodayItems);
        if (request.scheduledOn) return hearingPage(overrides?.scheduledTodayItems);
        // The board: one hearing today/tomorrow.
        return hearingPage([
          {
            metadata: { id: "hear_1" },
            spec: { caseId: "case_1", date: "2099-01-01", purpose: "evidence" },
          },
        ]);
      }),
    },
    deadlines: {
      list: vi.fn(async (req: MessageInitShape<typeof ListDeadlinesRequestSchema>) => {
        if ((req as ListDeadlinesRequest).enteredOn) {
          return create(ListDeadlinesResponseSchema, {
            items: (overrides?.enteredTodayItems ?? []).map((d) => create(DeadlineSchema, d)),
            totalCount: BigInt(overrides?.enteredTodayItems?.length ?? 0),
          });
        }
        return create(ListDeadlinesResponseSchema, {
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
        });
      }),
    },
    tasks: {
      list: vi.fn(async () =>
        create(ListTasksResponseSchema, {
          items: (overrides?.unassignedItems ?? []).map((t) => create(TaskSchema, t)),
          totalCount: BigInt(overrides?.unassignedItems?.length ?? 0),
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
    // A quiet day: the story section says so honestly, and the pickup
    // list does not exist at all.
    expect(await screen.findByText("Nothing recorded yet today")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for an owner/i)).not.toBeInTheDocument();
  });

  it("tells the day's story and surfaces the pickup list (FR-HEAR-007, FR-TASK-002)", async () => {
    renderScreen(
      fakeClients({
        recordedTodayItems: [
          {
            metadata: { id: "hear_done" },
            spec: { caseId: "case_1", date: "2026-08-19", purpose: "mention" },
            status: { outcomeKind: 1, nextDate: "2026-09-12" }, // ADJOURNED
          },
        ],
        enteredTodayItems: [
          {
            metadata: { id: "dead_new" },
            spec: {
              caseId: "case_1",
              title: "File counter",
              dueDate: "2026-09-01",
              ownerId: "fmem_me",
            },
            status: { state: DeadlineState.OPEN },
          },
        ],
        unassignedItems: [
          {
            metadata: { id: "task_orphan" },
            spec: { caseId: "case_1", title: "Prepare evidence affidavit" },
            status: { state: TaskState.OPEN, caseFileNumber: "CS/2026/042" },
          },
        ],
      }) as never,
      [{ path: "/", element: <HomeScreen /> }],
      "/",
    );

    // The outcome line: what happened and the next date, in words.
    // (findByRole alone would race the queries: the region's title
    // renders before its data — await the first fact instead.)
    const story = await screen.findByRole("region", { name: "What happened today" });
    await within(story).findByText("Back from court");
    expect(story).toHaveTextContent(/Adjourned — next 12\/09\/2026/);
    expect(story).toHaveTextContent("New deadlines on the book");
    expect(story).toHaveTextContent("File counter");

    // The pickup list names the orphan and asks for an owner.
    const pickup = screen.getByRole("region", { name: "Tasks waiting for an owner" });
    expect(pickup).toHaveTextContent("Prepare evidence affidavit");
    expect(pickup).toHaveTextContent(/take it, or assign it/i);
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
