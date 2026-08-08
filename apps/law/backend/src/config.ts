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

  if (problems.length > 0) {
    throw new Error(`Invalid backend configuration:\n- ${problems.join("\n- ")}`);
  }

  return { databaseUrl: databaseUrl as string, port };
}
