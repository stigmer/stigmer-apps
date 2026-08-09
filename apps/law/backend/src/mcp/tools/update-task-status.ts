/**
 * update_task_status — the one write path for a task's lifecycle state,
 * over WhatsApp. Reaches the SAME UpdateStatus pipeline the web app
 * uses, as the verified caller, so the audit trail records the lawyer —
 * never a service account. The agent confirms conversationally before
 * calling (its instructions), and the id comes from a previous read's
 * answer, because tasks deliberately have no user-facing identifier.
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { z } from "zod";
import {
  TaskState,
  UpdateTaskStatusRequestSchema,
} from "../../gen/stigmer/law/task/v1/task_pb.js";
import { formatState } from "../format.js";
import { gated, textResult } from "../gate.js";
import { taskRecord, type ToolDeps } from "./shared.js";

const NAME = "update_task_status";

const STATES = ["open", "in_progress", "closed"] as const;
const WIRE_STATE: Record<(typeof STATES)[number], TaskState> = {
  open: TaskState.OPEN,
  in_progress: TaskState.IN_PROGRESS,
  closed: TaskState.CLOSED,
};

export function registerUpdateTaskStatus(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Change a task's status (open / in_progress / closed). Use the task " +
        "id from a previous my_open_tasks or find_tasks answer. Confirm with " +
        "the person before closing anything.",
      inputSchema: {
        task_id: z
          .string()
          .min(1)
          .describe("The task's id, from a previous task listing (e.g. 'task_01...')."),
        status: z.enum(STATES).describe("The new status."),
      },
      // No destructiveHint: a status change is reversible by another
      // status change, and an untrue hint would approval-gate this tool
      // into a silent skip on the unattended WhatsApp surface.
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (args, caller) => {
      const saved = await deps.resources.tasks.invoke.updateStatus(
        create(UpdateTaskStatusRequestSchema, {
          id: args.task_id.trim(),
          state: WIRE_STATE[args.status],
        }),
        caller.principal,
      );
      const caseRef = saved.status?.caseNumber ? ` (case ${saved.status.caseNumber})` : "";
      return textResult(
        `Done — "${saved.spec?.title}"${caseRef} is now ${formatState(saved.status?.state ?? 0)}.`,
        { task: taskRecord(saved) },
      );
    }),
  );
  return NAME;
}
