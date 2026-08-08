/**
 * The Postgres adapters against the package's OWN migrations — proving
 * the migration source and the adapters agree, standalone (DD-A1: a
 * commons package's tests run with no app present).
 */

import type pg from "pg";
import { runMigrations } from "@stigmer/resource-api/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateRefreshToken, REFRESH_TOKEN_TTL_SECONDS } from "../../refresh-token.js";
import { createPgCredentialStore, createPgRefreshTokenStore } from "../stores.js";
import { startTestDatabase, type TestDatabase } from "./testcontainers.js";

const MIGRATIONS_DIR = new URL("../../../migrations", import.meta.url).pathname;

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await db.stop();
});

async function migratedPool(): Promise<pg.Pool> {
  const pool = await db.createIsolatedPool();
  await runMigrations(pool, [{ source: "identity", dir: MIGRATIONS_DIR }]);
  return pool;
}

/** users has a real FK from the auth tables; satisfy it minimally. */
async function insertUser(pool: pg.Pool, id: string, email: string): Promise<void> {
  await pool.query(`INSERT INTO users (id, resource) VALUES ($1, $2)`, [
    id,
    JSON.stringify({ spec: { email } }),
  ]);
}

function expiry(secondsFromNow = REFRESH_TOKEN_TTL_SECONDS): Date {
  return new Date(Date.now() + secondsFromNow * 1000);
}

describe("PgCredentialStore", () => {
  it("sets, reads, and overwrites a password hash", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgCredentialStore(pool);

    expect(await store.getPasswordHash("user_1")).toBeUndefined();
    await store.setPasswordHash("user_1", "hash-one");
    expect(await store.getPasswordHash("user_1")).toBe("hash-one");
    await store.setPasswordHash("user_1", "hash-two");
    expect(await store.getPasswordHash("user_1")).toBe("hash-two");
  });
});

describe("PgRefreshTokenStore", () => {
  it("consumes a valid token exactly once", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const { sha256Hex } = generateRefreshToken();

    await store.insert("user_1", sha256Hex, expiry());
    expect(await store.consume(sha256Hex)).toEqual({ outcome: "ok", userId: "user_1" });
  });

  it("detects reuse and revokes the user's every session atomically", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const stolen = generateRefreshToken();
    const rotatedTo = generateRefreshToken();

    await store.insert("user_1", stolen.sha256Hex, expiry());
    await store.consume(stolen.sha256Hex); // legitimate use...
    await store.insert("user_1", rotatedTo.sha256Hex, expiry()); // ...rotated

    // The stolen copy arrives: reuse detected, AND the rotated-to session
    // is already dead (the atomic response — no caller can forget it).
    expect(await store.consume(stolen.sha256Hex)).toEqual({
      outcome: "reused",
      userId: "user_1",
    });
    expect(await store.consume(rotatedTo.sha256Hex)).toEqual({ outcome: "invalid" });
  });

  it("answers invalid for unknown and expired tokens", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const expired = generateRefreshToken();

    await store.insert("user_1", expired.sha256Hex, expiry(-60));
    expect(await store.consume(expired.sha256Hex)).toEqual({ outcome: "invalid" });
    expect(await store.consume(generateRefreshToken().sha256Hex)).toEqual({
      outcome: "invalid",
    });
  });

  it("serializes concurrent presentations: exactly one ok", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const { sha256Hex } = generateRefreshToken();
    await store.insert("user_1", sha256Hex, expiry());

    // The FOR UPDATE row lock forces an order; the loser must see the
    // winner's consumed_at and answer "reused", never a second "ok".
    const results = await Promise.all([store.consume(sha256Hex), store.consume(sha256Hex)]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["ok", "reused"]);
  });

  it("revokeAllForUser kills only that user's sessions", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    await insertUser(pool, "user_2", "b@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const mine = generateRefreshToken();
    const theirs = generateRefreshToken();
    await store.insert("user_1", mine.sha256Hex, expiry());
    await store.insert("user_2", theirs.sha256Hex, expiry());

    await store.revokeAllForUser("user_1");

    expect(await store.consume(mine.sha256Hex)).toEqual({ outcome: "invalid" });
    expect(await store.consume(theirs.sha256Hex)).toEqual({ outcome: "ok", userId: "user_2" });
  });

  it("purges expired rows opportunistically on insert", async () => {
    const pool = await migratedPool();
    await insertUser(pool, "user_1", "a@firm.example");
    const store = createPgRefreshTokenStore(pool);
    const old = generateRefreshToken();
    await store.insert("user_1", old.sha256Hex, expiry(-60));

    await store.insert("user_1", generateRefreshToken().sha256Hex, expiry());

    const rows = await pool.query(`SELECT token_hash FROM refresh_tokens`);
    expect(rows.rows.map((r) => r.token_hash)).not.toContain(old.sha256Hex);
  });
});
