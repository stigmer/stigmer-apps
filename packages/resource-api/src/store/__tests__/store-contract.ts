/**
 * The store contract suite: one set of behavioral assertions run against
 * EVERY adapter (memory, Postgres). If the fake and the real store can
 * drift, tests written on the fake prove nothing — this suite is what
 * makes them interchangeable.
 *
 * Uses the Widget fixture resource (testproto) like every commons test:
 * business-agnostic by contract.
 */

import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  WidgetSchema,
  type Widget,
} from "../../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { ActorSchema, ResourceMetadataSchema } from "../../envelope.js";
import { DuplicateNaturalKeyError, type ResourceStore } from "../store.js";

export function makeWidget(overrides: {
  id: string;
  serialNumber: string;
  name?: string;
  inspectionDate?: string;
  ownerId?: string;
  retired?: boolean;
  version?: bigint;
}): Widget {
  return create(WidgetSchema, {
    apiVersion: "testing.stigmer.ai/v1",
    kind: "Widget",
    metadata: create(ResourceMetadataSchema, {
      id: overrides.id,
      version: overrides.version ?? 1n,
      createdAt: timestampFromDate(new Date("2026-08-08T05:00:00Z")),
      createdBy: create(ActorSchema, { id: "tester" }),
      updatedAt: timestampFromDate(new Date("2026-08-08T05:00:00Z")),
      updatedBy: create(ActorSchema, { id: "tester" }),
    }),
    spec: {
      serialNumber: overrides.serialNumber,
      name: overrides.name ?? `widget ${overrides.serialNumber}`,
      inspectionDate: overrides.inspectionDate,
      ownerId: overrides.ownerId ?? "",
    },
    status: { retired: overrides.retired ?? false },
  });
}

export function runStoreContractTests(
  adapterName: string,
  makeStore: () => Promise<{ store: ResourceStore; teardown?: () => Promise<void> }>,
): void {
  describe(`ResourceStore contract: ${adapterName}`, () => {
    async function withStore(
      fn: (store: ResourceStore) => Promise<void>,
    ): Promise<void> {
      const { store, teardown } = await makeStore();
      try {
        await fn(store);
      } finally {
        await teardown?.();
      }
    }

    it("round-trips a resource through save/getById with full fidelity", async () => {
      await withStore(async (store) => {
        const widget = makeWidget({
          id: "wdg_1",
          serialNumber: "SN-1",
          inspectionDate: "2026-09-01",
          version: 3n,
        });
        await store.save("Widget", widget);

        const loaded = (await store.getById("Widget", "wdg_1")) as Widget;
        expect(loaded).toBeDefined();
        // Envelope fidelity: bigint version, timestamps, actors.
        expect(loaded.metadata?.version).toBe(3n);
        expect(loaded.metadata?.createdBy?.id).toBe("tester");
        expect(loaded.metadata?.createdAt?.seconds).toBe(
          widget.metadata?.createdAt?.seconds,
        );
        expect(loaded.spec?.serialNumber).toBe("SN-1");
        expect(loaded.spec?.inspectionDate).toBe("2026-09-01");
        expect(loaded.status?.retired).toBe(false);
      });
    });

    it("returns undefined for an unknown id", async () => {
      await withStore(async (store) => {
        expect(await store.getById("Widget", "wdg_nope")).toBeUndefined();
      });
    });

    it("upserts: saving the same id replaces the row", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1" }));
        await store.save(
          "Widget",
          makeWidget({ id: "wdg_1", serialNumber: "SN-1", name: "renamed", version: 2n }),
        );
        const loaded = (await store.getById("Widget", "wdg_1")) as Widget;
        expect(loaded.spec?.name).toBe("renamed");
        expect(loaded.metadata?.version).toBe(2n);
        const listed = await store.list("Widget", { limit: 10, offset: 0 });
        expect(listed.totalCount).toBe(1);
      });
    });

    it("rejects a second resource with the same natural key", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-DUP" }));
        await expect(
          store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "SN-DUP" })),
        ).rejects.toThrowError(DuplicateNaturalKeyError);
      });
    });

    it("finds by natural key and returns undefined for misses", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-42" }));
        const found = (await store.getByNaturalKey("Widget", "SN-42")) as Widget;
        expect(found.metadata?.id).toBe("wdg_1");
        expect(await store.getByNaturalKey("Widget", "SN-nope")).toBeUndefined();
      });
    });

    it("orders ascending with unset fields last (the hearing-date contract)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_b", serialNumber: "B", inspectionDate: "2026-09-15" }));
        await store.save("Widget", makeWidget({ id: "wdg_none", serialNumber: "N" }));
        await store.save("Widget", makeWidget({ id: "wdg_a", serialNumber: "A", inspectionDate: "2026-08-20" }));

        const result = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
        });
        expect(result.items.map((w) => w.metadata?.id)).toEqual([
          "wdg_a",
          "wdg_b",
          "wdg_none",
        ]);
      });
    });

    it("orders descending with unset fields first when asked", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_b", serialNumber: "B", inspectionDate: "2026-09-15" }));
        await store.save("Widget", makeWidget({ id: "wdg_none", serialNumber: "N" }));
        await store.save("Widget", makeWidget({ id: "wdg_a", serialNumber: "A", inspectionDate: "2026-08-20" }));

        const result = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "inspectionDate", direction: "desc", nulls: "first" },
        });
        expect(result.items.map((w) => w.metadata?.id)).toEqual([
          "wdg_none",
          "wdg_b",
          "wdg_a",
        ]);
      });
    });

    it("applies equality filters and reports total count across pages", async () => {
      await withStore(async (store) => {
        for (let i = 0; i < 5; i++) {
          await store.save(
            "Widget",
            makeWidget({
              id: `wdg_${i}`,
              serialNumber: `SN-${i}`,
              ownerId: i % 2 === 0 ? "owner-even" : "owner-odd",
              inspectionDate: `2026-08-1${i}`,
            }),
          );
        }
        const page = await store.list("Widget", {
          limit: 2,
          offset: 0,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
          filter: { ownerId: "owner-even" },
        });
        expect(page.totalCount).toBe(3);
        expect(page.items.map((w) => w.metadata?.id)).toEqual(["wdg_0", "wdg_2"]);

        const rest = await store.list("Widget", {
          limit: 2,
          offset: 2,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
          filter: { ownerId: "owner-even" },
        });
        expect(rest.items.map((w) => w.metadata?.id)).toEqual(["wdg_4"]);
      });
    });

    it("returns an empty page (not an error) when offset is past the end", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1" }));
        const result = await store.list("Widget", { limit: 10, offset: 100 });
        expect(result.items).toEqual([]);
        expect(result.totalCount).toBe(1);
      });
    });

    it("rejects order/filter on unregistered fields loudly", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1" }));
        await expect(
          store.list("Widget", {
            limit: 10,
            offset: 0,
            orderBy: { field: "noSuchField", direction: "asc", nulls: "last" },
          }),
        ).rejects.toThrowError(/noSuchField/);
      });
    });

    it("rejects operations on unregistered kinds loudly", async () => {
      await withStore(async (store) => {
        await expect(
          store.getById("Gadget", "gdt_1"),
        ).rejects.toThrowError(/Gadget/);
      });
    });
  });
}
