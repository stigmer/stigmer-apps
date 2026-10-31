/**
 * The setup's port over the Stigmer client SDK, signed in with an admin's key bound to Acme's
 * organization (`stigmer apikey create --bound-org acme-books`). A person's key, not a service
 * account's: Stigmer refuses to create an organization from a service account, so a leaked machine
 * key can never add one.
 */
import { create } from "@bufbuild/protobuf";
import { isNotFound, Stigmer } from "@stigmer/client";
import { createNodeClient } from "@stigmer/client/node";
import { ApiResourceKind } from "@stigmer/apis/ai/stigmer/commons/apiresource/apiresourcekind/api_resource_kind_pb";
import { ApiResourceVisibility } from "@stigmer/apis/ai/stigmer/commons/apiresource/enum_pb";
import { ApiResourceReferenceSchema } from "@stigmer/apis/ai/stigmer/commons/apiresource/io_pb";
import { SetVaultSecretsInputSchema } from "@stigmer/apis/ai/stigmer/agentic/vault/v1/io_pb";
import { ListProviderKeysInputSchema } from "@stigmer/apis/ai/stigmer/billing/providerkey/v1/io_pb";
import { GetEntitlementsInputSchema } from "@stigmer/apis/ai/stigmer/billing/subscription/v1/io_pb";
import { CreateServiceAccountKeyInputSchema } from "@stigmer/apis/ai/stigmer/iam/apikey/v1/io_pb";
import {
  CreateServiceAccountInputSchema,
  ListServiceAccountsInputSchema,
} from "@stigmer/apis/ai/stigmer/iam/identityaccount/v1/io_pb";
import { IamRole } from "@stigmer/apis/ai/stigmer/iam/v1/enum_pb";
import type { Organization } from "@stigmer/apis/ai/stigmer/tenancy/organization/v1/api_pb";
import {
  OrganizationExternalLookupSchema,
  UpdateOrganizationEmbeddingInputSchema,
} from "@stigmer/apis/ai/stigmer/tenancy/organization/v1/io_pb";
import type { AgentSpec, Embedding, Org, Role, StigmerPort } from "./port.js";

const ROLE_IN: Partial<Record<IamRole, Role>> = { [IamRole.member]: "member", [IamRole.admin]: "admin" };
const ROLE_OUT: Record<Role, IamRole> = { member: IamRole.member, admin: IamRole.admin };

async function orUndefined<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * The organization in the setup's shape. Stigmer stores an embedding's vault reference with the
 * organization's id (and adds the vault's), whatever the writer named, so a reference into the
 * organization itself reads back as its slug here; the setup compares `org-slug/vault-slug`.
 */
export function toOrg(org: Organization): Org {
  const embedding = org.spec?.embedding;
  const id = org.metadata?.id ?? "";
  const slug = org.metadata?.slug ?? "";
  return {
    id,
    slug,
    embedding: {
      createAccountsOnSignIn: embedding?.createAccountsOnSignIn ?? false,
      signInRole: (embedding && ROLE_IN[embedding.signInRole]) ?? "none",
      allowedOrigins: embedding?.allowedOrigins ?? [],
      vaults: (embedding?.vaults ?? []).map((v) => `${v.org === id ? slug : v.org}/${v.slug}`),
    },
  };
}

