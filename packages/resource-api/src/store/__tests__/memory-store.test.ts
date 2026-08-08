import { MemoryResourceStore } from "../memory-store.js";
import { WidgetSchema } from "../../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { runStoreContractTests } from "./store-contract.js";

runStoreContractTests("MemoryResourceStore", async () => ({
  store: new MemoryResourceStore({
    Widget: {
      schema: WidgetSchema,
      naturalKeyField: "serialNumber",
      // Must mirror the generated columns the Postgres contract run
      // registers — same logical names, same JSON roots (T03 D5).
      fields: {
        inspectionDate: "spec.inspectionDate",
        ownerId: "spec.ownerId",
        retired: "status.retired",
        createdAt: "metadata.createdAt",
      },
    },
  }),
}));
