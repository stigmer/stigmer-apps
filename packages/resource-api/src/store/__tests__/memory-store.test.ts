import { MemoryResourceStore } from "../memory-store.js";
import { WidgetSchema } from "../../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { runStoreContractTests } from "./store-contract.js";

runStoreContractTests("MemoryResourceStore", async () => ({
  store: new MemoryResourceStore({
    Widget: {
      schema: WidgetSchema,
      naturalKeyField: "serialNumber",
      queryableFields: ["inspectionDate", "ownerId"],
    },
  }),
}));
