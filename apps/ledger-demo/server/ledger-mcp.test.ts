/**
 * The ledger MCP server over real HTTP, through the MCP SDK's own client: what it lists, what each
 * tool is marked, and above all who it lets touch which books. The key decides the customer; the
 * caller identity only names the person, and only once the key has passed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CUSTOMERS, customerBySlug, type Customer } from "../fixtures/books.js";
import { Books } from "./books.js";
import { ledgerHandler, postedBy } from "./ledger-mcp.js";

const northwind = customerBySlug("northwind-books")!;
const blueFern = customerBySlug("blue-fern-press")!;
const KEYS: Record<string, Customer> = { "key-northwind": northwind, "key-bluefern": blueFern };

let books: Books;
let server: Server;
let url: URL;
let calls: { tool: string; customer: string; by: string }[];

beforeEach(async () => {
  books = new Books(CUSTOMERS);
  calls = [];
  const handle = ledgerHandler({ books, customerForKey: (key) => KEYS[key], onCall: (c) => calls.push(c) });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

const dana = { "x-stigmer-caller-kind": "stigmer_user", "x-stigmer-caller-value": "dana@northwind.example" };

describe("the ledger server", () => {
  it("lists get_budgets as read-only and post_adjustment as destructive", async () => {
    const client = await connect({ authorization: "Bearer key-northwind" });
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(byName).sort()).toEqual(["get_budgets", "post_adjustment"]);
    expect(byName.get_budgets).toMatchObject({ readOnlyHint: true });
    expect(byName.get_budgets?.destructiveHint).not.toBe(true);
    expect(byName.post_adjustment).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    await client.close();
  });

  it("refuses an unknown key before reading anything", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer not-a-key", "content-type": "application/json", accept: "application/json, text/event-stream", ...dana },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a request with no key at all", async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("answers each key with its own customer's budgets", async () => {
    const client = await connect({ authorization: "Bearer key-bluefern" });
    const result = await client.callTool({ name: "get_budgets", arguments: {} });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text).budgets).toContainEqual({ account: "Marketing", budget: blueFern.budgets.Marketing });
    expect(calls).toEqual([{ tool: "get_budgets", customer: "blue-fern-press", by: "Someone at Blue Fern Press, through the agent" }]);
    await client.close();
  });

  it("posts only to the key's customer, whatever person the identity headers name", async () => {
    // Blue Fern's key with Dana's identity: a forged header must not reach Northwind's books.
    const client = await connect({ authorization: "Bearer key-bluefern", ...dana });
    await client.callTool({
      name: "post_adjustment",
      arguments: { from_account: "Marketing", to_account: "Software", amount: 100, reason: "test" },
    });
    expect(books.view(northwind).adjustments).toEqual([]);
    const posted = books.view(blueFern).adjustments;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.by).toBe("Someone at Blue Fern Press, through the agent");
    await client.close();
  });

  it("records the person the identity names when they belong to the key's customer", async () => {
    const client = await connect({ authorization: "Bearer key-northwind", ...dana });
    const result = await client.callTool({
      name: "post_adjustment",
      arguments: { from_account: "Marketing", to_account: "Software", amount: 4800, reason: "Pixelform is software" },
    });
    expect(result.isError).toBeFalsy();
    const view = books.view(northwind);
    expect(view.adjustments[0]).toMatchObject({ from: "Marketing", to: "Software", amount: 4800, by: "Dana, through the agent" });
    expect(view.accounts.find((a) => a.account === "Marketing")!.variance).toBe(0);
    expect(view.accounts.find((a) => a.account === "Software")!.variance).toBe(0);
    await client.close();
  });

  it("answers a refused adjustment as a tool error, posting nothing", async () => {
    const client = await connect({ authorization: "Bearer key-northwind" });
    const result = await client.callTool({
      name: "post_adjustment",
      arguments: { from_account: "Marketing", to_account: "Marketing", amount: 10, reason: "same" },
    });
    expect(result.isError).toBe(true);
    expect(books.view(northwind).adjustments).toEqual([]);
    await client.close();
  });
});

describe("postedBy", () => {
  it("names only a person of the key's customer, and only for a Stigmer user", () => {
    expect(postedBy(northwind, "stigmer_user", "dana@northwind.example")).toBe("Dana, through the agent");
    expect(postedBy(northwind, "stigmer_user", "priya@bluefern.example")).toBe("Someone at Northwind Books, through the agent");
    expect(postedBy(northwind, "anonymous", "dana@northwind.example")).toBe("Someone at Northwind Books, through the agent");
    expect(postedBy(northwind, undefined, undefined)).toBe("Someone at Northwind Books, through the agent");
  });
});
