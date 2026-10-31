/**
 * Acme Books' `ledger` MCP server, the one the Agent lists in its own `mcp_servers`: reading a
 * customer's budgets asks nobody, and posting an adjustment is marked destructive, so Stigmer stops
 * the turn on an approval card before the call reaches here.
 *
 * Who is calling is decided in two steps, in this order:
 *
 * 1. The bearer key decides the customer. Each customer's key lives in a vault in that customer's
 *    own organization, so a run can only carry the key of the customer it belongs to. An unknown
 *    key is refused before anything is read.
 * 2. Only then is the caller identity read (`X-Stigmer-Caller-Kind`/`-Value`, filled by Stigmer's
 *    runner, never by the model), and only to name the person on the adjustment. On a public
 *    address anyone can send those headers, so on their own they decide nothing: a name that is
 *    not one of the key's customer's people is recorded as unknown, never trusted into another
 *    customer.
 *
 * Every request gets a fresh, stateless server (no MCP session id): the runner may reconnect after
 * a restart, and nothing here may depend on a connection outliving one call.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ACCOUNTS, type Customer } from "../fixtures/books.js";
import { AdjustmentRefused, type Books } from "./books.js";

export const CALLER_KIND_HEADER = "x-stigmer-caller-kind";
export const CALLER_VALUE_HEADER = "x-stigmer-caller-value";

/** What the server needs: the books, and which customer a bearer key belongs to. */
export interface LedgerServerDeps {
  readonly books: Books;
  readonly customerForKey: (key: string) => Customer | undefined;
  /** Each call that reached the books, for the presenter's console. */
  readonly onCall?: (call: { tool: string; customer: string; by: string }) => void;
}

/** The person an adjustment is recorded for: the key's customer's person the identity names, or unknown. */
export function postedBy(customer: Customer, kind: string | undefined, value: string | undefined): string {
  const person = kind === "stigmer_user" ? customer.people.find((p) => p.email === value) : undefined;
  return person ? `${person.name}, through the agent` : `Someone at ${customer.name}, through the agent`;
}

function bearerKey(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The MCP server for one call, bound to the customer its key decided and the person it names. */
export function ledgerServer(deps: LedgerServerDeps, customer: Customer, by: string): McpServer {
  const server = new McpServer({ name: "ledger", version: "1.0.0" });

  server.registerTool(
    "get_budgets",
    {
      description: `The customer's budget for each account (${ACCOUNTS.join(", ")}) this quarter.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      deps.onCall?.({ tool: "get_budgets", customer: customer.slug, by });
      const view = deps.books.view(customer);
      const budgets = { quarter: view.customer.quarter, budgets: view.accounts.map(({ account, budget }) => ({ account, budget })) };
      return { content: [{ type: "text", text: JSON.stringify(budgets) }] };
    },
  );

  server.registerTool(
    "post_adjustment",
    {
      description:
        "Move an amount from one account to another in the customer's ledger, to correct a line booked to the wrong account. Posts to the customer's real books.",
      inputSchema: {
        from_account: z.enum(ACCOUNTS).describe("The account the line was wrongly booked to."),
        to_account: z.enum(ACCOUNTS).describe("The account it belongs to."),
        amount: z.number().positive().describe("The amount to move."),
        reason: z.string().min(1).describe("Why, in one line."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
    },
    async (input) => {
      deps.onCall?.({ tool: "post_adjustment", customer: customer.slug, by });
      try {
        const posted = deps.books.post(customer, {
          from: input.from_account,
          to: input.to_account,
          amount: input.amount,
          reason: input.reason,
          by,
        });
        const after = deps.books.view(customer).accounts.filter((a) => a.account === posted.from || a.account === posted.to);
        return { content: [{ type: "text", text: JSON.stringify({ posted, after }) }] };
      } catch (error) {
        if (error instanceof AdjustmentRefused) {
          return { isError: true, content: [{ type: "text", text: error.message }] };
        }
        throw error;
      }
    },
  );

  return server;
}

/** The HTTP handler behind `/mcp`. */
export function ledgerHandler(deps: LedgerServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const customer = deps.customerForKey(bearerKey(req));
    if (!customer) {
      res.writeHead(401, { "content-type": "text/plain" }).end("Unknown key.");
      return;
    }
    const by = postedBy(customer, header(req, CALLER_KIND_HEADER), header(req, CALLER_VALUE_HEADER));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: unknown;
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("The body is not JSON.");
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = ledgerServer(deps, customer, by);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
