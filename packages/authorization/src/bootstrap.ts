/**
 * Idempotent store + model bootstrap. The consuming app calls this once
 * on boot with its model DSL; nobody hand-manages store or model ids
 * per deployment (the stigmer-cloud apply-and-sync script exists
 * because ids there ARE hand-synced into config — this seam removes
 * that whole failure mode for apps that own their engine).
 *
 * Idempotency: the store is found by name before it is created; the
 * model is written only when the DSL's transformed form differs from
 * the latest stored model. Model writes are append-only in OpenFGA, so
 * a spurious rewrite is hygiene, not corruption — the engine binds to
 * whatever id this boot resolved, and checks are consistent within the
 * process either way.
 */

import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { createOpenFgaEngine, type AuthorizationEngine } from "./engine.js";

export interface OpenFgaConnection {
  /** e.g. `http://openfga.ns.svc.cluster.local:8080` */
  readonly apiUrl: string;
  /** Preshared key. Optional only for local harnesses that run open. */
  readonly apiToken?: string;
}

export interface BootstrapOptions {
  readonly connection: OpenFgaConnection;
  /** Store name, unique per app within the engine (find-or-create key). */
  readonly storeName: string;
  /** The app's authorization model in FGA DSL form. */
  readonly modelDsl: string;
}

export interface BootstrappedAuthorization {
  readonly engine: AuthorizationEngine;
  readonly storeId: string;
  readonly modelId: string;
}

function createClient(connection: OpenFgaConnection, storeId?: string, modelId?: string): OpenFgaClient {
  return new OpenFgaClient({
    apiUrl: connection.apiUrl,
    storeId,
    authorizationModelId: modelId,
    ...(connection.apiToken
      ? {
          credentials: {
            method: CredentialsMethod.ApiToken,
            config: { token: connection.apiToken },
          },
        }
      : {}),
  });
}

/**
 * Key-sorted, empty-value-dropping serialization so a model read back
 * from the server compares equal to a fresh transform of the same DSL.
 * The server pads what it stores with empties the transformer never
 * emits — `"module": ""`, `"condition": ""`, `"source_info": null`,
 * `"relations": {}` (observed on v1.18.3) — so emptiness of every kind
 * is insignificant for equality, applied bottom-up so a padding-only
 * object (e.g. `{"module": "", "source_info": null}`) collapses and
 * drops too. Collapsing also erases `"this": {}` (the direct-relation
 * rewrite) — safe because it happens on BOTH sides, array elements are
 * never dropped (a collapsed union child stays as `{}` in place), and
 * no other rewrite normalizes to `{}`.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForComparison(value));
}

function isInsignificant(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForComparison);
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const child = normalizeForComparison(raw);
      if (!isInsignificant(child)) {
        normalized[key] = child;
      }
    }
    return normalized;
  }
  return value;
}

async function findOrCreateStore(client: OpenFgaClient, storeName: string): Promise<string> {
  let continuationToken: string | undefined;
  do {
    const page = await client.listStores({ continuationToken });
    const match = page.stores?.find((store) => store.name === storeName);
    if (match?.id) return match.id;
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);
  const created = await client.createStore({ name: storeName });
  if (!created.id) {
    throw new Error(`authorization store creation returned no id (name=${storeName})`);
  }
  return created.id;
}

export async function bootstrapAuthorization(
  options: BootstrapOptions,
): Promise<BootstrappedAuthorization> {
  const desiredModel = transformer.transformDSLToJSONObject(options.modelDsl);

  const adminClient = createClient(options.connection);
  const storeId = await findOrCreateStore(adminClient, options.storeName);

  const storeClient = createClient(options.connection, storeId);
  let modelId: string | undefined;
  try {
    const latest = await storeClient.readLatestAuthorizationModel();
    const stored = latest.authorization_model;
    if (stored) {
      const { id: _id, ...storedShape } = stored;
      if (stableStringify(storedShape) === stableStringify(desiredModel)) {
        modelId = stored.id;
      }
    }
  } catch {
    // A store with no model yet answers with an error on some server
    // versions; treat it the same as "no latest model" and write below.
  }
  if (!modelId) {
    const written = await storeClient.writeAuthorizationModel({
      schema_version: desiredModel.schema_version,
      type_definitions: desiredModel.type_definitions ?? [],
      ...(desiredModel.conditions ? { conditions: desiredModel.conditions } : {}),
    });
    modelId = written.authorization_model_id;
  }
  if (!modelId) {
    throw new Error(`authorization model resolution failed (store=${options.storeName})`);
  }

  const boundClient = createClient(options.connection, storeId, modelId);
  return { engine: createOpenFgaEngine(boundClient), storeId, modelId };
}
