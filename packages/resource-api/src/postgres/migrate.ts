/**
 * Plain-SQL migration runner.
 *
 * Migrations are hand-written `.sql` files — never generated, never
 * ORM-managed — because schema evolution is an API contract that must be
 * reviewable line by line (stigmer backend mandate: "no ORM magic",
 * "migrations must be deliberate").
 *
 * Guarantees:
 * - Ordered: files apply in lexicographic filename order, `NNNN_name.sql`.
 * - Once: applied filenames are recorded in `schema_migrations` and skipped
 *   on subsequent runs.
 * - Immutable: an applied file whose content later changes is a hard error
 *   (checksum drift), not a silent re-apply — editing history instead of
 *   adding a migration is how two environments diverge without anyone
 *   noticing.
 * - Atomic per file: each migration runs in its own transaction together
 *   with its bookkeeping row, so a failing migration leaves no partial
 *   schema. (Postgres DDL is transactional, which is what makes this
 *   guarantee possible at all.)
 * - Serialized: a session-scoped advisory lock makes concurrent runners
 *   (e.g. two replicas booting at once) queue instead of racing.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

/**
 * Fixed advisory-lock key for migration runs. Arbitrary but stable: every
 * process that migrates the same database must use the same key for the
 * serialization guarantee to hold.
 */
const MIGRATION_LOCK_KEY = 0x5f1a3e5;

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  /** Filenames applied by this run, in order. */
  readonly applied: readonly string[];
  /** Count of files already applied and skipped. */
  readonly skipped: number;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly filename?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/**
 * Applies every pending migration in `migrationsDir` to the database behind
 * `pool`. Returns which files were applied. Throws `MigrationError` with the
 * offending filename on any failure; on error the database is left at the
 * last successfully applied migration.
 */
export async function runMigrations(
  pool: pg.Pool,
  migrationsDir: string,
): Promise<MigrationResult> {
  const files = await listMigrationFiles(migrationsDir);

  // One dedicated connection for the whole run: advisory locks are
  // session-scoped, so lock, bookkeeping, and DDL must share a session.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename   text PRIMARY KEY,
           checksum   text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );

      const appliedRows = await client.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM schema_migrations",
      );
      const appliedChecksums = new Map(
        appliedRows.rows.map((r) => [r.filename, r.checksum]),
      );

      const applied: string[] = [];
      let skipped = 0;

      for (const filename of files) {
        const sql = await readFile(path.join(migrationsDir, filename), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");

        const existing = appliedChecksums.get(filename);
        if (existing !== undefined) {
          if (existing !== checksum) {
            throw new MigrationError(
              `Migration '${filename}' was already applied but its content has changed. ` +
                `Applied migrations are immutable — add a new migration instead of editing this one.`,
              filename,
            );
          }
          skipped += 1;
          continue;
        }

        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [filename, checksum],
          );
          await client.query("COMMIT");
        } catch (cause) {
          await client.query("ROLLBACK");
          throw new MigrationError(
            `Migration '${filename}' failed and was rolled back: ${describeCause(cause)}`,
            filename,
            { cause },
          );
        }
        applied.push(filename);
      }

      return { applied, skipped };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (cause) {
    throw new MigrationError(
      `Cannot read migrations directory '${migrationsDir}': ${describeCause(cause)}`,
      undefined,
      { cause },
    );
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));
  const invalid = sqlFiles.filter((f) => !MIGRATION_FILENAME.test(f));
  if (invalid.length > 0) {
    throw new MigrationError(
      `Migration filenames must match NNNN_snake_case.sql (ordered, self-describing). ` +
        `Invalid: ${invalid.join(", ")}`,
      invalid[0],
    );
  }

  return sqlFiles.sort();
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
