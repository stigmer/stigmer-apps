/**
 * Acme Books' server: two listeners, both on 127.0.0.1.
 *
 * - The app (`APP_PORT`, 5173 by default): the built page from `dist/` and `/api`. It mints Stigmer
 *   tokens, so it is never exposed beyond this machine.
 * - The ledger (`MCP_PORT`, 8787 by default): `/mcp` alone. This is the one port a tunnel puts on a
 *   public address, because a Stigmer Cloud sandbox reaches an Agent's MCP server over HTTPS; every
 *   request there must carry a customer's key.
 *
 * Run `npm run build` first, then `ACME_SECRETS_FILE=<path> npm start`.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeClient } from "@stigmer/client/node";
import { CUSTOMERS, type Customer } from "../fixtures/books.js";
import { apiHandler, type MintedToken } from "./api.js";
import { Books } from "./books.js";
import { loadConfig } from "./config.js";
import { ledgerHandler } from "./ledger-mcp.js";

const config = loadConfig();
const books = new Books(CUSTOMERS);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const minters = new Map(
  CUSTOMERS.map((c) => [c.slug, createNodeClient({ baseUrl: config.stigmerUrl, apiKey: config.secrets.customers[c.slug]!.minterKey })]),
);
const byLedgerKey = new Map<string, Customer>(CUSTOMERS.map((c) => [config.secrets.customers[c.slug]!.ledgerKey, c]));

const api = apiHandler({
  books,
  stigmerUrl: config.stigmerUrl,
  mint: async (customer, person): Promise<MintedToken> => {
    const minted = await minters.get(customer.slug)!.tokens.mintUserToken({
      org: customer.slug,
      userId: person.id,
      userEmail: person.email,
      userName: person.name,
    });
    return { accessToken: minted.accessToken, expiresAt: minted.expiresAt };
  },
});

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** A file of the built page, or index.html for any page route (`/`, `/stage`). */
async function servePage(pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  const wanted = normalize(join(dist, decodeURIComponent(pathname)));
  if (!wanted.startsWith(dist) && wanted + sep !== dist) return undefined;
  const file = extname(wanted) === "" ? join(dist, "index.html") : wanted;
  try {
    return { body: await readFile(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}

createServer((req, res) => {
  void (async () => {
    try {
      if (await api(req, res)) return;
      const page = await servePage(new URL(req.url ?? "/", "http://localhost").pathname);
      if (!page) {
        res.writeHead(404).end("Not found. Run npm run build first.");
        return;
      }
      res.writeHead(200, { "content-type": page.type }).end(page.body);
    } catch (error) {
      console.error("app:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
}).listen(config.appPort, "127.0.0.1", () => {
  console.log(`Acme Books: http://localhost:${config.appPort} (Stigmer at ${config.stigmerUrl})`);
});

const ledger = ledgerHandler({
  books,
  customerForKey: (key) => byLedgerKey.get(key),
  onCall: (call) => console.log(`ledger: ${call.tool} for ${call.customer} (${call.by})`),
});

createServer((req, res) => {
  void (async () => {
    try {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      await ledger(req, res);
    } catch (error) {
      console.error("ledger:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
}).listen(config.mcpPort, "127.0.0.1", () => {
  console.log(`Ledger MCP server: http://127.0.0.1:${config.mcpPort}/mcp (point the tunnel here)`);
});
