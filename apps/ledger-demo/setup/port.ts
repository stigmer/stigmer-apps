/**
 * The setup's view of a Stigmer: only the reads and writes it needs, in its own plain shapes. The
 * real one is `stigmer-port.ts` over the client SDK; the tests run the setup against a fake, so what
 * the setup decides is tested without a server.
 */

export type Role = "member" | "admin";

/** An organization's embedding settings, as the setup compares them. */
export interface Embedding {
  readonly createAccountsOnSignIn: boolean;
  readonly signInRole: Role | "none";
  readonly allowedOrigins: readonly string[];
  /** The vaults by `org/slug`. */
  readonly vaults: readonly string[];
}

export interface Org {
  readonly id: string;
  readonly slug: string;
  readonly embedding: Embedding;
}

/** The Agent, as the setup writes and compares it. */
export interface AgentSpec {
  readonly org: string;
  readonly slug: string;
  readonly description: string;
  readonly instructions: string;
  readonly sharedWithChildOrgs: boolean;
  readonly disallowedTools: readonly string[];
  /** Declared settings, by name; `true` marks a secret. */
  readonly env: Readonly<Record<string, { readonly isSecret: boolean; readonly description: string }>>;
  readonly mcpServers: readonly { readonly name: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }[];
}

export interface StigmerPort {
  organization(slug: string): Promise<Org | undefined>;
  childByExternalId(parentId: string, externalId: string): Promise<Org | undefined>;
  createChild(parentId: string, child: { name: string; slug: string; externalId: string }): Promise<Org>;
  includedChildOrgs(orgId: string): Promise<number>;
  updateEmbedding(orgId: string, embedding: Embedding): Promise<void>;

  hasProviderKey(orgId: string, provider: string): Promise<boolean>;
  setProviderKey(orgId: string, provider: string, apiKey: string): Promise<void>;

  agent(org: string, slug: string): Promise<AgentSpec | undefined>;
  applyAgent(agent: AgentSpec): Promise<void>;

  /** The vault's id and the names of the secrets it holds (never their values). */
  vault(org: string, slug: string): Promise<{ id: string; secretNames: readonly string[] } | undefined>;
  createVault(orgId: string, vault: { name: string; slug: string; description: string }): Promise<{ id: string }>;
  setVaultSecret(orgId: string, vaultId: string, name: string, value: string, description: string): Promise<void>;

  serviceAccount(orgId: string, name: string): Promise<{ id: string } | undefined>;
  createServiceAccount(orgId: string, name: string, role: Role): Promise<{ id: string }>;
  createServiceAccountKey(serviceAccountId: string, name: string): Promise<string>;
  /** The account a key acts as, or undefined when the key is refused. */
  keyAccount(key: string): Promise<string | undefined>;
}
