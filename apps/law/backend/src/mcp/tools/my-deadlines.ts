/**
 * my_deadlines — the caller's own open deadlines (FR-DEAD-002's nudge
 * surface as a question): overdue first by date order, then what is
 * landing. Takes no arguments — "my" resolves from the verified
 * identity, and a deadline never leaves this answer until a human
 * resolves it (FR-DEAD-001's explicit transitions).
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import {
  ListDeadlinesRequestSchema,
  type Deadline,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";
import { countNoun } from "../format.js";
import { gated, textResult } from "../gate.js";
import { deadlineLine, fileNumbersByCaseId, type ToolDeps } from "./shared.js";

const NAME = "my_deadlines";

export function registerMyDeadlines(
  server: McpServer,
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "The caller's own OPEN deadlines, earliest due first — overdue ones " +
        "marked loudly. Takes no arguments; it always answers for the " +
        "verified caller. Deadlines stay in this list until someone marks " +
        "them met, missed, or withdrawn.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveChannelIdentity, async (_args, caller) => {
      const page = await deps.resources.deadlines.invoke.list(
        create(ListDeadlinesRequestSchema, { mine: true, openOnly: true, pageSize: 50 }),
        caller.principal,
      );
      if (page.items.length === 0) {
        return textResult("You have no open deadlines.");
      }
      const deadlines = page.items as Deadline[];
      const fileNumber = await fileNumbersByCaseId(
        deps.store,
        deadlines.map((d) => d.spec?.caseId ?? ""),
      );
      const lines = deadlines.map(
        (d, i) => `${i + 1}. ${deadlineLine(d, fileNumber(d.spec?.caseId))}`,
      );
      const overdueCount = deadlines.filter((d) => d.status?.overdue).length;
      const headline =
        overdueCount > 0
          ? `You have ${countNoun(page.totalCount, "open deadline")} — ${overdueCount} OVERDUE:`
          : `You have ${countNoun(page.totalCount, "open deadline")}:`;
      return textResult(`${headline}\n${lines.join("\n")}`, {
        open_count: Number(page.totalCount),
        overdue_count: overdueCount,
      });
    }),
  );
  return NAME;
}
