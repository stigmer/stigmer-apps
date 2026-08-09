/**
 * find_tasks — the firm-wide task question: what is a colleague working
 * on, what is overdue anywhere, what is outstanding on a matter. Every
 * caller is verified firm staff and the firm policy already grants
 * firm-wide reads (FR-USER-001), so this widens QUESTIONS, not access.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  ListTasksRequestSchema,
  TaskListFilter,
  TaskListScope,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun } from "../format.js";
import { errorResult, gated, textResult } from "../gate.js";
import {
  caseByNumber,
  resolvePersonByNameOrEmail,
  taskLine,
  taskRecord,
  type ToolDeps,
} from "./shared.js";

const NAME = "find_tasks";

const FILTERS = ["open", "overdue", "all"] as const;
const WIRE_FILTER: Record<(typeof FILTERS)[number], TaskListFilter> = {
  open: TaskListFilter.OPEN,
  overdue: TaskListFilter.OVERDUE,
  all: TaskListFilter.UNSPECIFIED,
};

export function registerFindTasks(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Find tasks across the whole firm, soonest due first: filter by the " +
        "assigned person (exact name or email), by a case number, by status " +
        "(open / overdue / all), or any combination. With no arguments it " +
        "lists the firm's tasks. Answers include each task's id.",
      inputSchema: {
        assignee: z
          .string()
          .min(1)
          .optional()
          .describe("The assigned person's exact name or email, e.g. 'Asha' or 'asha@firm.in'."),
        case_number: z
          .string()
          .min(1)
          .optional()
          .describe("A court case number, exactly as the firm uses it."),
        status: z
          .enum(FILTERS)
          .optional()
          .describe("Narrow to 'open' (not finished) or 'overdue' (open and past due). Default: all."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (args, caller) => {
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      if (args.assignee) {
        const resolved = await resolvePersonByNameOrEmail(
          deps.resources,
          caller.principal,
          args.assignee,
        );
        if ("refusal" in resolved) {
          return errorResult(resolved.refusal);
        }
        assigneeId = resolved.user.metadata?.id;
        assigneeName = resolved.user.spec?.name;
      }

      let caseId: string | undefined;
      if (args.case_number) {
        // NOT_FOUND relays "Case 'X' not found" verbatim through the gate.
        caseId = (await caseByNumber(deps.resources, caller.principal, args.case_number))
          .metadata?.id;
      }

      const page = await deps.resources.tasks.invoke.list(
        create(ListTasksRequestSchema, {
          assigneeId,
          caseId,
          filter: WIRE_FILTER[args.status ?? "all"],
          // Explicit filters name their own scope; a bare find_tasks is
          // the firm-wide question by definition.
          scope: TaskListScope.FIRM,
          pageSize: 20,
        }),
        caller.principal,
      );

      const subject = [
        args.status === "overdue" ? "overdue task" : args.status === "open" ? "open task" : "task",
      ][0] as string;
      const where = [
        assigneeName ? `for ${assigneeName}` : "",
        args.case_number ? `on case ${args.case_number.trim()}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const headline = `${countNoun(page.totalCount, subject)}${where ? ` ${where}` : " in the firm"}`;

      if (page.items.length === 0) {
        return textResult(`${headline}.`);
      }
      const lines = page.items.map((t, i) => `${i + 1}. ${taskLine(t)}`);
      const more =
        page.totalCount > BigInt(page.items.length)
          ? `\n(showing the ${page.items.length} soonest due)`
          : "";
      return textResult(`${headline}:\n${lines.join("\n")}${more}`, {
        tasks: page.items.map(taskRecord),
        total_count: Number(page.totalCount),
      });
    }),
  );
  return NAME;
}
