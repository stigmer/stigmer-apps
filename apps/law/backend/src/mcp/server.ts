/**
 * The MCP tool surface: one McpServer instance built PER REQUEST with
 * the caller identity as a constructor argument — identity is never
 * session state, so there is no second place it could live and disagree
 * (the reference implementation's core arrangement, kept).
 *
 * Every tool is registered for every identity, anonymous included: the
 * platform's tool discovery probes with no session, and a tool hidden
 * from discovery is never classified — which makes it run UNGATED at
 * real call time. Advertise everything; gate every call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ChannelIdentity } from "@stigmer/identity";
import { registerAddCaseNote } from "./tools/add-case-note.js";
import { registerFindTasks } from "./tools/find-tasks.js";
import { registerFirmOverview } from "./tools/firm-overview.js";
import { registerGetCase } from "./tools/get-case.js";
import { registerMyOpenTasks } from "./tools/my-open-tasks.js";
import { registerUpcomingHearings } from "./tools/upcoming-hearings.js";
import { registerUpdateTaskStatus } from "./tools/update-task-status.js";
import type { ToolDeps } from "./tools/shared.js";

/** Domain-shaped, never branded (DD-A2): the vertical is law, firm #N agnostic. */
const SERVER_NAME = "law-firm";
const SERVER_VERSION = "1.0.0";

export function buildFirmMcpServer(
  identity: ChannelIdentity | undefined,
  deps: ToolDeps,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerMyOpenTasks(server, identity, deps);
  registerFindTasks(server, identity, deps);
  registerGetCase(server, identity, deps);
  registerUpcomingHearings(server, identity, deps);
  registerFirmOverview(server, identity, deps);
  registerUpdateTaskStatus(server, identity, deps);
  registerAddCaseNote(server, identity, deps);
  return server;
}
