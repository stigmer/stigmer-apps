/**
 * firm_overview — the pulse (journey J1 as one answer): active matters,
 * today's board, matters with no next date, unrecorded outcomes, open
 * deadlines this week, overdue tasks. Counts come from the pipelines'
 * server-computed totals (page_size 1, total_count) — the tool composes,
 * never computes. Every number is scoped by the same policy as the web
 * app: a clerk's "firm" overview is their cases.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { addDaysToIsoDate, todayInFirmTimezone } from "../../domain/firm-clock.js";
import { ListCasesRequestSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import { ListDeadlinesRequestSchema } from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { ListHearingsRequestSchema } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import {
  ListTasksRequestSchema,
  TaskListFilter,
  TaskListScope,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { type ToolDeps } from "./shared.js";

const NAME = "firm_overview";

export function registerFirmOverview(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The firm's pulse in one answer: active matters, hearings today, " +
        "matters with no next date, hearings awaiting an outcome, deadlines " +
        "due this week, and overdue tasks. Numbers respect the caller's " +
        "visibility (partners see the whole firm).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (_args, caller) => {
      const today = todayInFirmTimezone();
      const probe = { pageSize: 1 };
      const [active, noNextDate, board, unrecorded, deadlines, overdue] = await Promise.all([
        deps.resources.cases.invoke.list(
          create(ListCasesRequestSchema, probe),
          caller.principal,
        ),
        deps.resources.cases.invoke.list(
          create(ListCasesRequestSchema, { ...probe, noNextDate: true }),
          caller.principal,
        ),
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { ...probe, dateFrom: today, dateTo: today }),
          caller.principal,
        ),
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { ...probe, unrecordedOnly: true }),
          caller.principal,
        ),
        deps.resources.deadlines.invoke.list(
          create(ListDeadlinesRequestSchema, {
            ...probe,
            openOnly: true,
            dueTo: addDaysToIsoDate(today, 7),
          }),
          caller.principal,
        ),
        deps.resources.tasks.invoke.list(
          create(ListTasksRequestSchema, {
            ...probe,
            filter: TaskListFilter.OVERDUE,
            scope: TaskListScope.FIRM,
          }),
          caller.principal,
        ),
      ]);

      const lines = [
        `- ${countNoun(active.totalCount, "active matter")}`,
        `- ${countNoun(board.totalCount, "hearing")} today`,
        `- ${countNoun(unrecorded.totalCount, "hearing")} awaiting a recorded outcome`,
        `- ${countNoun(noNextDate.totalCount, "matter")} with NO next date`,
        `- ${countNoun(deadlines.totalCount, "open deadline")} due within a week`,
        `- ${countNoun(overdue.totalCount, "overdue task")}`,
      ];
      return textResult(`The firm right now:\n${lines.join("\n")}`, {
        active_matters: Number(active.totalCount),
        hearings_today: Number(board.totalCount),
        unrecorded_outcomes: Number(unrecorded.totalCount),
        no_next_date: Number(noNextDate.totalCount),
        deadlines_this_week: Number(deadlines.totalCount),
        overdue_tasks: Number(overdue.totalCount),
      });
    }),
  );
  return NAME;
}
