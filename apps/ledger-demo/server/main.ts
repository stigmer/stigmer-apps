/**
 * Acme Books' server: one process, one port.
 *
 * - `/mcp`: the ledger MCP server the Agent lists. A Stigmer Cloud sandbox reaches it over HTTPS at
 *   the app's public address, and every request must carry a customer's key.
 * - `/api`: Acme's own backend for its page, behind Acme's sign-in.
 * - `/healthz`: for the platform's probes.
 * - everything else: the built page (`npm run build` first), `/stage` included.
 *
 * Hosted, it runs in a container on PORT 8080 behind the environment's TLS. Locally:
 * `ACME_PASSCODE=… ACME_SECRETS_FILE=… npm start`, then http://localhost:5173.
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
import { Sessions } from "./session.js";

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
  sessions: new Sessions(config.passcode),
  secureCookies: config.secureCookies,
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

const ledger = ledgerHandler({
  books,
  customerForKey: (key) => byLedgerKey.get(key),
  onCall: (call) => console.log(`ledger: ${call.tool} for ${call.customer} (${call.by})`),
  onRefused: () => console.log("ledger: refused a request with an unknown key"),
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
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/mcp") return await ledger(req, res);
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (await api(req, res)) return;
      const page = await servePage(path);
      if (!page) {
        res.writeHead(404).end("Not found.");
        return;
      }
      res.writeHead(200, { "content-type": page.type }).end(page.body);
    } catch (error) {
      console.error("acme:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  })();
}).listen(config.port, () => {
  console.log(`Acme Books on port ${config.port} (Stigmer at ${config.stigmerUrl}); the ledger MCP server at /mcp`);
});
