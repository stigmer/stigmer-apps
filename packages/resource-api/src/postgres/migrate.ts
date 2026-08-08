/**
 * Plain-SQL migration runner.
 *
 * Migrations are hand-written `.sql` files — never generated, never
 * ORM-managed — because schema evolution is an API contract that must be
 * reviewable line by line (stigmer backend mandate: "no ORM magic",
 * "migrations must be deliberate").
 *
 * Migrations arrive as an ordered list of NAMESPACED SOURCES (DD-005 D8):
 * a commons package (e.g. `@stigmer/identity`) ships its own migration
 * directory, the app ships its own, and the app declares the order.
 * The ledger keys on (source, filename), so each source numbers its files
 * independently — one package's `0001_*.sql` can never collide with
 * another's. The rejected alternatives: one filename-keyed ledger shared
 * across packages (silent cross-package collision risk) and apps
 * hand-copying a package's DDL (drift across verticals in
 * security-relevant schema).
 *
 * Guarantees:
 * - Ordered: sources apply in declared order; within a source, files
 *   apply in lexicographic filename order, `NNNN_name.sql`.
 * - Once: applied (source, filename) pairs are recorded in
 *   `schema_migrations` and skipped on subsequent runs.
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

/**
 * Source names are ledger keys and log identifiers; keep them short,
 * lowercase, and stable (renaming a source orphans its ledger rows).
 */
const SOURCE_NAME = /^[a-z][a-z0-9_-]*$/;

export interface MigrationSource {
  /**
   * Namespace recorded in the ledger, e.g. "identity" for
   * `@stigmer/identity`'s migrations or "app" for the app's own.
   */
  readonly source: string;
  /** Directory containing this source's `NNNN_name.sql` files. */
  readonly dir: string;
}

export interface MigrationResult {
  /** Migrations applied by this run, in order, as `source/filename`. */
  readonly applied: readonly string[];
  /** Count of migrations already applied and skipped. */
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
 * Applies every pending migration from `sources` (in declared source
 * order, filename order within each source) to the database behind
 * `pool`. Returns which migrations were applied. Throws `MigrationError`
 * with the offending file on any failure; on error the database is left
 * at the last successfully applied migration.
 */
export async function runMigrations(
  pool: pg.Pool,
  sources: readonly MigrationSource[],
): Promise<MigrationResult> {
  validateSources(sources);

  const plan: { source: string; dir: string; filename: string }[] = [];
  for (const { source, dir } of sources) {
    for (const filename of await listMigrationFiles(source, dir)) {
      plan.push({ source, dir, filename });
    }
  }

  // One dedicated connection for the whole run: advisory locks are
  // session-scoped, so lock, bookkeeping, and DDL must share a session.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await ensureLedger(client);

      const appliedRows = await client.query<{
        source: string;
        filename: string;
        checksum: string;
      }>("SELECT source, filename, checksum FROM schema_migrations");
      const appliedChecksums = new Map(
        appliedRows.rows.map((r) => [ledgerKey(r.source, r.filename), r.checksum]),
      );

      const applied: string[] = [];
      let skipped = 0;

      for (const { source, dir, filename } of plan) {
        const sql = await readFile(path.join(dir, filename), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const key = ledgerKey(source, filename);

        const existing = appliedChecksums.get(key);
        if (existing !== undefined) {
          if (existing !== checksum) {
            throw new MigrationError(
              `Migration '${key}' was already applied but its content has changed. ` +
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
            "INSERT INTO schema_migrations (source, filename, checksum) VALUES ($1, $2, $3)",
            [source, filename, checksum],
          );
          await client.query("COMMIT");
        } catch (cause) {
          await client.query("ROLLBACK");
          throw new MigrationError(
            `Migration '${key}' failed and was rolled back: ${describeCause(cause)}`,
            filename,
            { cause },
          );
        }
        applied.push(key);
      }

      return { applied, skipped };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function ledgerKey(source: string, filename: string): string {
  return `${source}/${filename}`;
}

function validateSources(sources: readonly MigrationSource[]): void {
  if (sources.length === 0) {
    throw new MigrationError("At least one migration source is required.");
  }
  const seen = new Set<string>();
  for (const { source } of sources) {
    if (!SOURCE_NAME.test(source)) {
      throw new MigrationError(
        `Migration source name '${source}' must match ${SOURCE_NAME} ` +
          `(it is a ledger key — short, lowercase, stable).`,
      );
    }
    if (seen.has(source)) {
      throw new MigrationError(`Migration source '${source}' is declared twice.`);
    }
    seen.add(source);
  }
}

/**
 * Creates the ledger, or refuses a pre-D8 single-column ledger with an
 * actionable message instead of letting the first INSERT fail with a
 * cryptic "column does not exist". No deployed database predates the
 * namespaced shape (DD-005 D8); only local dev databases can hit this.
 */
async function ensureLedger(client: pg.PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       source     text NOT NULL,
       filename   text NOT NULL,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (source, filename)
     )`,
  );
  const shape = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'schema_migrations' AND column_name = 'source'`,
  );
  if (shape.rowCount === 0) {
    throw new MigrationError(
      "The schema_migrations table predates namespaced migration sources (DD-005 D8). " +
        "No production database has the old shape; recreate this (dev) database.",
    );
  }
}

async function listMigrationFiles(source: string, dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new MigrationError(
      `Cannot read migrations directory '${dir}' (source '${source}'): ${describeCause(cause)}`,
      undefined,
      { cause },
    );
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));
  const invalid = sqlFiles.filter((f) => !MIGRATION_FILENAME.test(f));
  if (invalid.length > 0) {
    throw new MigrationError(
      `Migration filenames must match NNNN_snake_case.sql (ordered, self-describing). ` +
        `Invalid in source '${source}': ${invalid.join(", ")}`,
      invalid[0],
    );
  }

  return sqlFiles.sort();
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
