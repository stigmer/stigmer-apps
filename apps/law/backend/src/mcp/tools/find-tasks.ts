/**
 * find_tasks — the firm-wide task question: what is a colleague working
 * on, what is overdue anywhere, what is outstanding on a matter. Every
 * caller is verified firm staff and the firm policy already grants
 * firm-wide reads (FR-USER-001), so this widens QUESTIONS, not access.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  ListTasksRequestSchema,
  TaskListFilter,
  TaskListScope,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun } from "../format.js";
import { errorResult, gated, textResult } from "../gate.js";
import {
  caseByFileNumber,
  resolveMemberByNameOrEmail,
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
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Find tasks across the caller's visible cases, soonest due first: " +
        "filter by the assigned person (exact name or email), by a matter's " +
        "file number, by status (open / overdue / all), or any combination. " +
        "With no arguments it lists everything visible. Answers include each " +
        "task's id.",
      inputSchema: {
        assignee: z
          .string()
          .min(1)
          .optional()
          .describe("The assigned person's exact name or email, e.g. 'Asha' or 'asha@firm.in'."),
        file_number: z
          .string()
          .min(1)
          .optional()
          .describe("The firm's file number for a matter, e.g. 'CS/2026/041'."),
        status: z
          .enum(FILTERS)
          .optional()
          .describe("Narrow to 'open' (not finished) or 'overdue' (open and past due). Default: all."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      let assigneeId: string | undefined;
      let assigneeName: string | undefined;
      if (args.assignee) {
        const resolved = await resolveMemberByNameOrEmail(
          deps.resources,
          caller.principal,
          args.assignee,
        );
        if ("refusal" in resolved) {
          return errorResult(resolved.refusal);
        }
        assigneeId = resolved.member.metadata?.id;
        assigneeName = resolved.member.status?.userName;
      }

      let caseId: string | undefined;
      if (args.file_number) {
        // NOT_FOUND (and the membership denial) relay verbatim through
        // the gate.
        caseId = (await caseByFileNumber(deps.resources, caller.principal, args.file_number))
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
        args.file_number ? `on ${args.file_number.trim()}` : "",
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
