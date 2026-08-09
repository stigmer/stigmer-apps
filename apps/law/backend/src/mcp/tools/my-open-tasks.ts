/**
 * my_open_tasks — the caller's own unfinished work. Takes NO arguments
 * at all: "mine" resolves from the verified channel identity, so there
 * is structurally no way to ask about someone else through this tool
 * (the reference implementation's own-row rule, kept). find_tasks is
 * the firm-wide question.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import {
  ListTasksRequestSchema,
  TaskListFilter,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { taskLine, taskRecord, type ToolDeps } from "./shared.js";

const NAME = "my_open_tasks";

export function registerMyOpenTasks(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The caller's own unfinished tasks (open and in progress), soonest due " +
        "first, with each task's case number and id. Resolves the caller from " +
        "the verified sender identity — it takes no arguments and cannot look " +
        "up anyone else's tasks (use find_tasks for that).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (_args, caller) => {
      const page = await deps.resources.tasks.invoke.list(
        create(ListTasksRequestSchema, { filter: TaskListFilter.OPEN, pageSize: 20 }),
        caller.principal,
      );
      if (page.items.length === 0) {
        return textResult("You have no open tasks. All caught up.");
      }
      const lines = page.items.map((t, i) => `${i + 1}. ${taskLine(t)}`);
      const more =
        page.totalCount > BigInt(page.items.length)
          ? `\n(and ${page.totalCount - BigInt(page.items.length)} more)`
          : "";
      return textResult(
        `You have ${countNoun(page.totalCount, "open task")}:\n${lines.join("\n")}${more}`,
        {
          tasks: page.items.map(taskRecord),
          total_count: Number(page.totalCount),
        },
      );
    }),
  );
  return NAME;
}
