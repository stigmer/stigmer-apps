/**
 * The setup against an in-memory Stigmer: a first run builds Acme's world, a second writes nothing
 * and reports every line unchanged, a dry run writes nothing at all, and what it refuses it refuses
 * before writing.
 */
import { describe, expect, it } from "vitest";
import { ACME, CUSTOMERS } from "../fixtures/books.js";
import { agentSpec, converge, LEDGER_KEY, LEDGER_VAULT, MINTER, sameAgent, SetupRefused, type SetupSecrets } from "./converge.js";
import type { AgentSpec, Embedding, Org, Role, StigmerPort } from "./port.js";

const NO_EMBEDDING: Embedding = { createAccountsOnSignIn: false, signInRole: "none", allowedOrigins: [], vaults: [] };
const INPUTS = { ledgerUrl: "https://tunnel.example", origin: "http://localhost:5173", anthropicKey: "sk-test" };

/** A Stigmer in memory, counting every write. */
class FakeStigmer implements StigmerPort {
  writes: string[] = [];
  orgs = new Map<string, Org & { parent?: string; externalId?: string }>();
  providerKeys = new Set<string>();
  agents = new Map<string, AgentSpec>();
  vaults = new Map<string, { id: string; org: string; secrets: Map<string, string> }>();
  accounts = new Map<string, { id: string; org: string; name: string; role: Role }>();
  keys = new Map<string, string>();
  childRoom = 5;
  private seq = 0;

  constructor() {
    this.orgs.set(ACME.org, { id: "org_acme", slug: ACME.org, embedding: NO_EMBEDDING });
  }
  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }
  private bySlugOrId(ref: string) {
    return [...this.orgs.values()].find((o) => o.id === ref || o.slug === ref);
  }

  async organization(slug: string) {
    return this.bySlugOrId(slug);
  }
  async childByExternalId(parentId: string, externalId: string) {
    return [...this.orgs.values()].find((o) => o.parent === parentId && o.externalId === externalId);
  }
  async createChild(parentId: string, child: { name: string; slug: string; externalId: string }) {
    this.writes.push(`createChild ${child.slug}`);
    const org = { id: this.id("org"), slug: child.slug, embedding: NO_EMBEDDING, parent: parentId, externalId: child.externalId };
    this.orgs.set(child.slug, org);
    return org;
  }
  async includedChildOrgs() {
    return this.childRoom;
  }
  async updateEmbedding(orgId: string, embedding: Embedding) {
    this.writes.push(`updateEmbedding ${orgId}`);
    const org = this.bySlugOrId(orgId)!;
    this.orgs.set(org.slug, { ...org, embedding });
  }
  async hasProviderKey(orgId: string, provider: string) {
    return this.providerKeys.has(`${orgId}/${provider}`);
  }
  async setProviderKey(orgId: string, provider: string) {
    this.writes.push(`setProviderKey ${orgId}`);
    this.providerKeys.add(`${orgId}/${provider}`);
  }
  async agent(org: string, slug: string) {
    return this.agents.get(`${org}/${slug}`);
  }
  async applyAgent(agent: AgentSpec) {
    this.writes.push(`applyAgent ${agent.slug}`);
    this.agents.set(`${agent.org}/${agent.slug}`, structuredClone(agent));
  }
  async vault(org: string, slug: string) {
    const v = this.vaults.get(`${org}/${slug}`);
    return v && { id: v.id, secretNames: [...v.secrets.keys()] };
  }
  async createVault(orgId: string, vault: { slug: string }) {
    this.writes.push(`createVault ${vault.slug}`);
    const org = this.bySlugOrId(orgId)!;
    const created = { id: this.id("vlt"), org: org.slug, secrets: new Map<string, string>() };
    this.vaults.set(`${org.slug}/${vault.slug}`, created);
    return { id: created.id };
  }
  async setVaultSecret(_orgId: string, vaultId: string, name: string, value: string) {
    this.writes.push(`setVaultSecret ${name}`);
    [...this.vaults.values()].find((v) => v.id === vaultId)!.secrets.set(name, value);
  }
  async serviceAccount(orgId: string, name: string) {
    return [...this.accounts.values()].find((a) => a.org === orgId && a.name === name);
  }
  async createServiceAccount(orgId: string, name: string, role: Role) {
    this.writes.push(`createServiceAccount ${name}`);
    const account = { id: this.id("ida"), org: orgId, name, role };
    this.accounts.set(account.id, account);
    return account;
  }
  async createServiceAccountKey(serviceAccountId: string) {
    this.writes.push(`createServiceAccountKey`);
    const key = this.id("key");
    this.keys.set(key, serviceAccountId);
    return key;
  }
  async keyAccount(key: string) {
    return this.keys.get(key);
  }
}

const empty = (): SetupSecrets => ({ customers: {} });

