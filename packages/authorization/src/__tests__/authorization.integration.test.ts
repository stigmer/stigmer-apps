/**
 * Integration suite against a real OpenFGA container (no mocks — the
 * repo rule). One container for the file; each test isolates by using
 * its own store name. Fixtures are deliberately generic (group/resource)
 * — no vertical's vocabulary may appear in a commons test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapAuthorization } from "../bootstrap.js";
import { reconcileTuples } from "../reconcile.js";
import { idOf, ref, tupleId } from "../tuples.js";
import { startTestAuthorizationServer, type TestAuthorizationServer } from "../testing.js";

const MODEL_DSL = `model
  schema 1.1

type user

type group
  relations
    define admin: [user]
    define member: [user] or admin

type resource
  relations
    define parent: [group]
    define owner: [user]
    define viewer: [user] or owner or member from parent
`;

let server: TestAuthorizationServer;
let storeCounter = 0;

function nextStoreName(): string {
  storeCounter += 1;
  return `authz_test_store_${storeCounter}`;
}

beforeAll(async () => {
  server = await startTestAuthorizationServer();
}, 120_000);

afterAll(async () => {
  await server.stop();
});

describe("bootstrap", () => {
  it("creates the store and model once, then finds both again (idempotent)", async () => {
    const storeName = nextStoreName();
    const first = await bootstrapAuthorization({
      connection: server.connection,
      storeName,
      modelDsl: MODEL_DSL,
    });
    const second = await bootstrapAuthorization({
      connection: server.connection,
      storeName,
      modelDsl: MODEL_DSL,
    });
    expect(second.storeId).toBe(first.storeId);
    expect(second.modelId).toBe(first.modelId);
  });

  it("writes a new model when the DSL changes", async () => {
    const storeName = nextStoreName();
    const first = await bootstrapAuthorization({
      connection: server.connection,
      storeName,
      modelDsl: MODEL_DSL,
    });
    const evolved = await bootstrapAuthorization({
      connection: server.connection,
      storeName,
      modelDsl: `${MODEL_DSL}
type widget
  relations
    define holder: [user]
`,
    });
    expect(evolved.storeId).toBe(first.storeId);
    expect(evolved.modelId).not.toBe(first.modelId);
  });

  it("refuses a caller without the preshared key", async () => {
    await expect(
      bootstrapAuthorization({
        connection: { apiUrl: server.connection.apiUrl },
        storeName: nextStoreName(),
        modelDsl: MODEL_DSL,
      }),
    ).rejects.toThrow();
  });
});

describe("engine", () => {
  it("answers checks through direct and derived relations", async () => {
    const { engine } = await bootstrapAuthorization({
      connection: server.connection,
      storeName: nextStoreName(),
      modelDsl: MODEL_DSL,
    });
    await engine.write({
      writes: [
        { user: ref("user", "ann"), relation: "admin", object: ref("group", "g1") },
        { user: ref("group", "g1"), relation: "parent", object: ref("resource", "r1") },
      ],
    });

    // Direct relation.
    expect(
      await engine.check({ user: ref("user", "ann"), relation: "admin", object: ref("group", "g1") }),
    ).toBe(true);
    // Derived: admin ⇒ member ⇒ viewer-from-parent.
    expect(
      await engine.check({ user: ref("user", "ann"), relation: "viewer", object: ref("resource", "r1") }),
    ).toBe(true);
    // Deny for a stranger — the answer that matters most.
    expect(
      await engine.check({ user: ref("user", "bob"), relation: "viewer", object: ref("resource", "r1") }),
    ).toBe(false);
  });

  it("treats re-writes and missing deletes as settled (idempotent write)", async () => {
    const { engine } = await bootstrapAuthorization({
      connection: server.connection,
      storeName: nextStoreName(),
      modelDsl: MODEL_DSL,
    });
    const tuple = { user: ref("user", "ann"), relation: "owner", object: ref("resource", "r1") };
    await engine.write({ writes: [tuple] });
    await expect(engine.write({ writes: [tuple] })).resolves.toBeUndefined();
    await engine.write({ deletes: [tuple] });
    await expect(engine.write({ deletes: [tuple] })).resolves.toBeUndefined();
    expect(await engine.check(tuple)).toBe(false);
  });

  it("rejects a genuinely invalid tuple instead of swallowing it", async () => {
    const { engine } = await bootstrapAuthorization({
      connection: server.connection,
      storeName: nextStoreName(),
      modelDsl: MODEL_DSL,
    });
    await expect(
      engine.write({
        writes: [{ user: ref("user", "ann"), relation: "no_such_relation", object: ref("group", "g1") }],
      }),
    ).rejects.toThrow(/no_such_relation/);
  });

  it("lists objects a user holds a relation to", async () => {
    const { engine } = await bootstrapAuthorization({
      connection: server.connection,
      storeName: nextStoreName(),
      modelDsl: MODEL_DSL,
    });
    await engine.write({
      writes: [
        { user: ref("user", "ann"), relation: "owner", object: ref("resource", "r1") },
        { user: ref("user", "ann"), relation: "owner", object: ref("resource", "r2") },
        { user: ref("user", "bob"), relation: "owner", object: ref("resource", "r3") },
      ],
    });
    const objects = await engine.listObjects(ref("user", "ann"), "viewer", "resource");
    expect(objects.map(idOf).sort()).toEqual(["r1", "r2"]);
  });
});

describe("reconcileTuples", () => {
  it("writes missing tuples and deletes stale ones to match the desired set", async () => {
    const { engine } = await bootstrapAuthorization({
      connection: server.connection,
      storeName: nextStoreName(),
      modelDsl: MODEL_DSL,
    });
    // Drifted actual state: one stale grant, one kept grant.
    await engine.write({
      writes: [
        { user: ref("user", "stale"), relation: "owner", object: ref("resource", "r9") },
        { user: ref("user", "kept"), relation: "owner", object: ref("resource", "r1") },
      ],
    });

    const desired = [
      { user: ref("user", "kept"), relation: "owner", object: ref("resource", "r1") },
      { user: ref("user", "added"), relation: "owner", object: ref("resource", "r2") },
    ];
    const result = await reconcileTuples(engine, desired);
    expect(result).toEqual({ written: 1, deleted: 1 });

    const actual = await engine.readAll();
    expect(new Set(actual.map(tupleId))).toEqual(new Set(desired.map(tupleId)));

    // A second reconcile is a no-op — the fixed point.
    expect(await reconcileTuples(engine, desired)).toEqual({ written: 0, deleted: 0 });
  });
});
