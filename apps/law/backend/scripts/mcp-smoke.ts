/**
 * MCP smoke — drives the firm's MCP entrance the way the agent platform
 * does: real streamable HTTP, the shared secret as the Bearer, the
 * caller identity asserted in headers. This is how a deploy is
 * ACCEPTED (the reference project's committed-smoke-script practice):
 * run it against a URL and read the answers.
 *
 *   # Against a local dev server (e2e/serve.ts prints its MCP port):
 *   npx tsx scripts/mcp-smoke.ts --url http://localhost:8081 \
 *     --secret <MCP_SHARED_SECRET> --wa 91123456
 *
 *   # Against a deployed firm (from a pod inside the cluster):
 *   npx tsx scripts/mcp-smoke.ts \
 *     --url http://<deployment>.<namespace>.svc.cluster.local:8081 \
 *     --secret <MCP_SHARED_SECRET> --wa <staff-wa-id>
 *
 * Read-only by design: it lists tools, asks firm_overview and
 * my_open_tasks, and proves the identity gate (an anonymous call must
 * be refused with the no-identity sentence). It never calls a write
 * tool — a smoke test that mutates a firm's records is not a smoke
 * test.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = arg("url");
const secret = arg("secret");
const wa = arg("wa");

if (!url || !secret) {
  console.error(
    "usage: npx tsx scripts/mcp-smoke.ts --url <mcp-base-url> --secret <shared-secret> [--wa <wa-id>]",
  );
  process.exit(2);
}

function connect(identity?: { kind: string; value: string }): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), {
    requestInit: {
      headers: {
        authorization: `Bearer ${secret}`,
        ...(identity
          ? {
              "x-stigmer-caller-kind": identity.kind,
              "x-stigmer-caller-value": identity.value,
            }
          : {}),
      },
    },
  });
  const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
  return client.connect(transport).then(() => client);
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "(no text)";
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (ok: boolean, label: string, detail?: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  // 1. Anonymous discovery lists the seven tools.
  const anonymous = await connect();
  const { tools } = await anonymous.listTools();
  check(tools.length === 7, `discovery lists 7 tools`, tools.map((t) => t.name).join(", "));

  // 2. An anonymous CALL is refused (the identity gate holds).
  const refused = (await anonymous.callTool({
    name: "firm_overview",
    arguments: {},
  })) as CallToolResult;
  check(refused.isError === true, "anonymous call refused", text(refused));
  await anonymous.close();

  // 3. As a staff identity: the two read answers a demo leans on.
  if (wa) {
    const staff = await connect({ kind: "whatsapp_phone", value: wa });
    for (const name of ["firm_overview", "my_open_tasks"]) {
      const result = (await staff.callTool({ name, arguments: {} })) as CallToolResult;
      check(!result.isError, name, text(result).split("\n")[0]);
      console.log(text(result).replace(/^/gm, "      "));
    }
    await staff.close();
  } else {
    console.log("SKIP  staff calls (--wa not given)");
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
