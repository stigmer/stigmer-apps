/**
 * The channel identity resolver against real Postgres and this package's
 * real migrations — proving the 0002 phone column, the kind-config
 * registration, and every resolution rule in one arrangement. Fixture
 * discipline: short fictional phones only (the consuming repo's
 * customer-data guard treats anything real-shaped as a failure).
 */

import { create } from "@bufbuild/protobuf";
import pg from "pg";
import { PostgresResourceStore, runMigrations } from "@stigmer/resource-api/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChannelIdentityResolver,
  WHATSAPP_PHONE_KIND,
  type ChannelIdentityResolver,
} from "../../channel-identity.js";
import { UserSchema } from "../../gen/stigmer/identity/user/v1/user_pb.js";
import { identityStoreKinds } from "../kind-config.js";
import { startTestDatabase, type TestDatabase } from "./testcontainers.js";

const MIGRATIONS_DIR = new URL("../../../migrations", import.meta.url).pathname;

let db: TestDatabase;
let pool: pg.Pool;
let store: PostgresResourceStore;
let resolve: ChannelIdentityResolver;

beforeAll(async () => {
  db = await startTestDatabase();
  pool = await db.createIsolatedPool();
  await runMigrations(pool, [{ source: "identity", dir: MIGRATIONS_DIR }]);
  store = new PostgresResourceStore(pool, identityStoreKinds());
  resolve = createChannelIdentityResolver(store);

  // Seeded through the store directly: this suite tests resolution, not
  // the create pipeline (user-resource.integration.test.ts owns that).
  await seedUser("user_lawyer1", "asha@firm.example", "+91123456");
  await seedUser("user_lawyer2", "ravi@firm.example", "+91123457");
  await seedUser("user_nophone", "clerk@firm.example", undefined);
  // Two users deliberately sharing one number — the ambiguity fixture
  // (phone is non-unique by recorded deferral, migration 0002).
  await seedUser("user_shared_a", "shared-a@firm.example", "+91123999");
  await seedUser("user_shared_b", "shared-b@firm.example", "+91123999");
}, 120_000);

afterAll(async () => {
  // db.stop() ends every pool the helper created — ending them here too
  // double-ends and fails the suite at teardown.
  await db.stop();
});

async function seedUser(id: string, email: string, phone: string | undefined) {
  await store.save(
    "User",
    create(UserSchema, {
      apiVersion: "identity.stigmer.ai/v1",
      kind: "User",
      metadata: { id, version: 1n },
      spec: { email, name: email.split("@")[0], phone },
    }),
  );
}

describe("channel identity resolution (T05)", () => {
  it("resolves a wa_id to exactly the user whose E.164 phone matches", async () => {
    const result = await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91123456" });
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.principal).toEqual({ id: "user_lawyer1", kind: "user" });
    expect(result.user.spec?.email).toBe("asha@firm.example");
  });

  it("kind comparison is case-insensitive and trimmed (header values travel through YAML)", async () => {
    const result = await resolve({ kind: " Whatsapp_Phone ", value: "91123457" });
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.principal.id).toBe("user_lawyer2");
  });

  it("an unknown number is unknown — no fuzzy fallback exists to guess with", async () => {
    expect((await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91999999" })).outcome).toBe("unknown");
  });

  it("a foreign identity kind is nobody (deny by default)", async () => {
    expect((await resolve({ kind: "slack_user_id", value: "U0123" })).outcome).toBe("unknown");
    expect((await resolve({ kind: "anonymous", value: "" })).outcome).toBe("unknown");
    expect((await resolve({ kind: "", value: "91123456" })).outcome).toBe("unknown");
  });

  it("a malformed value (non-digits, empty, plus-prefixed) is unknown, never an error", async () => {
    for (const value of ["", "+91123456", "91 123 456", "abc", "0123456"]) {
      expect((await resolve({ kind: WHATSAPP_PHONE_KIND, value })).outcome).toBe("unknown");
    }
  });

  it("two users sharing a phone is AMBIGUOUS — refused, never guessed", async () => {
    expect((await resolve({ kind: WHATSAPP_PHONE_KIND, value: "91123999" })).outcome).toBe("ambiguous");
  });

  it("a store failure PROPAGATES — it must never degrade to 'unknown'", async () => {
    // An unreachable database (nothing listens on port 1): the resolver
    // must surface the outage, not answer "I don't know you".
    const deadPool = new pg.Pool({
      host: "127.0.0.1",
      port: 1,
      user: "nobody",
      database: "nowhere",
      connectionTimeoutMillis: 500,
    });
    deadPool.on("error", () => {});
    try {
      const deadResolve = createChannelIdentityResolver(
        new PostgresResourceStore(deadPool, identityStoreKinds()),
      );
      await expect(
        deadResolve({ kind: WHATSAPP_PHONE_KIND, value: "91123456" }),
      ).rejects.toThrowError();
    } finally {
      await deadPool.end();
    }
  });
});
