/**
 * `npm run setup -- --ledger-url https://<tunnel> [--origin http://localhost:5173] [--dry-run]`
 *
 * Builds Acme Books' world on a Stigmer (`converge.ts` says what and why) and writes the secrets file
 * Acme's server reads. Needs:
 *
 * - `STIGMER_URL`: the Stigmer (https://api.stigmer.ai by default);
 * - `STIGMER_ADMIN_KEY`: a key of an admin of acme-books, bound to it;
 * - `ACME_SECRETS_FILE`: where the customers' minting keys and ledger keys are kept, outside the
 *   repository; created with mode 600 when missing, and read back on every run;
 * - `ANTHROPIC_API_KEY`, only on the first run, for the organization's model key.
 *
 * Run it again whenever the tunnel's address changes, before the first message: a conversation
 * keeps the Agent version it started on.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { converge, SetupRefused, type SetupSecrets } from "./converge.js";
import { stigmerPort } from "./stigmer-port.js";

const { values } = parseArgs({
  options: {
    "ledger-url": { type: "string" },
    origin: { type: "string", default: "http://localhost:5173" },
    "dry-run": { type: "boolean", default: false },
  },
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name}.`);
    process.exit(2);
  }
  return value;
}

const ledgerUrl = values["ledger-url"];
if (!ledgerUrl) {
  console.error("Pass --ledger-url, the ledger server's public https address (the tunnel's).");
  process.exit(2);
}
const secretsFile = required("ACME_SECRETS_FILE");
const previous: SetupSecrets = existsSync(secretsFile)
  ? (JSON.parse(readFileSync(secretsFile, "utf8")) as SetupSecrets)
  : { customers: {} };

try {
  const result = await converge(
    stigmerPort(process.env.STIGMER_URL ?? "https://api.stigmer.ai", required("STIGMER_ADMIN_KEY")),
    { ledgerUrl, origin: values.origin!, anthropicKey: process.env.ANTHROPIC_API_KEY },
    previous,
    { apply: !values["dry-run"] },
  );
  for (const line of result.lines) console.log(line);
  if (!values["dry-run"]) writeFileSync(secretsFile, JSON.stringify(result.secrets, null, 2) + "\n", { mode: 0o600 });
  console.log(result.changed === 0 ? "Nothing changed." : `${result.changed} ${values["dry-run"] ? "would change" : "changed"}.`);
} catch (error) {
  if (error instanceof SetupRefused) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