export function stigmerPort(baseUrl: string, adminKey: string): StigmerPort {
  const stigmer = createNodeClient({ baseUrl, apiKey: adminKey });

  return {
    async organization(slug) {
      const org = await orUndefined(stigmer.organization.get(slug));
      return org && toOrg(org);
    },
    async childByExternalId(parentId, externalId) {
      const org = await orUndefined(
        stigmer.organization.getByExternalId(create(OrganizationExternalLookupSchema, { parentOrg: parentId, externalId })),
      );
      return org && toOrg(org);
    },
    async createChild(parentId, child) {
      return toOrg(await stigmer.organization.create({ ...child, parentOrg: parentId }));
    },
    async includedChildOrgs(orgId) {
      const answer = await stigmer.subscription.getEntitlements(create(GetEntitlementsInputSchema, { org: orgId }));
      return answer.entitlements?.limits?.includedChildOrgs ?? 0;
    },
    async updateEmbedding(orgId, embedding: Embedding) {
      await stigmer.organization.updateEmbedding(
        create(UpdateOrganizationEmbeddingInputSchema, {
          orgId,
          embedding: {
            createAccountsOnSignIn: embedding.createAccountsOnSignIn,
            signInRole: embedding.signInRole === "none" ? IamRole.iam_role_unspecified : ROLE_OUT[embedding.signInRole],
            allowedOrigins: [...embedding.allowedOrigins],
            vaults: embedding.vaults.map((ref) => {
              const [org = "", slug = ""] = ref.split("/");
              return create(ApiResourceReferenceSchema, { org, slug, kind: ApiResourceKind.vault });
            }),
          },
        }),
      );
    },

    async hasProviderKey(orgId, provider) {
      const keys = await stigmer.providerkey.list(create(ListProviderKeysInputSchema, { org: orgId }));
      return keys.entries.some((k) => k.provider === provider && k.inheritedFromOrg === "");
    },
    async setProviderKey(orgId, provider, apiKey) {
      await stigmer.providerkey.set({ org: orgId, provider, apiKey, baseUrl: "" } as Parameters<Stigmer["providerkey"]["set"]>[0]);
    },

    async agent(org, slug) {
      const agent = await orUndefined(stigmer.agent.getByReference({ org, slug, kind: ApiResourceKind.agent }));
      if (!agent) return undefined;
      const spec = agent.spec;
      return {
        org,
        slug,
        description: spec?.description ?? "",
        instructions: spec?.instructions ?? "",
        sharedWithChildOrgs: agent.metadata?.visibility === ApiResourceVisibility.visibility_child_orgs,
        disallowedTools: spec?.disallowedTools ?? [],
        env: Object.fromEntries(
          Object.entries(spec?.env ?? {}).map(([name, d]) => [name, { isSecret: d.isSecret, description: d.description }]),
        ),
        mcpServers: (spec?.mcpServers ?? []).map((m) => ({ name: m.name, url: m.url, headers: { ...m.headers } })),
      };
    },
    async applyAgent(agent: AgentSpec) {
      await stigmer.agent.apply({
        org: agent.org,
        name: agent.slug,
        slug: agent.slug,
        description: agent.description,
        instructions: agent.instructions,
        visibility: agent.sharedWithChildOrgs ? ApiResourceVisibility.visibility_child_orgs : ApiResourceVisibility.visibility_org,
        disallowedTools: [...agent.disallowedTools],
        env: Object.fromEntries(Object.entries(agent.env).map(([name, d]) => [name, { ...d }])),
        mcpServers: agent.mcpServers.map((m) => ({ name: m.name, url: m.url, headers: { ...m.headers } })),
      });
    },

    async vault(org, slug) {
      const vault = await orUndefined(stigmer.vault.getByReference({ org, slug, kind: ApiResourceKind.vault }));
      return vault && { id: vault.metadata?.id ?? "", secretNames: Object.keys(vault.spec?.secrets ?? {}) };
    },
    async createVault(orgId, vault) {
      const created = await stigmer.vault.create({ ...vault, org: orgId, visibility: ApiResourceVisibility.visibility_org });
      return { id: created.metadata?.id ?? "" };
    },
    async setVaultSecret(orgId, vaultId, name, value, description) {
      await stigmer.vault.setSecrets(
        create(SetVaultSecretsInputSchema, { vault: { org: orgId, vault: { case: "id", value: vaultId } }, secrets: { [name]: { value, description } } }),
      );
    },

    async serviceAccount(orgId, name) {
      for await (const account of stigmer.identityAccount.listServiceAccountsAll(create(ListServiceAccountsInputSchema, { org: orgId }))) {
        if (account.metadata?.name === name) return { id: account.metadata.id };
      }
      return undefined;
    },
    async createServiceAccount(orgId, name, role) {
      const account = await stigmer.identityAccount.createServiceAccount(
        create(CreateServiceAccountInputSchema, { org: orgId, name, role: ROLE_OUT[role] }),
      );
      return { id: account.metadata?.id ?? "" };
    },
    async createServiceAccountKey(serviceAccountId, name) {
      const key = await stigmer.apiKey.createForServiceAccount(
        create(CreateServiceAccountKeyInputSchema, { serviceAccountId, name, neverExpires: true }),
      );
      const plaintext = key.spec?.keyHash ?? "";
      if (plaintext === "") throw new Error("Stigmer answered the new key without its value.");
      return plaintext;
    },
    async keyAccount(key) {
      try {
        return (await createNodeClient({ baseUrl, apiKey: key }).identityAccount.whoAmI()).metadata?.id;
      } catch {
        return undefined;
      }
    },
  };
}
