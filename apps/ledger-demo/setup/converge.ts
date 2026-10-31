/**
 * The setup: makes a Stigmer hold Acme Books' world, and changes only what differs.
 *
 * What it makes, in order:
 *
 * 1. Acme's organization must exist, on a plan with room for every customer's child organization.
 *    The setup never creates it or buys the plan: that is a person's sign-up and checkout.
 * 2. Acme's model key: saved only when the organization has none and one is given.
 * 3. Acme's embedding settings: accounts created on sign-in, as members, from the page's origin only.
 * 4. The Agent, shared with every child organization, with Acme's `ledger` server in its own
 *    `mcp_servers`. The server's headers carry the customer's key from a vault and the caller
 *    identity Stigmer's runner fills in.
 * 5. Per customer, its child organization (found by Acme's own customer id), and in it:
 *    - a vault holding the customer's ledger key;
 *    - the minting service account, `acme-minter`;
 *    - embedding settings naming that vault.
 *    A child's embedding vaults reach a run only when the person was minted by a service account of
 *    that same organization, which is why each customer has a minter of its own instead of Acme's.
 *
 * A write happens only when what exists differs from what Acme needs, so a second run prints
 * "unchanged" for every line and writes nothing. With `apply: false` it writes nothing at all and
 * prints what it would change.
 */
import { randomBytes } from "node:crypto";
import { ACME, CUSTOMERS, type Customer } from "../fixtures/books.js";
import type { AgentSpec, Embedding, StigmerPort } from "./port.js";

/** What the person running the setup provides. */
export interface SetupInputs {
  /** The ledger server's public address, the tunnel's (`https://…`), without `/mcp`. */
  readonly ledgerUrl: string;
  /** The page's origin, the only one tokens work from. */
  readonly origin: string;
  /** Acme's Anthropic key, saved only when the organization has no model key. */
  readonly anthropicKey?: string;
}

/** What `server/config.ts` reads back: per customer, the minter's key and the ledger key. */
export interface SetupSecrets {
  customers: Record<string, { minterKey?: string; ledgerKey?: string }>;
}

export interface SetupResult {
  readonly lines: readonly string[];
  readonly secrets: SetupSecrets;
  readonly changed: number;
}

export class SetupRefused extends Error {}

export const LEDGER_SERVER = "ledger";
export const LEDGER_KEY = "ACME_LEDGER_KEY";
export const LEDGER_VAULT = "acme-ledger";
export const MINTER = "acme-minter";

export const AGENT_INSTRUCTIONS = `You review a customer's quarterly ledger for Acme Books. The attached file has one row per booked line: date, vendor, description, account and amount.

Read the customer's budgets with the ledger server's get_budgets. For every account, add up its lines and work out the variance (actual minus budget), in money and as a percentage of the budget.

Look behind the largest variances at the lines themselves. When one line is plainly booked to the wrong account (a purchase whose description belongs to another account), correct it with post_adjustment: move exactly that line's amount from the account it was booked to into the one it belongs to, with a one-line reason naming the vendor. Post at most one adjustment, and only for a line that is clearly miscoded; never adjust to make the numbers fit.

Save the report as variance-report.md in your outputs folder: a two-sentence summary that says what you corrected, then one table of every account with its budget, its actual after the correction and its variance.`;

/** The Agent Acme shares with every customer. */
export function agentSpec(ledgerUrl: string): AgentSpec {
  return {
    org: ACME.org,
    slug: ACME.agent,
    description: "Reviews a customer's quarter against their budgets and corrects one miscoded line.",
    instructions: AGENT_INSTRUCTIONS,
    sharedWithChildOrgs: true,
    disallowedTools: ["Bash"],
    env: { [LEDGER_KEY]: { isSecret: true, description: "The customer's key for Acme Books' ledger server." } },
    mcpServers: [
      {
        name: LEDGER_SERVER,
        url: `${ledgerUrl.replace(/\/+$/, "")}/mcp`,
        headers: {
          Authorization: `Bearer \${${LEDGER_KEY}}`,
          "X-Stigmer-Caller-Kind": "${STIGMER_CALLER_IDENTITY_KIND}",
          "X-Stigmer-Caller-Value": "${STIGMER_CALLER_IDENTITY_VALUE}",
        },
      },
    ],
  };
}

