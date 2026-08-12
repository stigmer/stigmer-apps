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
  createdAt?: string;
  weightGrams?: bigint;
}): Widget {
  return create(WidgetSchema, {
    apiVersion: "testing.stigmer.ai/v1",
    kind: "Widget",
    metadata: create(ResourceMetadataSchema, {
      id: overrides.id,
      version: overrides.version ?? 1n,
      createdAt: timestampFromDate(new Date(overrides.createdAt ?? "2026-08-08T05:00:00Z")),
      createdBy: create(ActorSchema, { id: "tester" }),
      updatedAt: timestampFromDate(new Date(overrides.createdAt ?? "2026-08-08T05:00:00Z")),
      updatedBy: create(ActorSchema, { id: "tester" }),
    }),
    spec: {
      serialNumber: overrides.serialNumber,
      name: overrides.name ?? `widget ${overrides.serialNumber}`,
      inspectionDate: overrides.inspectionDate,
      ownerId: overrides.ownerId ?? "",
      weightGrams: overrides.weightGrams,
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

    it("filters on a status-backed boolean by its proto3-JSON text (T03 D5)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_live", serialNumber: "SN-L" }));
        await store.save("Widget", makeWidget({ id: "wdg_dead", serialNumber: "SN-D", retired: true }));

        const retired = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          filter: { retired: "true" },
        });
        expect(retired.items.map((w) => w.metadata?.id)).toEqual(["wdg_dead"]);
        expect(retired.totalCount).toBe(1);
      });
    });

    it("orders by metadata creation time — RFC3339 text sorts chronologically (T03 D5)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_mid", serialNumber: "M", createdAt: "2026-08-08T09:00:00Z" }));
        await store.save("Widget", makeWidget({ id: "wdg_new", serialNumber: "Z", createdAt: "2026-08-08T11:00:00Z" }));
        await store.save("Widget", makeWidget({ id: "wdg_old", serialNumber: "A", createdAt: "2026-08-08T07:00:00Z" }));

        const newestFirst = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "createdAt", direction: "desc", nulls: "last" },
        });
        expect(newestFirst.items.map((w) => w.metadata?.id)).toEqual([
          "wdg_new",
          "wdg_mid",
          "wdg_old",
        ]);
      });
    });

    it("counts grouped by a registered field in one call (T03 D4 — the anti-N+1 seam)", async () => {
      await withStore(async (store) => {
        for (const [id, owner] of [
          ["wdg_1", "owner-a"],
          ["wdg_2", "owner-a"],
          ["wdg_3", "owner-b"],
          ["wdg_4", "owner-c"],
        ] as const) {
          await store.save("Widget", makeWidget({ id, serialNumber: `SN-${id}`, ownerId: owner }));
        }

        const counts = await store.countBy("Widget", "ownerId", [
          "owner-a",
          "owner-b",
          "owner-none",
        ]);
        expect(counts.get("owner-a")).toBe(2);
        expect(counts.get("owner-b")).toBe(1);
        // Absent from the result means zero — and unrequested values
        // ("owner-c") are not reported.
        expect(counts.has("owner-none")).toBe(false);
        expect(counts.has("owner-c")).toBe(false);
      });
    });

    it("countBy with no values returns an empty map without touching the store", async () => {
      await withStore(async (store) => {
        expect((await store.countBy("Widget", "ownerId", [])).size).toBe(0);
      });
    });

    it("rejects countBy on unregistered fields loudly", async () => {
      await withStore(async (store) => {
        await expect(store.countBy("Widget", "noSuchField", ["x"])).rejects.toThrowError(
          /noSuchField/,
        );
      });
    });

    it("getByIds returns found rows keyed by id; unknown ids are simply absent (T04b D9)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1" }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "SN-2" }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "SN-3" }));

        const found = await store.getByIds("Widget", ["wdg_1", "wdg_3", "wdg_gone"]);
        expect(found.size).toBe(2);
        expect((found.get("wdg_1") as Widget).spec?.serialNumber).toBe("SN-1");
        expect((found.get("wdg_3") as Widget).spec?.serialNumber).toBe("SN-3");
        expect(found.has("wdg_gone")).toBe(false);
        // Unrequested rows are not reported.
        expect(found.has("wdg_2")).toBe(false);
      });
    });

    it("getByIds with no ids returns an empty map without touching the store", async () => {
      await withStore(async (store) => {
        expect((await store.getByIds("Widget", [])).size).toBe(0);
      });
    });

    it("rejects getByIds on unregistered kinds loudly", async () => {
      await withStore(async (store) => {
        await expect(store.getByIds("Gadget", ["gdt_1"])).rejects.toThrowError(/Gadget/);
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

    // ── The T05 filter vocabulary: in / range / absent (AND-only) ──────

    it("filters by set membership; an empty set matches nothing", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1", ownerId: "owner-a" }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "SN-2", ownerId: "owner-b" }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "SN-3", ownerId: "owner-c" }));

        const some = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          filter: { ownerId: { in: ["owner-a", "owner-c", "owner-none"] } },
        });
        expect(some.items.map((w) => w.metadata?.id)).toEqual(["wdg_1", "wdg_3"]);
        expect(some.totalCount).toBe(2);

        const none = await store.list("Widget", {
          limit: 10,
          offset: 0,
          filter: { ownerId: { in: [] } },
        });
        expect(none.items).toEqual([]);
        expect(none.totalCount).toBe(0);
      });
    });

    it("filters by inclusive range — the hearing-window shape", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_before", serialNumber: "B", inspectionDate: "2026-08-08" }));
        await store.save("Widget", makeWidget({ id: "wdg_low", serialNumber: "L", inspectionDate: "2026-08-09" }));
        await store.save("Widget", makeWidget({ id: "wdg_mid", serialNumber: "M", inspectionDate: "2026-08-12" }));
        await store.save("Widget", makeWidget({ id: "wdg_high", serialNumber: "H", inspectionDate: "2026-08-16" }));
        await store.save("Widget", makeWidget({ id: "wdg_after", serialNumber: "A", inspectionDate: "2026-08-17" }));

        const window = await store.list("Widget", {
          limit: 10,
          offset: 0,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
          filter: { inspectionDate: { gte: "2026-08-09", lte: "2026-08-16" } },
        });
        expect(window.items.map((w) => w.metadata?.id)).toEqual(["wdg_low", "wdg_mid", "wdg_high"]);
        expect(window.totalCount).toBe(3);
      });
    });

    it("strict bounds are strict — the overdue shape (lt)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_past", serialNumber: "P", inspectionDate: "2026-08-08" }));
        await store.save("Widget", makeWidget({ id: "wdg_today", serialNumber: "T", inspectionDate: "2026-08-09" }));

        const past = await store.list("Widget", {
          limit: 10,
          offset: 0,
          filter: { inspectionDate: { lt: "2026-08-09" } },
        });
        expect(past.items.map((w) => w.metadata?.id)).toEqual(["wdg_past"]);
      });
    });

    it("a range NEVER matches a row whose field is absent", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_dated", serialNumber: "D", inspectionDate: "2026-08-01" }));
        await store.save("Widget", makeWidget({ id: "wdg_undated", serialNumber: "U" }));

        // Absent must not satisfy ANY bound direction: SQL comparison
        // against NULL is false, and the fake mirrors it. Without this
        // pin, "overdue" would quietly include tasks that have no due
        // date at all.
        for (const range of [{ lt: "2026-12-31" }, { gte: "2026-01-01" }]) {
          const result = await store.list("Widget", {
            limit: 10,
            offset: 0,
            filter: { inspectionDate: range },
          });
          expect(result.items.map((w) => w.metadata?.id)).toEqual(["wdg_dated"]);
          expect(result.totalCount).toBe(1);
        }
      });
    });

    it("absent matches exactly the rows where the field was never set", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_dated", serialNumber: "D", inspectionDate: "2026-08-01" }));
        await store.save("Widget", makeWidget({ id: "wdg_undated", serialNumber: "U" }));

        const undated = await store.list("Widget", {
          limit: 10,
          offset: 0,
          filter: { inspectionDate: { absent: true } },
        });
        expect(undated.items.map((w) => w.metadata?.id)).toEqual(["wdg_undated"]);
        expect(undated.totalCount).toBe(1);
      });
    });

    it("conditions on different fields AND together", async () => {
      await withStore(async (store) => {
        // Each of wdg_2/3/4 fails exactly one of the three conditions.
        // (The equality condition uses retired: "true" — a false bool is
        // omitted from proto3 JSON, so "false" is unfilterable-by-equality
        // by the port's own rendering rules, same as the T03 D5 test.)
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", ownerId: "owner-a", inspectionDate: "2026-08-01", retired: true }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "S2", ownerId: "owner-a", inspectionDate: "2026-09-01", retired: true }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "S3", ownerId: "owner-b", inspectionDate: "2026-08-01", retired: true }));
        await store.save("Widget", makeWidget({ id: "wdg_4", serialNumber: "S4", ownerId: "owner-a", inspectionDate: "2026-08-01", retired: false }));

        const result = await store.list("Widget", {
          limit: 10,
          offset: 0,
          filter: {
            ownerId: { in: ["owner-a"] },
            inspectionDate: { lt: "2026-08-15" },
            retired: "true",
          },
        });
        expect(result.items.map((w) => w.metadata?.id)).toEqual(["wdg_1"]);
        expect(result.totalCount).toBe(1);
      });
    });

    it("rejects malformed filter shapes loudly, naming the field", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "SN-1" }));

        // An empty range means nothing; guessing a meaning would return
        // wrong data (the unregistered-field rule applied to shapes).
        await expect(
          store.list("Widget", { limit: 10, offset: 0, filter: { inspectionDate: {} } }),
        ).rejects.toThrowError(/inspectionDate/);

        await expect(
          store.list("Widget", {
            limit: 10,
            offset: 0,
            filter: { ownerId: { in: ["x"], lt: "y" } as never },
          }),
        ).rejects.toThrowError(/ownerId/);
      });
    });

    // ── Filtered aggregation: countBy/sumBy (the balance seam) ──────────

    it("countBy narrows by a list-shaped filter (the open-deadline shape)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", ownerId: "owner-a", retired: true }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "S2", ownerId: "owner-a", retired: false }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "S3", ownerId: "owner-b", retired: true }));

        const counts = await store.countBy("Widget", "ownerId", ["owner-a", "owner-b"], {
          retired: "true",
        });
        expect(counts.get("owner-a")).toBe(1);
        expect(counts.get("owner-b")).toBe(1);
      });
    });

    it("sums an integer field grouped by another, one call per page", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", ownerId: "owner-a", weightGrams: 1500n }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "S2", ownerId: "owner-a", weightGrams: 2500n }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "S3", ownerId: "owner-b", weightGrams: 100n }));
        // owner-c's row exists but carries no weight: contributes nothing.
        await store.save("Widget", makeWidget({ id: "wdg_4", serialNumber: "S4", ownerId: "owner-c" }));

        const sums = await store.sumBy("Widget", "ownerId", "weightGrams", [
          "owner-a",
          "owner-b",
          "owner-c",
          "owner-none",
        ]);
        expect(sums.get("owner-a")).toBe(4000);
        expect(sums.get("owner-b")).toBe(100);
        // Absent means zero — a group with no contributing rows is not
        // reported (the countBy convention).
        expect(sums.has("owner-c")).toBe(false);
        expect(sums.has("owner-none")).toBe(false);
      });
    });

    it("sumBy narrows by a list-shaped filter (the charge-vs-receipt shape)", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", ownerId: "owner-a", weightGrams: 10n, retired: true }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "S2", ownerId: "owner-a", weightGrams: 7n, retired: false }));

        const retiredOnly = await store.sumBy(
          "Widget",
          "ownerId",
          "weightGrams",
          ["owner-a"],
          { retired: "true" },
        );
        expect(retiredOnly.get("owner-a")).toBe(10);
      });
    });

    it("sumBy with no group values returns an empty map without touching the store", async () => {
      await withStore(async (store) => {
        expect((await store.sumBy("Widget", "ownerId", "weightGrams", [])).size).toBe(0);
      });
    });

    it("sumBy rejects a non-integer value field loudly, never a silent 0", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", ownerId: "owner-a", name: "not a number" }));
        // `name` is a registered field whose rendering is text — summing
        // it is a programming error both adapters must refuse the same way.
        await expect(
          store.sumBy("Widget", "ownerId", "name", ["owner-a"]),
        ).rejects.toThrowError();
      });
    });

    it("rejects sumBy on unregistered fields loudly", async () => {
      await withStore(async (store) => {
        await expect(
          store.sumBy("Widget", "noSuchField", "weightGrams", ["x"]),
        ).rejects.toThrowError(/noSuchField/);
      });
    });

    // ── searchText (the conflict-check seam) ────────────────────────────

    it("searches case-insensitively by substring, ordered by the field", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", name: "Meridian Textiles" }));
        await store.save("Widget", makeWidget({ id: "wdg_2", serialNumber: "S2", name: "Blue Harbour Logistics" }));
        await store.save("Widget", makeWidget({ id: "wdg_3", serialNumber: "S3", name: "meridian holdings" }));

        const hits = (await store.searchText("Widget", "name", "MERIDIAN", 10)) as Widget[];
        expect(hits.map((w) => w.metadata?.id)).toEqual(["wdg_1", "wdg_3"]);
      });
    });

    it("search caps at the limit and never counts", async () => {
      await withStore(async (store) => {
        for (let i = 0; i < 5; i++) {
          await store.save("Widget", makeWidget({ id: `wdg_${i}`, serialNumber: `S${i}`, name: `common name ${i}` }));
        }
        const hits = await store.searchText("Widget", "name", "common", 2);
        expect(hits.length).toBe(2);
      });
    });

    it("search matches % and _ literally — user input is never a wildcard", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_pct", serialNumber: "S1", name: "100% Cotton Mills" }));
        await store.save("Widget", makeWidget({ id: "wdg_plain", serialNumber: "S2", name: "Cotton Mills" }));

        const hits = (await store.searchText("Widget", "name", "100% cot", 10)) as Widget[];
        expect(hits.map((w) => w.metadata?.id)).toEqual(["wdg_pct"]);

        // A bare % must not become match-everything.
        const pct = (await store.searchText("Widget", "name", "%", 10)) as Widget[];
        expect(pct.map((w) => w.metadata?.id)).toEqual(["wdg_pct"]);
      });
    });

    it("search never matches rows whose field is absent", async () => {
      await withStore(async (store) => {
        // inspectionDate doubles as an optional searchable field here.
        await store.save("Widget", makeWidget({ id: "wdg_dated", serialNumber: "S1", inspectionDate: "2026-08-01" }));
        await store.save("Widget", makeWidget({ id: "wdg_undated", serialNumber: "S2" }));

        const hits = (await store.searchText("Widget", "inspectionDate", "2026", 10)) as Widget[];
        expect(hits.map((w) => w.metadata?.id)).toEqual(["wdg_dated"]);
      });
    });

    it("rejects search on unregistered fields and empty queries loudly", async () => {
      await withStore(async (store) => {
        await expect(store.searchText("Widget", "noSuchField", "x", 10)).rejects.toThrowError(
          /noSuchField/,
        );
        await expect(store.searchText("Widget", "name", "", 10)).rejects.toThrowError(
          /empty/,
        );
      });
    });

    it("search narrows by a filter with list's vocabulary — eq and in", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_a", serialNumber: "S1", name: "annual report", ownerId: "own_1" }));
        await store.save("Widget", makeWidget({ id: "wdg_b", serialNumber: "S2", name: "annual audit", ownerId: "own_2" }));
        await store.save("Widget", makeWidget({ id: "wdg_c", serialNumber: "S3", name: "annual note", ownerId: "own_3" }));

        const eq = (await store.searchText("Widget", "name", "annual", 10, {
          ownerId: "own_2",
        })) as Widget[];
        expect(eq.map((w) => w.metadata?.id)).toEqual(["wdg_b"]);

        const within = (await store.searchText("Widget", "name", "annual", 10, {
          ownerId: { in: ["own_1", "own_3"] },
        })) as Widget[];
        expect(within.map((w) => w.metadata?.id)).toEqual(["wdg_c", "wdg_a"]);
      });
    });

    it("an empty in-filter searches nothing — never everything", async () => {
      await withStore(async (store) => {
        await store.save("Widget", makeWidget({ id: "wdg_1", serialNumber: "S1", name: "findable", ownerId: "own_1" }));
        const hits = await store.searchText("Widget", "name", "findable", 10, {
          ownerId: { in: [] },
        });
        expect(hits.length).toBe(0);
      });
    });

    it("the filter runs BEFORE the limit — out-of-scope rows never occupy result slots", async () => {
      await withStore(async (store) => {
        // Ten out-of-scope matches that sort AHEAD of the one in-scope
        // match: a post-filtered implementation would fetch the first
        // `limit` hits, filter them all away, and starve out the real
        // one — the exact bug the parameter exists to prevent.
        for (let i = 0; i < 10; i++) {
          await store.save(
            "Widget",
            makeWidget({ id: `wdg_out_${i}`, serialNumber: `SO${i}`, name: `aaa shared term ${i}`, ownerId: "other" }),
          );
        }
        await store.save(
          "Widget",
          makeWidget({ id: "wdg_mine", serialNumber: "SM", name: "zzz shared term", ownerId: "mine" }),
        );

        const hits = (await store.searchText("Widget", "name", "shared term", 5, {
          ownerId: "mine",
        })) as Widget[];
        expect(hits.map((w) => w.metadata?.id)).toEqual(["wdg_mine"]);
      });
    });

    it("rejects a search filter on an unregistered field loudly", async () => {
      await withStore(async (store) => {
        await expect(
          store.searchText("Widget", "name", "x", 10, { noSuchField: "v" }),
        ).rejects.toThrowError(/noSuchField/);
      });
    });

    it("equal order keys page deterministically by id across both adapters", async () => {
      await withStore(async (store) => {
        // Inserted deliberately out of id order so the memory adapter's
        // insertion order disagrees with id order — the divergence the
        // tiebreak exists to close.
        await store.save("Widget", makeWidget({ id: "wdg_c", serialNumber: "C", inspectionDate: "2026-08-10" }));
        await store.save("Widget", makeWidget({ id: "wdg_a", serialNumber: "A", inspectionDate: "2026-08-10" }));
        await store.save("Widget", makeWidget({ id: "wdg_b", serialNumber: "B", inspectionDate: "2026-08-10" }));

        const first = await store.list("Widget", {
          limit: 2,
          offset: 0,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
        });
        const second = await store.list("Widget", {
          limit: 2,
          offset: 2,
          orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
        });
        expect(
          [...first.items, ...second.items].map((w) => w.metadata?.id),
        ).toEqual(["wdg_a", "wdg_b", "wdg_c"]);
      });
    });
  });
}
