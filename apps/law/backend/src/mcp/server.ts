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
import type { CallerIdentity } from "@stigmer/identity";
import { registerAddCaseNote } from "./tools/add-case-note.js";
import { registerAttachDocument } from "./tools/attach-document.js";
import { registerCaseStory } from "./tools/case-story.js";
import { registerFindDocuments } from "./tools/find-documents.js";
import { registerFindTasks } from "./tools/find-tasks.js";
import { registerReadDocument } from "./tools/read-document.js";
import { registerSearchDocuments } from "./tools/search-documents.js";
import { registerFirmOverview } from "./tools/firm-overview.js";
import { registerMyDay } from "./tools/my-day.js";
import { registerMyDeadlines } from "./tools/my-deadlines.js";
import { registerOutstandingBalances } from "./tools/outstanding-balances.js";
import { registerRecordHearingOutcome } from "./tools/record-hearing-outcome.js";
import { registerUpcomingHearings } from "./tools/upcoming-hearings.js";
import { registerUpdateTaskStatus } from "./tools/update-task-status.js";
import { registerWhatHappenedToday } from "./tools/what-happened-today.js";
import type { ToolDeps } from "./tools/shared.js";

/** Domain-shaped, never branded (DD-A2): the vertical is law, firm #N agnostic. */
const SERVER_NAME = "law-firm";
// 2.3: what_happened_today — the day's story, backward-looking (FR-HEAR-007).
const SERVER_VERSION = "2.3.0";

/**
 * Every tool registrar, in one list — the surface's single source of
 * truth. Each returns its own tool name, which is what lets the
 * manifest-drift test enumerate the surface without introspecting the
 * MCP SDK's internals (`__tests__/agent-manifest.test.ts`: a tool the
 * deployed agent manifest does not declare is silently skipped on
 * WhatsApp, so the two lists must never diverge).
 */
export const FIRM_TOOL_REGISTRARS: readonly ((
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
) => string)[] = [
  registerMyDay,
  registerWhatHappenedToday,
  registerMyDeadlines,
  registerFindTasks,
  registerCaseStory,
  registerFindDocuments,
  registerSearchDocuments,
  registerReadDocument,
  registerUpcomingHearings,
  registerRecordHearingOutcome,
  registerFirmOverview,
  registerUpdateTaskStatus,
  registerAddCaseNote,
  registerAttachDocument,
  registerOutstandingBalances,
];

/**
 * The journey verbs (FR-ASST-002): my day, record outcome, case story,
 * upcoming hearings, deadline nudges, find/update tasks, add note,
 * attach document (held back until stigmer/stigmer#532 gave agents a
 * URL hand-off for attachments — the capability probe is GREEN as of
 * 2026-08-13), and the partner-gated balances.
 */
export function buildFirmMcpServer(
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const register of FIRM_TOOL_REGISTRARS) {
    register(server, identity, deps);
  }
  return server;
}