function sameEmbedding(a: Embedding, b: Embedding): boolean {
  const set = (xs: readonly string[]) => [...xs].sort().join("\n");
  return (
    a.createAccountsOnSignIn === b.createAccountsOnSignIn &&
    a.signInRole === b.signInRole &&
    set(a.allowedOrigins) === set(b.allowedOrigins) &&
    set(a.vaults) === set(b.vaults)
  );
}

/** Whether two Agents agree on everything the setup writes. */
export function sameAgent(a: AgentSpec, b: AgentSpec): boolean {
  const canonical = (x: AgentSpec) =>
    JSON.stringify({
      ...x,
      disallowedTools: [...x.disallowedTools].sort(),
      env: Object.fromEntries(Object.entries(x.env).sort(([k], [l]) => k.localeCompare(l))),
      mcpServers: [...x.mcpServers]
        .sort((m, n) => m.name.localeCompare(n.name))
        .map((m) => ({ ...m, headers: Object.fromEntries(Object.entries(m.headers).sort(([k], [l]) => k.localeCompare(l))) })),
    });
  return canonical(a) === canonical(b);
}

function newLedgerKey(): string {
  return `lk_${randomBytes(24).toString("base64url")}`;
}

/** Runs the setup against `port`. `secrets` is the previous run's file (empty on a first run). */
export async function converge(
  port: StigmerPort,
  inputs: SetupInputs,
  secrets: SetupSecrets,
  options: { apply: boolean },
): Promise<SetupResult> {
  if (!/^https:\/\//.test(inputs.ledgerUrl)) {
    throw new SetupRefused("The ledger server's address must be https: a Stigmer Cloud sandbox reaches it over the internet.");
  }
  const lines: string[] = [];
  let changed = 0;
  const next: SetupSecrets = { customers: structuredClone(secrets.customers) };
  const will = options.apply ? "" : "would be ";
  const note = (what: string, change: string | undefined) => {
    if (change === undefined) lines.push(`unchanged  ${what}`);
    else {
      changed += 1;
      lines.push(`${options.apply ? "changed" : "would change"}  ${what}: ${change}`);
    }
  };

  const acme = await port.organization(ACME.org);
  if (!acme) throw new SetupRefused(`No organization ${ACME.org}: sign up and create it, then run the setup with its admin's key.`);
  const room = await port.includedChildOrgs(acme.id);
  if (room < CUSTOMERS.length) {
    throw new SetupRefused(
      `${ACME.org}'s plan includes ${room} child organizations and the demo needs ${CUSTOMERS.length}: move it to a plan with child organizations first.`,
    );
  }
  note(`${ACME.org} has room for ${CUSTOMERS.length} customers`, undefined);

  if (await port.hasProviderKey(acme.id, "anthropic")) {
    note(`${ACME.org}'s Anthropic key`, undefined);
  } else if (inputs.anthropicKey) {
    if (options.apply) await port.setProviderKey(acme.id, "anthropic", inputs.anthropicKey);
    note(`${ACME.org}'s Anthropic key`, `${will}saved`);
  } else {
    throw new SetupRefused(`${ACME.org} has no Anthropic key: set ANTHROPIC_API_KEY for this run.`);
  }

  const acmeEmbedding: Embedding = { createAccountsOnSignIn: true, signInRole: "member", allowedOrigins: [inputs.origin], vaults: [] };
  if (sameEmbedding(acme.embedding, acmeEmbedding)) note(`${ACME.org}'s embedding settings`, undefined);
  else {
    if (options.apply) await port.updateEmbedding(acme.id, acmeEmbedding);
    note(`${ACME.org}'s embedding settings`, `${will}set to accounts on sign-in as members, from ${inputs.origin}`);
  }

  const wanted = agentSpec(inputs.ledgerUrl);
  const existing = await port.agent(ACME.org, ACME.agent);
  if (existing && sameAgent(existing, wanted)) note(`the Agent ${ACME.org}/${ACME.agent}`, undefined);
  else {
    if (options.apply) await port.applyAgent(wanted);
    note(`the Agent ${ACME.org}/${ACME.agent}`, existing ? `${will}updated (ledger at ${wanted.mcpServers[0]!.url})` : `${will}created`);
  }

  for (const customer of CUSTOMERS) {
    await convergeCustomer(port, acme.id, customer, inputs, next, options, note, will);
  }
  return { lines, secrets: next, changed };
}

