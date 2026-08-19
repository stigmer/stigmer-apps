/**
 * what_happened_today — the day's story so far (FR-HEAR-007): what came
 * back from court, what went on the board, what new obligations were
 * entered, and what work is still waiting for an owner. The
 * backward-looking twin of my_day (which answers "what needs my
 * attention"): the office's question after lawyers return from court is
 * "what happened", and giving it its own verb keeps both tools'
 * descriptions crisp for tool selection.
 *
 * Composes the same list predicates the web dashboard renders — the
 * cross-surface coherence rule (DD-011 D2): both surfaces read one
 * contract, so they cannot disagree.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { todayInFirmTimezone } from "../../domain/firm-clock.js";
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

const NAME = "what_happened_today";

export function registerWhatHappenedToday(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The firm's day so far, looking BACK (my_day looks forward): " +
        "hearing outcomes recorded today with their next dates, hearings " +
        "newly put on the board, deadlines entered today, and open tasks " +
        "that have no assignee yet. Takes no arguments; answers within " +
        "the caller's visibility.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (_args, caller) => {
      const today = todayInFirmTimezone();
      const [recorded, scheduled, deadlines, unassigned] = await Promise.all([
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { recordedOn: today, pageSize: 20 }),
          caller.principal,
        ),
        deps.resources.hearings.invoke.list(
          create(ListHearingsRequestSchema, { scheduledOn: today, pageSize: 20 }),
          caller.principal,
        ),
        deps.resources.deadlines.invoke.list(
          create(ListDeadlinesRequestSchema, { enteredOn: today, pageSize: 20 }),
          caller.principal,
        ),
        deps.resources.tasks.invoke.list(
          create(ListTasksRequestSchema, {
            unassignedOnly: true,
            filter: TaskListFilter.OPEN,
            pageSize: 10,
          }),
          caller.principal,
        ),
      ]);

      const fileNumber = await fileNumbersByCaseId(deps.store, [
        ...(recorded.items as Hearing[]).map((h) => h.spec?.caseId ?? ""),
        ...(scheduled.items as Hearing[]).map((h) => h.spec?.caseId ?? ""),
        ...(deadlines.items as Deadline[]).map((d) => d.spec?.caseId ?? ""),
      ]);

      const sections: string[] = [];
      if (recorded.items.length > 0) {
        sections.push(
          `Came back from court today:\n` +
            (recorded.items as Hearing[])
              .map((h, i) => `${i + 1}. ${hearingLine(h, fileNumber(h.spec?.caseId))}`)
              .join("\n"),
        );
      }
      if (scheduled.items.length > 0) {
        sections.push(
          `New hearings on the board:\n` +
            (scheduled.items as Hearing[])
              .map((h, i) => `${i + 1}. ${hearingLine(h, fileNumber(h.spec?.caseId))}`)
              .join("\n"),
        );
      }
      if (deadlines.items.length > 0) {
        sections.push(
          `New deadlines on the book:\n` +
            (deadlines.items as Deadline[])
              .map((d, i) => `${i + 1}. ${deadlineLine(d, fileNumber(d.spec?.caseId))}`)
              .join("\n"),
        );
      }
      if (unassigned.items.length > 0) {
        sections.push(
          `Open tasks waiting for an owner:\n` +
            unassigned.items.map((t, i) => `${i + 1}. ${taskLine(t)}`).join("\n"),
        );
      }
      if (sections.length === 0) {
        return textResult(
          "Nothing recorded yet today: no outcomes, no new hearings or deadlines, " +
            "and no open tasks waiting for an owner.",
        );
      }
      return textResult(sections.join("\n\n"), {
        outcomes_recorded_today: recorded.items.length,
        hearings_scheduled_today: scheduled.items.length,
        deadlines_entered_today: deadlines.items.length,
        unassigned_open_tasks: unassigned.items.map(taskRecord),
      });
    }),
  );
  return NAME;
}
