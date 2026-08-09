/**
 * firm_overview — the weekly pulse, and the direct answer to "how does
 * this help me run my firm": hearings coming up, open and overdue work,
 * matters with no hearing scheduled. Every number is a server-computed
 * total from a named predicate; this tool ASSEMBLES, it never counts —
 * a client-side count over one fetched page silently lies across pages,
 * and a firm owner making decisions on a quietly-wrong number is the
 * worst defect this surface could ship.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { ListCasesRequestSchema } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  ListTasksRequestSchema,
  TaskListFilter,
  TaskListScope,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun, formatDate } from "../format.js";
import { gated, textResult } from "../gate.js";
import type { ToolDeps } from "./shared.js";

const NAME = "firm_overview";
const HORIZON_DAYS = 7;

export function registerFirmOverview(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The firm at a glance: hearings in the next 7 days, open and overdue " +
        "task counts across the whole firm, matters with no next hearing " +
        "scheduled, and the total caseload. The owner's morning question.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (_args, caller) => {
      const { cases, tasks } = deps.resources;
      const [hearings, allCases, unscheduled, openTasks, overdueTasks] = await Promise.all([
        cases.invoke.list(
          create(ListCasesRequestSchema, { hearingWithinDays: HORIZON_DAYS, pageSize: 3 }),
          caller.principal,
        ),
        cases.invoke.list(create(ListCasesRequestSchema, { pageSize: 1 }), caller.principal),
        cases.invoke.list(
          create(ListCasesRequestSchema, { unscheduledOnly: true, pageSize: 1 }),
          caller.principal,
        ),
        tasks.invoke.list(
          create(ListTasksRequestSchema, {
            scope: TaskListScope.FIRM,
            filter: TaskListFilter.OPEN,
            pageSize: 1,
          }),
          caller.principal,
        ),
        tasks.invoke.list(
          create(ListTasksRequestSchema, {
            scope: TaskListScope.FIRM,
            filter: TaskListFilter.OVERDUE,
            pageSize: 3,
          }),
          caller.principal,
        ),
      ]);

      const soonest = hearings.items[0];
      const hearingLine = soonest
        ? `${countNoun(hearings.totalCount, "hearing")} in the next ${HORIZON_DAYS} days — soonest ${formatDate(soonest.spec?.nextHearingDate)} (${soonest.spec?.caseNumber}, ${soonest.spec?.clientName})`
        : `No hearings in the next ${HORIZON_DAYS} days`;
      const overdueDetail =
        overdueTasks.items.length > 0
          ? ` — e.g. "${overdueTasks.items[0]?.spec?.title}" (case ${overdueTasks.items[0]?.status?.caseNumber})`
          : "";

      return textResult(
        [
          "The firm this week:",
          `• ${hearingLine}`,
          `• ${countNoun(openTasks.totalCount, "open task")}, ${countNoun(overdueTasks.totalCount, "overdue task")}${overdueDetail}`,
          `• ${countNoun(unscheduled.totalCount, "matter")} with no next hearing scheduled, of ${countNoun(allCases.totalCount, "case")} in total`,
        ].join("\n"),
        {
          hearings_next_7_days: Number(hearings.totalCount),
          open_tasks: Number(openTasks.totalCount),
          overdue_tasks: Number(overdueTasks.totalCount),
          unscheduled_cases: Number(unscheduled.totalCount),
          total_cases: Number(allCases.totalCount),
        },
      );
    }),
  );
  return NAME;
}
