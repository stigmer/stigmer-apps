/**
 * Configuration comes from environment variables and nothing else — no
 * dotenv, no config files, no library (isc-assistant convention). The
 * loader is pure so tests can feed it a plain object.
 */

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
  };
}
