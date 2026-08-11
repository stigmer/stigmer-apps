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

/**
 * The assistant integration (T05, the web leg): the agent platform's
 * PlatformClient credentials this backend exchanges law sessions for
 * platform tokens with. OPTIONAL AS A GROUP — an open-source deployment
 * without a platform org simply has no assistant (the web renders no
 * affordance); a PARTIAL group is a boot error, because a half-wired
 * assistant would fail at first use instead of at deploy time.
 */
export interface AssistantConfig {
  /** The platform API endpoint (backend mint AND browser SDK calls). */
  readonly apiBaseUrl: string;
  /** PlatformClient client_id (stgm_cid_…). */
  readonly clientId: string;
  /** PlatformClient client_secret (stgm_cs_…). Server-only, never the browser. */
  readonly clientSecret: string;
  /** The platform organization hosting the firm's assistant. */
  readonly org: string;
  /**
   * The org-visible AgentInstance the web session bootstrap passes — it
   * carries the environment_refs that deliver the MCP shared secret to
   * embed-path executions (the platform's "fifth session origin" gap).
   */
  readonly agentInstanceId: string;
  /** The platform console base URL for user-facing deep links (billing). */
  readonly consoleUrl: string;
}

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
  /**
   * The reminder sweep's tick interval in milliseconds (Gate-1 Q4):
   * deadline escalation, unrecorded-outcome nags, hearing reminders.
   * 0 disables the loop (tests drive runSweepOnce directly; dev may not
   * want background writes). Calendar reminders tolerate minutes of
   * latency by nature, so the default is 15 minutes.
   */
  readonly reminderIntervalMs: number;
  /**
   * The MCP channel entrance (T05, DD-008): a second listener serving
   * the agent platform's tool calls, guarded by a shared secret that is
   * THE authorization boundary for asserted channel identities — which
   * is why there is no insecure mode and no default.
   */
  readonly mcp: {
    /** MCP listen port (cluster-internal; never the ingress port). */
    readonly port: number;
    /** Bearer secret the agent platform presents. Min 32 chars. */
    readonly sharedSecret: string;
  };
  /**
   * The FGA engine (DD-003): the firm's own OpenFGA, cluster-internal.
   * The preshared key is mandatory — agent sandboxes share the cluster,
   * so an open authorization API is forbidden (no insecure mode, the
   * MCP secret's reasoning applied to the engine).
   */
  readonly authz: {
    readonly apiUrl: string;
    readonly apiToken: string;
    /**
     * Periodic tuple-reconcile interval (DD-003 D1a's drift backstop).
     * 0 disables the loop (tests reconcile explicitly).
     */
    readonly reconcileIntervalMs: number;
  };
  /** The assistant integration; absent means the feature does not exist. */
  readonly assistant?: AssistantConfig;
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

  const mcpPortRaw = env.MCP_PORT ?? "8081";
  const mcpPort = Number(mcpPortRaw);
  if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535) {
    problems.push(`MCP_PORT must be an integer in 1-65535, got '${mcpPortRaw}'`);
  } else if (mcpPort === port) {
    problems.push(`MCP_PORT must differ from PORT (both are '${mcpPortRaw}')`);
  }

  const mcpSharedSecret = env.MCP_SHARED_SECRET ?? "";
  if (mcpSharedSecret.length < 32) {
    problems.push(
      "MCP_SHARED_SECRET is required, min 32 chars (whoever holds it can assert any " +
        "user's channel identity — DD-008; there is no insecure mode)",
    );
  }

  const reminderIntervalRaw = env.REMINDER_SWEEP_INTERVAL_SECONDS ?? "900";
  const reminderIntervalSeconds = Number(reminderIntervalRaw);
  if (!Number.isInteger(reminderIntervalSeconds) || reminderIntervalSeconds < 0) {
    problems.push(
      `REMINDER_SWEEP_INTERVAL_SECONDS must be a non-negative integer (0 disables), ` +
        `got '${reminderIntervalRaw}'`,
    );
  }

  const fgaApiUrl = env.FGA_API_URL ?? "";
  if (!fgaApiUrl) {
    problems.push("FGA_API_URL is required (the firm's OpenFGA endpoint — DD-003)");
  }
  const fgaApiToken = env.FGA_API_TOKEN ?? "";
  if (fgaApiToken.length < 32) {
    problems.push(
      "FGA_API_TOKEN is required, min 32 chars (the engine's preshared key; sandboxes " +
        "share the cluster — DD-003; there is no insecure mode)",
    );
  }
  // Reconcile is the drift BACKSTOP behind same-request tuple sync, so
  // minutes of period cost nothing; 5 minutes bounds any crash-window
  // drift tightly without meaningfully loading the engine.
  const fgaReconcileRaw = env.FGA_RECONCILE_INTERVAL_SECONDS ?? "300";
  const fgaReconcileSeconds = Number(fgaReconcileRaw);
  if (!Number.isInteger(fgaReconcileSeconds) || fgaReconcileSeconds < 0) {
    problems.push(
      `FGA_RECONCILE_INTERVAL_SECONDS must be a non-negative integer (0 disables), ` +
        `got '${fgaReconcileRaw}'`,
    );
  }

  const assistant = loadAssistantFromEnv(env, problems);

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
    reminderIntervalMs: reminderIntervalSeconds * 1000,
    mcp: {
      port: mcpPort,
      sharedSecret: mcpSharedSecret,
    },
    authz: {
      apiUrl: fgaApiUrl,
      apiToken: fgaApiToken,
      reconcileIntervalMs: fgaReconcileSeconds * 1000,
    },
    ...(assistant ? { assistant } : {}),
  };
}

/**
 * All-or-nothing (the PG* set's rule applied to the assistant group):
 * zero of the five variables means the feature does not exist; any of
 * them means all five are required, named together in one boot failure.
 * STIGMER_CONSOLE_URL is the one true optional — it only shapes deep
 * links, so the hosted console is a safe default; self-hosters override.
 * Empty strings count as unset throughout (an unresolved Kubernetes
 * reference renders as "", which must fail loudly, not half-enable).
 */
function loadAssistantFromEnv(
  env: Record<string, string | undefined>,
  problems: string[],
): AssistantConfig | undefined {
  const names = [
    "STIGMER_API_BASE_URL",
    "STIGMER_PLATFORM_CLIENT_ID",
    "STIGMER_PLATFORM_CLIENT_SECRET",
    "STIGMER_ORG",
    "STIGMER_AGENT_INSTANCE_ID",
  ] as const;
  const present = names.filter((name) => env[name]);
  if (present.length === 0) {
    return undefined;
  }
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    problems.push(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required ` +
        "(the assistant group must be complete once any of it is set — " +
        "a half-configured assistant fails at first use instead of at deploy)",
    );
    return undefined;
  }
  return {
    apiBaseUrl: env.STIGMER_API_BASE_URL as string,
    clientId: env.STIGMER_PLATFORM_CLIENT_ID as string,
    clientSecret: env.STIGMER_PLATFORM_CLIENT_SECRET as string,
    org: env.STIGMER_ORG as string,
    agentInstanceId: env.STIGMER_AGENT_INSTANCE_ID as string,
    consoleUrl: env.STIGMER_CONSOLE_URL || "https://app.stigmer.ai",
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