describe("converge", () => {
  it("builds every customer's organization, vault, minter and embedding on a first run", async () => {
    const stigmer = new FakeStigmer();
    const result = await converge(stigmer, INPUTS, empty(), { apply: true });

    expect(stigmer.agents.get(`${ACME.org}/${ACME.agent}`)?.mcpServers[0]?.url).toBe("https://tunnel.example/mcp");
    for (const customer of CUSTOMERS) {
      const child = stigmer.orgs.get(customer.slug)!;
      expect(child.parent).toBe("org_acme");
      expect(child.externalId).toBe(customer.externalId);
      expect(child.embedding).toEqual({
        createAccountsOnSignIn: true,
        signInRole: "member",
        allowedOrigins: ["http://localhost:5173"],
        vaults: [`${customer.slug}/${LEDGER_VAULT}`],
      });
      const mine = result.secrets.customers[customer.slug]!;
      expect(stigmer.vaults.get(`${customer.slug}/${LEDGER_VAULT}`)!.secrets.get(LEDGER_KEY)).toBe(mine.ledgerKey);
      // The minter lives in the customer's own organization, so its embedding vaults reach the runs.
      const minter = [...stigmer.accounts.values()].find((a) => a.org === child.id && a.name === MINTER)!;
      expect(minter.role).toBe("admin");
      expect(stigmer.keys.get(mine.minterKey!)).toBe(minter.id);
    }
    const keys = CUSTOMERS.map((c) => result.secrets.customers[c.slug]!.ledgerKey);
    expect(new Set(keys).size).toBe(CUSTOMERS.length);
    expect(result.changed).toBeGreaterThan(0);
  });

  it("writes nothing on a second run and reports every line unchanged", async () => {
    const stigmer = new FakeStigmer();
    const first = await converge(stigmer, INPUTS, empty(), { apply: true });
    stigmer.writes = [];
    const second = await converge(stigmer, INPUTS, first.secrets, { apply: true });
    expect(stigmer.writes).toEqual([]);
    expect(second.changed).toBe(0);
    expect(second.lines.every((l) => l.startsWith("unchanged"))).toBe(true);
    expect(second.secrets).toEqual(first.secrets);
  });

  it("updates only the Agent when the tunnel's address changes", async () => {
    const stigmer = new FakeStigmer();
    const first = await converge(stigmer, INPUTS, empty(), { apply: true });
    stigmer.writes = [];
    await converge(stigmer, { ...INPUTS, ledgerUrl: "https://new-tunnel.example/" }, first.secrets, { apply: true });
    expect(stigmer.writes).toEqual(["applyAgent variance-reporter"]);
    expect(stigmer.agents.get(`${ACME.org}/${ACME.agent}`)?.mcpServers[0]?.url).toBe("https://new-tunnel.example/mcp");
  });

  it("makes a new minting key when the kept one no longer acts as the minter", async () => {
    const stigmer = new FakeStigmer();
    const first = await converge(stigmer, INPUTS, empty(), { apply: true });
    const lost = structuredClone(first.secrets);
    lost.customers["northwind-books"]!.minterKey = "revoked";
    stigmer.writes = [];
    const again = await converge(stigmer, INPUTS, lost, { apply: true });
    expect(stigmer.writes).toEqual(["createServiceAccountKey"]);
    expect(again.secrets.customers["northwind-books"]!.minterKey).not.toBe("revoked");
  });

  it("saves a fresh ledger key into the vault when the secrets file has lost it", async () => {
    const stigmer = new FakeStigmer();
    const first = await converge(stigmer, INPUTS, empty(), { apply: true });
    const lost = structuredClone(first.secrets);
    delete lost.customers["blue-fern-press"]!.ledgerKey;
    stigmer.writes = [];
    const again = await converge(stigmer, INPUTS, lost, { apply: true });
    expect(stigmer.writes).toEqual([`setVaultSecret ${LEDGER_KEY}`]);
    expect(stigmer.vaults.get(`blue-fern-press/${LEDGER_VAULT}`)!.secrets.get(LEDGER_KEY)).toBe(again.secrets.customers["blue-fern-press"]!.ledgerKey);
  });

  it("writes nothing on a dry run", async () => {
    const stigmer = new FakeStigmer();
    const result = await converge(stigmer, INPUTS, empty(), { apply: false });
    expect(stigmer.writes).toEqual([]);
    expect(result.lines.some((l) => l.startsWith("would change"))).toBe(true);
  });

  it("refuses, before writing, a plan without room for every customer, a missing organization, a missing model key and a plain-http ledger", async () => {
    const small = new FakeStigmer();
    small.childRoom = 1;
    await expect(converge(small, INPUTS, empty(), { apply: true })).rejects.toThrow(SetupRefused);
    expect(small.writes).toEqual([]);

    const none = new FakeStigmer();
    none.orgs.clear();
    await expect(converge(none, INPUTS, empty(), { apply: true })).rejects.toThrow(/No organization acme-books/);

    const keyless = new FakeStigmer();
    await expect(converge(keyless, { ...INPUTS, anthropicKey: undefined }, empty(), { apply: true })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(keyless.writes).toEqual([]);

    await expect(converge(new FakeStigmer(), { ...INPUTS, ledgerUrl: "http://tunnel.example" }, empty(), { apply: true })).rejects.toThrow(/https/);
  });
});

describe("the Agent", () => {
  it("carries the customer's key from a vault and the caller identity the runner fills, never a literal key", () => {
    const agent = agentSpec("https://tunnel.example");
    expect(agent.sharedWithChildOrgs).toBe(true);
    expect(agent.disallowedTools).toEqual(["Bash"]);
    expect(agent.env[LEDGER_KEY]).toMatchObject({ isSecret: true });
    expect(agent.mcpServers[0]!.headers).toEqual({
      Authorization: "Bearer ${ACME_LEDGER_KEY}",
      "X-Stigmer-Caller-Kind": "${STIGMER_CALLER_IDENTITY_KIND}",
      "X-Stigmer-Caller-Value": "${STIGMER_CALLER_IDENTITY_VALUE}",
    });
  });

  it("compares Agents regardless of the order of their lists and headers", () => {
    const a = agentSpec("https://tunnel.example");
    const reordered: AgentSpec = {
      ...a,
      mcpServers: a.mcpServers.map((m) => ({ ...m, headers: Object.fromEntries(Object.entries(m.headers).reverse()) })),
    };
    expect(sameAgent(a, reordered)).toBe(true);
    expect(sameAgent(a, { ...a, instructions: `${a.instructions} ` })).toBe(false);
  });
});
