import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WidgetSchema } from "../../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { runStoreContractTests } from "../../store/__tests__/store-contract.js";
import { assertStoreCapabilities } from "../capabilities.js";
import { runMigrations } from "../migrate.js";
import { PostgresResourceStore } from "../store.js";
import { startTestDatabase, type TestDatabase } from "./testcontainers.js";

const MIGRATIONS = new URL("./testdata", import.meta.url).pathname;

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await db.stop();
});

describe("assertStoreCapabilities", () => {
  it("passes on an ICU-enabled UTF8 database — even under the hostile C locale", async () => {
    const pool = await db.createIsolatedPool();
    await expect(assertStoreCapabilities(pool)).resolves.toBeUndefined();
  });
});

runStoreContractTests("PostgresResourceStore", async () => {
  const pool = await db.createIsolatedPool();
  await runMigrations(pool, [{ source: "testdata", dir: MIGRATIONS }]);
  return {
    store: new PostgresResourceStore(pool, {
      Widget: {
        schema: WidgetSchema,
        table: "widgets",
        naturalKey: { column: "serial_number", jsonField: "serialNumber" },
        columns: {
          inspectionDate: "inspection_date",
          ownerId: "owner_id",
          retired: "retired",
          createdAt: "created_at",
          name: "name",
          weightGrams: "weight_grams",
        },
      },
    }),
  };
});
