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

    const result = await runMigrations(pool, dir);

    expect(result.applied).toEqual(["0001_create_fruits.sql", "0002_add_color.sql"]);
    expect(result.skipped).toBe(0);
    // The schema itself proves ordering: 0002 only works if 0001 ran first.
    await pool.query("INSERT INTO fruits (name, color) VALUES ('mango', 'yellow')");

    const recorded = await pool.query(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(recorded.rows.map((r) => r.filename)).toEqual([
      "0001_create_fruits.sql",
      "0002_add_color.sql",
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_t.sql": "CREATE TABLE t (id int)",
    });

    await runMigrations(pool, dir);
    const second = await runMigrations(pool, dir);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(1);
  });

  it("applies only new files on a subsequent run", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_a.sql": "CREATE TABLE a (id int)",
    });
    await runMigrations(pool, dir);

    await writeFile(
      path.join(dir, "0002_create_b.sql"),
      "CREATE TABLE b (id int)",
      "utf8",
    );
    const result = await runMigrations(pool, dir);

    expect(result.applied).toEqual(["0002_create_b.sql"]);
    expect(result.skipped).toBe(1);
  });

  it("rejects edits to an already-applied migration (checksum drift)", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "0001_create_c.sql": "CREATE TABLE c (id int)",
    });
    await runMigrations(pool, dir);

    await writeFile(
      path.join(dir, "0001_create_c.sql"),
      "CREATE TABLE c (id int, edited text)",
      "utf8",
    );

    await expect(runMigrations(pool, dir)).rejects.toThrowError(
      /0001_create_c\.sql.*content has changed/,
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

    await expect(runMigrations(pool, dir)).rejects.toThrowError(
      /0002_bad\.sql.*rolled back/,
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
    await expect(runMigrations(pool, dir)).rejects.toThrow(MigrationError);

    await writeFile(
      path.join(dir, "0001_bad.sql"),
      "CREATE TABLE fixed (id int)",
      "utf8",
    );
    // The failed file was never recorded, so the fixed version applies as new
    // — checksum immutability only covers migrations that actually applied.
    const result = await runMigrations(pool, dir);
    expect(result.applied).toEqual(["0001_bad.sql"]);
    expect(await tableExists(pool, "fixed")).toBe(true);
  });

  it("rejects filenames that break the ordered naming convention", async () => {
    const pool = await db.createIsolatedPool();
    const dir = await migrationDir({
      "create_things.sql": "CREATE TABLE things (id int)",
    });

    await expect(runMigrations(pool, dir)).rejects.toThrowError(
      /must match NNNN_snake_case\.sql.*create_things\.sql/,
    );
  });

  it("fails with a named directory when the migrations dir is missing", async () => {
    const pool = await db.createIsolatedPool();
    await expect(
      runMigrations(pool, "/nonexistent/migrations"),
    ).rejects.toThrowError(/\/nonexistent\/migrations/);
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
      runMigrations(pool, dir),
      runMigrations(pool, dir),
    ]);

    const totalApplied = a.applied.length + b.applied.length;
    expect(totalApplied).toBe(2);
    const rows = await pool.query("SELECT count(*)::int AS n FROM once");
    expect(rows.rows[0].n).toBe(1);
  });
});
