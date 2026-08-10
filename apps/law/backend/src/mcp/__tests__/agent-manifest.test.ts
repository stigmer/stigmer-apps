/**
 * Manifest drift: every tool the MCP server registers MUST carry a
 * `requires_approval: false` override in the deployed agent manifest.
 *
 * Why this is a test and not a comment: WhatsApp is an unattended
 * surface. The platform's connect-time classifier approval-gates any
 * tool without an override, and an approval-gated tool on an unattended
 * surface is SILENTLY SKIPPED — the lawyer hears "I couldn't do that",
 * nothing is logged, and no test at any other level notices. Adding a
 * tool to the server without adding it to the manifest ships a verb
 * that cannot run, and the failure is invisible until a person in a
 * corridor needs it.
 *
 * The manifest is parsed with a narrow regex rather than a YAML
 * dependency: `- tool_name: <name>` is the only shape this block has
 * ever had, and the assertion below fails loudly if the file stops
 * matching it at all (an empty parse cannot pass).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FIRM_TOOL_REGISTRARS } from "../server.js";
import type { ToolDeps } from "../tools/shared.js";

const MANIFEST = new URL("../../../../deploy/stigmer/agent.yaml", import.meta.url);

/** The registrars only ever call `registerTool(name, config, handler)`;
 * capturing that call enumerates the surface without touching the MCP
 * SDK's internals. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const capturingServer = {
    registerTool(name: string) {
      names.push(name);
    },
  } as unknown as McpServer;
  // Identity and deps are never touched at registration time (tools are
  // registered for every caller, gated at call time — server.ts).
  const deps = {} as ToolDeps;
  for (const register of FIRM_TOOL_REGISTRARS) {
    register(capturingServer, undefined, deps);
  }
  return names;
}

function manifestApprovalOverrides(): string[] {
  const yaml = readFileSync(MANIFEST, "utf8");
  return [...yaml.matchAll(/^\s*-\s*tool_name:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
}

describe("the deployed agent manifest and the MCP surface agree", () => {
  it("declares an approval override for EVERY registered tool", () => {
    const registered = registeredToolNames().sort();
    const declared = manifestApprovalOverrides().sort();

    // A parse that found nothing would make the comparison vacuous.
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared,
      "a registered tool missing from agent.yaml is silently skipped on WhatsApp",
    ).toEqual(registered);
  });

  it("declares no override for a tool that does not exist", () => {
    // The other direction: a stale entry is a rename that half-landed,
    // which leaves the real tool gated and dead.
    const registered = new Set(registeredToolNames());
    for (const declared of manifestApprovalOverrides()) {
      expect(registered.has(declared), `agent.yaml declares unknown tool '${declared}'`).toBe(
        true,
      );
    }
  });
});
