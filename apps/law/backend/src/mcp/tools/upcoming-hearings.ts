/**
 * upcoming_hearings — the board for the days ahead (FR-HEAR-004): the
 * caller's visible scheduled hearings inside a window, date order. For
 * partners that is the firm's board; for everyone else, their member
 * cases — the same list the web app's today/tomorrow views read.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { z } from "zod";
import { addDaysToIsoDate, todayInFirmTimezone } from "../../domain/firm-clock.js";
import {
  ListHearingsRequestSchema,
  type Hearing,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { fileNumbersByCaseId, hearingLine, type ToolDeps } from "./shared.js";

const NAME = "upcoming_hearings";

export function registerUpcomingHearings(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Scheduled hearings in the coming days (default: the next 7), soonest " +
        "first, with each matter's file number, purpose, and cause-list " +
        "details where the clerk has recorded them. Partners see the whole " +
        "firm's board; everyone else sees their own cases.",
      inputSchema: {
        within_days: z
          .number()
          .int()
          .min(0)
          .max(90)
          .optional()
          .describe("The window in days from today, inclusive. Default 7; 0 means just today."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (args, caller) => {
      const today = todayInFirmTimezone();
      const days = args.within_days ?? 7;
      const page = await deps.resources.hearings.invoke.list(
        create(ListHearingsRequestSchema, {
          dateFrom: today,
          dateTo: addDaysToIsoDate(today, days),
          pageSize: 50,
        }),
        caller.principal,
      );

      const scheduled = (page.items as Hearing[]).filter(
        (h) => (h.status?.outcomeKind ?? 0) === 0,
      );
      if (scheduled.length === 0) {
        return textResult(
          days === 0
            ? "No hearings on your board today."
            : `No hearings on your board in the next ${days} days.`,
        );
      }

      const fileNumber = await fileNumbersByCaseId(
        deps.store,
        scheduled.map((h) => h.spec?.caseId ?? ""),
      );
      const lines = scheduled.map(
        (h, i) => `${i + 1}. ${hearingLine(h, fileNumber(h.spec?.caseId))}`,
      );
      return textResult(
        `${countNoun(scheduled.length, "hearing")} in the next ${days} days:\n${lines.join("\n")}`,
        {
          hearings: scheduled.map((h) => ({
            id: h.metadata?.id,
            file_number: fileNumber(h.spec?.caseId),
            date: h.spec?.date,
            purpose: h.spec?.purpose,
            list_serial_number: h.spec?.listSerialNumber,
            court_hall: h.spec?.courtHall,
          })),
        },
      );
    }),
  );
  return NAME;
}
