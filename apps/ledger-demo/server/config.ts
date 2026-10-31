/**
 * Acme's server settings, from the environment.
 *
 * The secrets are what `npm run setup` writes for each customer: the key of the minting service
 * account inside the customer's organization, and the customer's key for the ledger server. Hosted,
 * they arrive as one variable (`ACME_SECRETS_JSON`, a Planton secret); run locally, as a file outside
 * the repository readable by its owner only (`ACME_SECRETS_FILE`). A Stigmer key never reaches the
 * browser: the page gets short-lived user tokens from `/api/token`.
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
  /** The one port: the page, `/api`, the ledger server at `/mcp`, and `/healthz`. */
  readonly port: number;
  /** Acme's demo passcode, which lets the presenter sign in. */
  readonly passcode: string;
  /** Whether the session cookie is marked Secure (the page is served over https). */
  readonly secureCookies: boolean;
}

/** The shortest passcode the server accepts: the page is on a public address. */
export const MIN_PASSCODE_LENGTH = 12;

/** Parses the secrets' text, refusing it when a customer or a key is missing. */
export function parseSecrets(text: string): SecretsFile {
  const parsed: unknown = JSON.parse(text);
  const customers = (parsed as { customers?: Record<string, Partial<CustomerSecrets>> }).customers ?? {};
  for (const customer of CUSTOMERS) {
    const entry = customers[customer.slug];
    if (!entry?.minterKey || !entry.ledgerKey) {
      throw new Error(`The secrets have no minterKey and ledgerKey for ${customer.slug}: run npm run setup first.`);
    }
  }
  return { customers: customers as Record<string, CustomerSecrets> };
}

function readSecrets(env: NodeJS.ProcessEnv): SecretsFile {
  if (env.ACME_SECRETS_JSON) return parseSecrets(env.ACME_SECRETS_JSON);
  const path = env.ACME_SECRETS_FILE;
  if (!path) throw new Error("Set ACME_SECRETS_JSON, or ACME_SECRETS_FILE to the file npm run setup wrote.");
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by others; chmod 600 it.`);
  return parseSecrets(readFileSync(path, "utf8"));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const passcode = env.ACME_PASSCODE ?? "";
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    throw new Error(`Set ACME_PASSCODE to at least ${MIN_PASSCODE_LENGTH} characters.`);
  }
  const rawPort = env.PORT ?? "5173";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a port number, not ${JSON.stringify(rawPort)}.`);
  return {
    stigmerUrl: env.STIGMER_URL ?? "https://api.stigmer.ai",
    secrets: readSecrets(env),
    port,
    passcode,
    secureCookies: env.ACME_SECURE_COOKIES === "true",
  };
}
