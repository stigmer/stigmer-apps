/**
 * upcoming_hearings — the firm's court calendar for the next N days,
 * soonest first (the case list's fixed ordering IS this contract). Each
 * line carries the case, the client, and the assigned lawyer's name.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { ListUsersRequestSchema } from "@stigmer/identity";
import { z } from "zod";
import { ListCasesRequestSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { countNoun, formatDate } from "../format.js";
import { gated, textResult } from "../gate.js";
import type { ToolDeps } from "./shared.js";

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
        "The firm's hearings for the next N days (default 7), soonest first: " +
        "date, case number, client, and the assigned lawyer.",
      inputSchema: {
        days_ahead: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("How many days ahead to look, counting today. Default 7."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (args, caller) => {
      const days = args.days_ahead ?? 7;
      const [page, people] = await Promise.all([
        deps.resources.cases.invoke.list(
          create(ListCasesRequestSchema, { hearingWithinDays: days, pageSize: 20 }),
          caller.principal,
        ),
        // One page of users names every lawyer on the answer — one call,
        // never one per case.
        deps.resources.users.invoke.list(
          create(ListUsersRequestSchema, { pageSize: 100 }),
          caller.principal,
        ),
      ]);
      const nameById = new Map(people.items.map((u) => [u.metadata?.id, u.spec?.name]));

      if (page.items.length === 0) {
        return textResult(`No hearings in the next ${days} days.`);
      }
      const lines = page.items.map((c) => {
        const lawyer = nameById.get(c.spec?.assignedLawyerId) ?? "unassigned";
        return `${formatDate(c.spec?.nextHearingDate)} — ${c.spec?.caseNumber} (${c.spec?.clientName}), ${lawyer}`;
      });
      return textResult(
        `${countNoun(page.totalCount, "hearing")} in the next ${days} days:\n${lines.join("\n")}`,
        {
          hearings: page.items.map((c) => ({
            case_id: c.metadata?.id,
            case_number: c.spec?.caseNumber,
            client_name: c.spec?.clientName,
            hearing_date: c.spec?.nextHearingDate,
            assigned_lawyer: nameById.get(c.spec?.assignedLawyerId),
          })),
          total_count: Number(page.totalCount),
        },
      );
    }),
  );
  return NAME;
}
