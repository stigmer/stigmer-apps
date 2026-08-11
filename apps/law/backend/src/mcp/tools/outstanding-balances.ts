/**
 * outstanding_balances — the partner's money glance (journey J5,
 * FR-MONEY-003): what each matter still owes, optionally one client's
 * matters. Partner-gated BY THE POLICY, not by this tool: any other
 * caller gets the policy module's denial sentence relayed verbatim —
 * which is itself the answer FR-AUTHZ-004 requires the assistant to
 * give (the demo's "the clerk cannot hear a balance" beat).
 */

import { create } from "@bufbuild/protobuf";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallerIdentity } from "@stigmer/identity";
import { z } from "zod";
import { SearchClientsRequestSchema } from "../../gen/stigmer/law/client/v1/client_pb.js";
import { ListOutstandingRequestSchema } from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";
import { formatPaise } from "../format.js";
import { errorResult, gated, textResult } from "../gate.js";
import { type ToolDeps } from "./shared.js";

const NAME = "outstanding_balances";

export function registerOutstandingBalances(
  server: McpServer,
  identity: CallerIdentity | undefined,
  deps: ToolDeps,
): string {
  server.registerTool(
    NAME,
    {
      description:
        "Outstanding money per matter — agreed charges plus billed expenses " +
        "minus receipts — largest first, optionally for one client (exact " +
        "client name). Partners only; everyone else is refused.",
      inputSchema: {
        client: z
          .string()
          .min(1)
          .optional()
          .describe("Narrow to one client's matters, by the client's exact name."),
      },
      annotations: { readOnlyHint: true },
    },
    gated(NAME, identity, deps.resolveCallerIdentity, async (args, caller) => {
      let clientId: string | undefined;
      let clientName: string | undefined;
      if (args.client) {
        // Exact-match resolution THROUGH the pipeline (the policy gates
        // the register), same discipline as people: a wrong guess reads
        // out the wrong client's money.
        const needle = args.client.trim().toLowerCase();
        const found = await deps.resources.clients.invoke.search(
          create(SearchClientsRequestSchema, { query: args.client.trim(), limit: 10 }),
          caller.principal,
        );
        const matches = found.clients.filter(
          (c) => c.spec?.displayName?.toLowerCase() === needle,
        );
        if (matches.length === 0) {
          return errorResult(
            `I couldn't find a client called "${args.client.trim()}". Use the exact name from the register.`,
          );
        }
        if (matches.length > 1) {
          return errorResult(
            `More than one client is called "${args.client.trim()}" — open the client register to pick the right one.`,
          );
        }
        clientId = matches[0]?.metadata?.id;
        clientName = matches[0]?.spec?.displayName;
      }

      const page = await deps.resources.ledgerEntries.invoke.listOutstanding(
        create(ListOutstandingRequestSchema, { clientId, pageSize: 20 }),
        caller.principal,
      );
      if (page.items.length === 0) {
        return textResult(
          clientName ? `No matters on the books for ${clientName}.` : "No matters on the books.",
        );
      }

      const lines = page.items.map(
        (line, i) =>
          `${i + 1}. ${line.fileNumber} — outstanding ${formatPaise(line.outstandingPaise)} ` +
          `(charged ${formatPaise(line.chargesPaise + line.expensesPaise)}, received ${formatPaise(line.receiptsPaise)})`,
      );
      const total = page.items.reduce((sum, line) => sum + line.outstandingPaise, 0n);
      const headline = clientName
        ? `${clientName}: outstanding ${formatPaise(total)} across ${page.items.length} matter(s)`
        : `Outstanding across ${page.items.length} matter(s) on this page: ${formatPaise(total)}`;
      return textResult(`${headline}\n${lines.join("\n")}`, {
        items: page.items.map((line) => ({
          file_number: line.fileNumber,
          outstanding_paise: Number(line.outstandingPaise),
        })),
      });
    }),
  );
  return NAME;
}
