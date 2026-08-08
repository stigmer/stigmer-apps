import { afterAll, beforeAll } from "vitest";
import { WidgetSchema } from "../../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { runStoreContractTests } from "../../store/__tests__/store-contract.js";
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

runStoreContractTests("PostgresResourceStore", async () => {
  const pool = await db.createIsolatedPool();
  await runMigrations(pool, MIGRATIONS);
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
        },
      },
    }),
  };
});
