import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MigrationError, runMigrations } from "../migrate.js";
import { startTestDatabase, type TestDatabase } from "./testcontainers.js";

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

/** Single-source shorthand: most guarantees are per-source semantics. */
const appSource = (dir: string) => [{ source: "app", dir }];

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const res = await pool.query("SELECT to_regclass($1) AS reg", [`public.${table}`]);
  return res.rows[0].reg !== null;
}

describe("runMigrations", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  it("applies pending migrations in filename order and records them", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0002_add_color.sql": "ALTER TABLE fruits ADD COLUMN color text",
      "0001_create_fruits.sql": "CREATE TABLE fruits (id serial PRIMARY KEY, name text)",
    });

    const result = await runMigrations(pool, appSource(dir));

    expect(result.applied).toEqual([
      "app/0001_create_fruits.sql",
      "app/0002_add_color.sql",
    ]);
    expect(result.skipped).toBe(0);
    // The schema itself proves ordering: 0002 only works if 0001 ran first.
    await pool.query("INSERT INTO fruits (name, color) VALUES ('mango', 'yellow')");

    const recorded = await pool.query(
      "SELECT source, filename FROM schema_migrations ORDER BY filename",
    );
    expect(recorded.rows).toEqual([
      { source: "app", filename: "0001_create_fruits.sql" },
      { source: "app", filename: "0002_add_color.sql" },
    ]);
  });

  it("applies sources in declared order, before any filename ordering", async () => {
    const pool = await db.createIsolatedPool();
    // The app file sorts BEFORE the package file by name; only source
    // order can make the package's table exist when the app's runs.
    const pkg = await migrationDir({
      "0009_create_base.sql": "CREATE TABLE base (id int PRIMARY KEY)",
    });
    const app = await migrationDir({
      "0001_reference_base.sql":
        "CREATE TABLE consumer (base_id int REFERENCES base (id))",
    });

    const result = await runMigrations(pool, [
      { source: "identity", dir: pkg },
      { source: "app", dir: app },
    ]);

    expect(result.applied).toEqual([
      "identity/0009_create_base.sql",
      "app/0001_reference_base.sql",
    ]);
  });

  it("keeps identically named files in different sources independent", async () => {
    const pool = await db.createIsolatedPool();
    const a = await migrationDir({ "0001_create.sql": "CREATE TABLE from_a (id int)" });
    const b = await migrationDir({ "0001_create.sql": "CREATE TABLE from_b (id int)" });

    // Same filename, different content — with a filename-keyed ledger this
    // would be a checksum-drift false positive; with (source, filename)
    // keys both apply.
    const result = await runMigrations(pool, [
      { source: "pkg-a", dir: a },
      { source: "pkg-b", dir: b },
    ]);

    expect(result.applied).toEqual(["pkg-a/0001_create.sql", "pkg-b/0001_create.sql"]);
    expect(await tableExists(pool, "from_a")).toBe(true);
    expect(await tableExists(pool, "from_b")).toBe(true);
  });

  it("rejects an empty source list and duplicate or malformed source names", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({});

    await expect(runMigrations(pool, [])).rejects.toThrowError(/At least one/);
    await expect(
      runMigrations(pool, [
        { source: "app", dir },
        { source: "app", dir },
      ]),
    ).rejects.toThrowError(/declared twice/);
    await expect(
      runMigrations(pool, [{ source: "Not Valid", dir }]),
    ).rejects.toThrowError(/must match/);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_t.sql": "CREATE TABLE t (id int)",
    });

    await runMigrations(pool, appSource(dir));
    const second = await runMigrations(pool, appSource(dir));

    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(1);
  });

  it("applies only new files on a subsequent run", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_a.sql": "CREATE TABLE a (id int)",
    });
    await runMigrations(pool, appSource(dir));

    await writeFile(
      path.join(dir, "0002_create_b.sql"),
      "CREATE TABLE b (id int)",
      "utf8",
    );
    const result = await runMigrations(pool, appSource(dir));

    expect(result.applied).toEqual(["app/0002_create_b.sql"]);
    expect(result.skipped).toBe(1);
  });

  it("rejects edits to an already-applied migration (checksum drift)", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_c.sql": "CREATE TABLE c (id int)",
    });
    await runMigrations(pool, appSource(dir));

    await writeFile(
      path.join(dir, "0001_create_c.sql"),
      "CREATE TABLE c (id int, edited text)",
      "utf8",
    );

    await expect(runMigrations(pool, appSource(dir))).rejects.toThrowError(
      /app\/0001_create_c\.sql.*content has changed/,
    );
  });

  it("rolls back a failing migration atomically and preserves prior ones", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_good.sql": "CREATE TABLE survivors (id int)",
      // First statement would succeed; the second fails. Atomicity means
      // the table from the first statement must NOT exist afterwards.
      "0002_bad.sql": "CREATE TABLE partial (id int); SELECT no_such_function();",
    });

    await expect(runMigrations(pool, appSource(dir))).rejects.toThrowError(
      /app\/0002_bad\.sql.*rolled back/,
    );

    expect(await tableExists(pool, "survivors")).toBe(true);
    expect(await tableExists(pool, "partial")).toBe(false);
    const recorded = await pool.query("SELECT filename FROM schema_migrations");
    expect(recorded.rows.map((r) => r.filename)).toEqual(["0001_good.sql"]);
  });

  it("resumes cleanly after a failure once the migration is fixed", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_bad.sql": "SELECT no_such_function();",
    });
    await expect(runMigrations(pool, appSource(dir))).rejects.toThrow(MigrationError);

    await writeFile(
      path.join(dir, "0001_bad.sql"),
      "CREATE TABLE fixed (id int)",
      "utf8",
    );
    // The failed file was never recorded, so the fixed version applies as new
    // — checksum immutability only covers migrations that actually applied.
    const result = await runMigrations(pool, appSource(dir));
    expect(result.applied).toEqual(["app/0001_bad.sql"]);
    expect(await tableExists(pool, "fixed")).toBe(true);
  });

  it("rejects filenames that break the ordered naming convention", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "create_things.sql": "CREATE TABLE things (id int)",
    });

    await expect(runMigrations(pool, appSource(dir))).rejects.toThrowError(
      /must match NNNN_snake_case\.sql.*'app'.*create_things\.sql/,
    );
  });

  it("fails with a named directory and source when the migrations dir is missing", async () => {
    const pool = await db.createIsolatedPool();
    await expect(
      runMigrations(pool, [{ source: "app", dir: "/nonexistent/migrations" }]),
    ).rejects.toThrowError(/\/nonexistent\/migrations.*'app'/);
  });

  it("refuses a pre-D8 single-column ledger with an actionable message", async () => {
    const pool = await db.createIsolatedPool();
    await pool.query(
      `CREATE TABLE schema_migrations (
         filename   text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const dir = await migrationDir({ "0001_t.sql": "CREATE TABLE t (id int)" });

    await expect(runMigrations(pool, appSource(dir))).rejects.toThrowError(
      /predates namespaced migration sources/,
    );
  });

  it("serializes concurrent runners via the advisory lock (each file applies once)", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_once.sql": "CREATE TABLE once (id int)",
      "0002_seed_once.sql": "INSERT INTO once VALUES (1)",
    });

    // Without the advisory lock, both runners would race CREATE TABLE and
    // one would crash — or worse, both would INSERT. With it, one applies
    // and the other skips.
    const [a, b] = await Promise.all([
      runMigrations(pool, appSource(dir)),
      runMigrations(pool, appSource(dir)),
    ]);

    const totalApplied = a.applied.length + b.applied.length;
    expect(totalApplied).toBe(2);
    const rows = await pool.query("SELECT count(*)::int AS n FROM once");
    expect(rows.rows[0].n).toBe(1);
  });
});
