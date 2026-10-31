/**
 * Acme's server settings, from the environment, and its secrets file.
 *
 * The secrets file is what `npm run setup` writes for each customer: the key of the minting service
 * account inside the customer's organization, and the customer's key for the ledger server. It
 * lives outside the repository (`ACME_SECRETS_FILE`), readable by its owner only. A Stigmer key never
 * reaches the browser: the page gets short-lived user tokens from `/api/token`.
 */
import { readFileSync, statSync } from "node:fs";
import { CUSTOMERS } from "../fixtures/books.js";

/** One customer's secrets. */
export interface CustomerSecrets {
  /** The key of the service account inside the customer's organization that signs its people in. */
  readonly minterKey: string;
  /** The customer's key for Acme's ledger server, also held in a vault in the customer's organization. */
  readonly ledgerKey: string;
}

export interface SecretsFile {
  readonly customers: Readonly<Record<string, CustomerSecrets>>;
}

export interface ServerConfig {
  readonly stigmerUrl: string;
  readonly secrets: SecretsFile;
  /** The page and `/api`, on 127.0.0.1 only: this listener is never put behind the tunnel. */
  readonly appPort: number;
  /** The ledger MCP server, on 127.0.0.1; the tunnel points here and nowhere else. */
  readonly mcpPort: number;
}

function port(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, not ${JSON.stringify(raw)}.`);
  return n;
}

/** Parses a secrets file's text, refusing one that lacks a customer or a key. */
export function parseSecrets(text: string): SecretsFile {
  const parsed: unknown = JSON.parse(text);
  const customers = (parsed as { customers?: Record<string, Partial<CustomerSecrets>> }).customers ?? {};
  for (const customer of CUSTOMERS) {
    const entry = customers[customer.slug];
    if (!entry?.minterKey || !entry.ledgerKey) {
      throw new Error(`The secrets file has no minterKey and ledgerKey for ${customer.slug}: run npm run setup first.`);
    }
  }
  return { customers: customers as Record<string, CustomerSecrets> };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const path = env.ACME_SECRETS_FILE;
  if (!path) throw new Error("Set ACME_SECRETS_FILE to the secrets file npm run setup wrote.");
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by others; chmod 600 it.`);
  }
  return {
    stigmerUrl: env.STIGMER_URL ?? "https://api.stigmer.ai",
    secrets: parseSecrets(readFileSync(path, "utf8")),
    appPort: port("APP_PORT", 5173, env),
    mcpPort: port("MCP_PORT", 8787, env),
  };
}
