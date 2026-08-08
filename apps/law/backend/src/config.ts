/**
 * Configuration comes from environment variables and nothing else — no
 * dotenv, no config files, no library (isc-assistant convention). The
 * loader is pure so tests can feed it a plain object.
 */

export interface AuthConfig {
  /**
   * Dev/tests ONLY: generate an ephemeral signing keypair at boot instead
   * of loading configured keys (DD-005 D4 — no private key is ever
   * checked in; production fails fast without real keys). Refused when a
   * configured key is also present: ambiguity is a config error.
   */
  readonly ephemeralKeys: boolean;
  /** Base64-encoded PKCS#8 PEM signing key. Per-firm (DD-005 D4). */
  readonly privateKeyBase64?: string;
  /** Base64-encoded SPKI PEM public key of the PREVIOUS keypair (rotation overlap). */
  readonly previousPublicKeyBase64?: string;
  /**
   * SHA-256 (hex) of the operator key (DD-005 D7). The backend never
   * holds the raw key — the operator does.
   */
  readonly operatorKeySha256Hex: string;
}

export interface BackendConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/db */
  readonly databaseUrl: string;
  /** HTTP listen port. */
  readonly port: number;
  /**
   * Document object storage: a private Cloudflare R2 bucket consumed as
   * plain S3 with an endpoint override (DD-001) — MinIO in tests, same
   * client shape. Credentials arrive via config-manager in deployment.
   */
  readonly objectStore: {
    readonly endpoint: string;
    readonly bucket: string;
    /** R2 uses "auto"; MinIO ignores it. */
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  /** Authentication (DD-005): signing keys + operator key hash. */
  readonly auth: AuthConfig;
}

export function loadConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BackendConfig {
  // Collect every problem before throwing: a deploy with three missing
  // variables should fail once with three names, not three times.
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push("DATABASE_URL is required (postgres connection string)");
  }

  const portRaw = env.PORT ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer in 1-65535, got '${portRaw}'`);
  }

  const requiredObjectStoreVars = [
    "OBJECT_STORE_ENDPOINT",
    "OBJECT_STORE_BUCKET",
    "OBJECT_STORE_ACCESS_KEY_ID",
    "OBJECT_STORE_SECRET_ACCESS_KEY",
  ] as const;
  for (const name of requiredObjectStoreVars) {
    if (!env[name]) {
      problems.push(`${name} is required (document storage, S3-compatible)`);
    }
  }

  const ephemeralKeys = env.AUTH_EPHEMERAL_KEYS === "true";
  const privateKeyBase64 = env.AUTH_JWT_PRIVATE_KEY;
  if (ephemeralKeys && privateKeyBase64) {
    problems.push(
      "AUTH_EPHEMERAL_KEYS=true and AUTH_JWT_PRIVATE_KEY are mutually exclusive " +
        "(ephemeral keys are a dev/test convenience; configured keys mean production)",
    );
  }
  if (!ephemeralKeys && !privateKeyBase64) {
    problems.push(
      "AUTH_JWT_PRIVATE_KEY is required (base64 PKCS#8 PEM; per-firm, via config-manager) " +
        "— or AUTH_EPHEMERAL_KEYS=true for dev/tests only",
    );
  }

  const operatorKeySha256Hex = env.AUTH_OPERATOR_KEY_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(operatorKeySha256Hex)) {
    problems.push(
      "AUTH_OPERATOR_KEY_SHA256 is required (lowercase hex SHA-256 of the opk_ operator key)",
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid backend configuration:\n- ${problems.join("\n- ")}`);
  }

  return {
    databaseUrl: databaseUrl as string,
    port,
    objectStore: {
      endpoint: env.OBJECT_STORE_ENDPOINT as string,
      bucket: env.OBJECT_STORE_BUCKET as string,
      region: env.OBJECT_STORE_REGION ?? "auto",
      accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID as string,
      secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY as string,
    },
    auth: {
      ephemeralKeys,
      privateKeyBase64,
      previousPublicKeyBase64: env.AUTH_JWT_PREVIOUS_PUBLIC_KEY,
      operatorKeySha256Hex,
    },
  };
}
