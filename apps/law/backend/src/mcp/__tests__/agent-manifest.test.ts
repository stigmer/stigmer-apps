/**
 * The firm's MCP surface runs unattended: no tool may declare itself
 * destructive.
 *
 * Why this is a test and not a comment: WhatsApp is an unattended
 * surface. The Stigmer platform asks for approval before an MCP tool
 * whose server marks it destructive (`annotations.destructiveHint:
 * true`), and an approval-gated tool on an unattended surface is
 * SILENTLY SKIPPED — the lawyer hears "I couldn't do that", nothing is
 * logged, and no test at any other level notices. A tool that gains the
 * hint ships a verb that cannot run on the channel the firm uses most.
 * The writes do not need the hint: their consent is conversational (the
 * instructions' read-back-and-confirm) and their authority is the firm's
 * policy module.
 *
 * The test enumerates the surface the way the server builds it, through
 * every registrar, and reads each tool's declared annotations. It also
 * checks that the agent manifest template carries no tool lists or
 * approval settings, which would narrow or gate that surface behind the
 * server's back.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FIRM_TOOL_REGISTRARS } from "../server.js";
import type { ToolDeps } from "../tools/shared.js";

const MANIFEST = new URL("../../../../deploy/stigmer/agent.yaml", import.meta.url);

interface RegisteredTool {
  readonly name: string;
  readonly destructiveHint: unknown;
}

/** The registrars only ever call `registerTool(name, config, handler)`;
 * capturing that call enumerates the surface and its annotations without
 * touching the MCP SDK's internals. */
function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const capturingServer = {
    registerTool(name: string, config: { annotations?: { destructiveHint?: unknown } }) {
      tools.push({ name, destructiveHint: config.annotations?.destructiveHint });
    },
  } as unknown as McpServer;
  // Registration may read deps.ocrEnabled (read_document's description
  // is deployment-conditional) but nothing else; handlers are gated at
  // call time (server.ts). Empty deps leaves ocrEnabled undefined, which
  // reads as OCR-off — this registration exercises the OCR-off shape.
  const deps = {} as ToolDeps;
  for (const register of FIRM_TOOL_REGISTRARS) {
    register(capturingServer, undefined, deps);
  }
  return tools;
}

describe("the firm's MCP surface runs on an unattended channel", () => {
  it("has no tool that declares destructiveHint: true", () => {
    const tools = registeredTools();
    // A capture that found nothing would make the assertion vacuous.
    expect(tools.length).toBeGreaterThan(0);
    const destructive = tools.filter((t) => t.destructiveHint === true).map((t) => t.name);
    expect(destructive, "a destructive tool is approval-gated and silently skipped on WhatsApp").toEqual([]);
  });

  it("the agent manifest template carries no tool lists or approval settings", () => {
    const yaml = readFileSync(MANIFEST, "utf8");
    for (const key of ["tools:", "disallowed_tools:", "disallowedTools:", "tool_approval_overrides:", "enabled_tools:"]) {
      expect(new RegExp(`^\\s*${key}`, "m").test(yaml), `agent.yaml carries ${key}`).toBe(false);
    }
  });
});