async function convergeCustomer(
  port: StigmerPort,
  acmeId: string,
  customer: Customer,
  inputs: SetupInputs,
  secrets: SetupSecrets,
  options: { apply: boolean },
  note: (what: string, change: string | undefined) => void,
  will: string,
): Promise<void> {
  const mine = (secrets.customers[customer.slug] ??= {});

  let child = await port.childByExternalId(acmeId, customer.externalId);
  if (child) note(`${customer.name}'s organization ${customer.slug}`, undefined);
  else {
    note(`${customer.name}'s organization ${customer.slug}`, `${will}created under ${ACME.org}`);
    if (!options.apply) return;
    child = await port.createChild(acmeId, { name: customer.name, slug: customer.slug, externalId: customer.externalId });
  }

  const vault = await port.vault(customer.slug, LEDGER_VAULT);
  let vaultId = vault?.id;
  if (!vaultId) {
    if (options.apply) {
      vaultId = (await port.createVault(child.id, { name: LEDGER_VAULT, slug: LEDGER_VAULT, description: `${customer.name}'s key for Acme Books' ledger server.` })).id;
    }
    note(`${customer.slug}'s vault ${LEDGER_VAULT}`, `${will}created`);
  } else note(`${customer.slug}'s vault ${LEDGER_VAULT}`, undefined);

  const keyNew = !mine.ledgerKey;
  if (keyNew) mine.ledgerKey = newLedgerKey();
  if (!keyNew && vault?.secretNames.includes(LEDGER_KEY)) note(`${customer.slug}'s ${LEDGER_KEY}`, undefined);
  else {
    if (options.apply && vaultId) await port.setVaultSecret(child.id, vaultId, LEDGER_KEY, mine.ledgerKey!, `${customer.name}'s ledger key`);
    note(`${customer.slug}'s ${LEDGER_KEY}`, `${will}saved in ${LEDGER_VAULT}`);
  }

  let minter = await port.serviceAccount(child.id, MINTER);
  if (minter) note(`${customer.slug}'s minting service account ${MINTER}`, undefined);
  else {
    if (options.apply) minter = await port.createServiceAccount(child.id, MINTER, "admin");
    note(`${customer.slug}'s minting service account ${MINTER}`, `${will}created`);
  }
  const keyActs = mine.minterKey && minter ? await port.keyAccount(mine.minterKey) : undefined;
  if (minter && keyActs === minter.id) note(`${customer.slug}'s minting key`, undefined);
  else {
    if (options.apply && minter) mine.minterKey = await port.createServiceAccountKey(minter.id, `${MINTER}-key`);
    note(`${customer.slug}'s minting key`, `${will}made`);
  }

  const embedding: Embedding = {
    createAccountsOnSignIn: true,
    signInRole: "member",
    allowedOrigins: [inputs.origin],
    vaults: [`${customer.slug}/${LEDGER_VAULT}`],
  };
  if (sameEmbedding(child.embedding, embedding)) note(`${customer.slug}'s embedding settings`, undefined);
  else {
    if (options.apply) await port.updateEmbedding(child.id, embedding);
    note(`${customer.slug}'s embedding settings`, `${will}set to accounts on sign-in as members, from ${inputs.origin}, with ${LEDGER_VAULT}`);
  }
}
