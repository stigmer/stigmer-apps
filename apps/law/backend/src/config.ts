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

/**
 * Encrypt without verifying the server certificate — the deployed
 * Postgres operator issues self-signed certs, and its pg_hba REQUIRES
 * encrypted client connections (verified live at NK's first boot:
 * "pg_hba.conf rejects connection ... no encryption"). This matches the
 * platform's effective JDBC posture (sslmode=prefer upgrades to TLS
 * without verification); libpq calls the same semantic "require".
 */
export interface DatabaseSsl {
  readonly rejectUnauthorized: false;
}

/**
 * Passed straight to pg.Pool, which accepts either shape. Two sources
 * exist because two worlds hand us connections differently: dev/tests
 * get ONE string from Testcontainers (DATABASE_URL), while deployment
 * gets discrete values — Planton config references resolve only as
 * whole env values, so a URL cannot be composed in a manifest (T06).
 * Never build the URL by concatenation here: a password needing
 * percent-encoding would corrupt it silently.
 */
export type DatabaseConfig =
  | { readonly connectionString: string; readonly ssl?: DatabaseSsl }
  | {
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string;
      readonly ssl?: DatabaseSsl;
    };

export interface BackendConfig {
  /** Postgres connection (either shape — see DatabaseConfig). */
  readonly database: DatabaseConfig;
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

  const database = loadDatabaseFromEnv(env, problems);

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
    database: database as DatabaseConfig,
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

/**
 * Exactly ONE database source (the ephemeral-keys precedent: ambiguity
 * is a config error, not a precedence rule). The discrete names are the
 * libpq standard — familiar to operators, and psql in a debug pod reads
 * them natively — but they are read HERE explicitly and passed to
 * pg.Pool as fields; nothing relies on node-pg's implicit env fallback.
 * Empty strings count as unset throughout: Kubernetes renders an
 * unresolved reference as "", which must fail loudly at boot.
 */
function loadDatabaseFromEnv(
  env: Record<string, string | undefined>,
  problems: string[],
): DatabaseConfig | undefined {
  const connectionString = env.DATABASE_URL;
  const discreteNames = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const;
  const discretePresent = discreteNames.filter((name) => env[name]);

  // "disable" (dev/tests: Testcontainers speaks plaintext) or "require"
  // (deployment: the operator's pg_hba rejects unencrypted clients).
  // Other libpq modes are refused rather than approximated: node-pg has
  // no verify-ca/verify-full equivalent worth pretending to honor.
  const sslModeRaw = env.PGSSLMODE ?? "disable";
  if (sslModeRaw !== "disable" && sslModeRaw !== "require") {
    problems.push(`PGSSLMODE must be 'disable' or 'require', got '${sslModeRaw}'`);
    return undefined;
  }
  const ssl: DatabaseSsl | undefined =
    sslModeRaw === "require" ? { rejectUnauthorized: false } : undefined;

  if (connectionString && discretePresent.length > 0) {
    problems.push(
      `DATABASE_URL and ${discretePresent.join("/")} are mutually exclusive ` +
        "(one connection definition, not two — DATABASE_URL is the dev/test form, " +
        "the PG* set is the deployment form)",
    );
    return undefined;
  }

  if (connectionString) {
    return ssl ? { connectionString, ssl } : { connectionString };
  }

  if (discretePresent.length === 0) {
    problems.push(
      "DATABASE_URL (postgres connection string; dev/tests) or " +
        "PGHOST/PGDATABASE/PGUSER/PGPASSWORD (+ optional PGPORT; deployment) is required",
    );
    return undefined;
  }

  const requiredDiscrete = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const;
  const missing = requiredDiscrete.filter((name) => !env[name]);
  if (missing.length > 0) {
    problems.push(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required ` +
        "(the PG* set must be complete once any of it is set)",
    );
    return undefined;
  }

  const portRaw = env.PGPORT ?? "5432";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PGPORT must be an integer in 1-65535, got '${portRaw}'`);
    return undefined;
  }

  return {
    host: env.PGHOST as string,
    port,
    database: env.PGDATABASE as string,
    user: env.PGUSER as string,
    password: env.PGPASSWORD as string,
    ...(ssl ? { ssl } : {}),
  };
}
