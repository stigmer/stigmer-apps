/**
 * my_day — the working day in one glance (FR-ASST-002, journey J1 on a
 * phone): today's and tomorrow's hearings on the caller's visible
 * cases, the caller's own deadlines landing this week (or overdue), and
 * their open tasks. Takes NO arguments: "my" resolves from the verified
 * channel identity, so there is structurally no way to ask for someone
 * else's day.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { addDaysToIsoDate, todayInFirmTimezone } from "../../domain/firm-clock.js";
import {
  ListDeadlinesRequestSchema,
  type Deadline,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import {
  ListHearingsRequestSchema,
  type Hearing,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";
import {
  ListTasksRequestSchema,
  TaskListFilter,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { gated, textResult } from "../gate.js";
import {
  deadlineLine,
  fileNumbersByCaseId,
  hearingLine,
  taskLine,
  taskRecord,
  type ToolDeps,
} from "./shared.js";

const NAME = "my_day";

export function registerMyDay(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The caller's working day in one answer: hearings today and tomorrow " +
        "on their cases, their own deadlines due within a week (plus anything " +
        "overdue), and their open tasks. Takes no arguments — it always " +
        "answers for the verified caller.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (_args, caller) => {
      const today = todayInFirmTimezone();
      const [hearings, deadlines, tasks] = await Promise.all([
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, {
            dateFrom: today,
            dateTo: addDaysToIsoDate(today, 1),
            pageSize: 20,
          }),
          caller.principal,
        ),
        deps.resources.deadlines.invoke.list(
          create(ListDeadlinesRequestSchema, {
            mine: true,
            openOnly: true,
            dueTo: addDaysToIsoDate(today, 7),
            pageSize: 20,
          }),
          caller.principal,
        ),
        deps.resources.tasks.invoke.list(
          create(ListTasksRequestSchema, { filter: TaskListFilter.OPEN, pageSize: 10 }),
          caller.principal,
        ),
      ]);

      const fileNumber = await fileNumbersByCaseId(deps.store, [
        ...(hearings.items as Hearing[]).map((h) => h.spec?.caseId ?? ""),
        ...(deadlines.items as Deadline[]).map((d) => d.spec?.caseId ?? ""),
      ]);

      const sections: string[] = [];
      if (hearings.items.length > 0) {
        sections.push(
          `Hearings today/tomorrow:\n` +
            (hearings.items as Hearing[])
              .map((h, i) => `${i + 1}. ${hearingLine(h, fileNumber(h.spec?.caseId))}`)
              .join("\n"),
        );
      }
      if (deadlines.items.length > 0) {
        sections.push(
          `Your deadlines (this week + overdue):\n` +
            (deadlines.items as Deadline[])
              .map((d, i) => `${i + 1}. ${deadlineLine(d, fileNumber(d.spec?.caseId))}`)
              .join("\n"),
        );
      }
      if (tasks.items.length > 0) {
        sections.push(
          `Your open tasks:\n` +
            tasks.items.map((t, i) => `${i + 1}. ${taskLine(t)}`).join("\n"),
        );
      }
      if (sections.length === 0) {
        return textResult(
          "Nothing on the board: no hearings today or tomorrow, no deadlines this week, no open tasks.",
        );
      }
      return textResult(sections.join("\n\n"), {
        hearings_today_tomorrow: hearings.items.length,
        deadlines_this_week: deadlines.items.length,
        open_tasks: tasks.items.map(taskRecord),
      });
    }),
  );
  return NAME;
}
