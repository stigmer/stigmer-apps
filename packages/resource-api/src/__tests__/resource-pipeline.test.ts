/**
 * The pipeline behavior suite: a real Connect client against the defined
 * resource over createRouterTransport — the same code path production
 * requests take, minus the HTTP socket. Every assertion here is a
 * contract statement for every resource in every consuming product.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  type Widget,
  WidgetSchema,
  WidgetService,
  WidgetStatusSchema,
} from "../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { ResourceMetadataSchema } from "../envelope.js";
import { deny, type AuthorizationPolicy } from "../policy.js";
import { InProcessEventDispatcher, type ResourceEvent } from "../publisher.js";
import type { ResourceStore } from "../store/store.js";
import { asCaller, widgetMemoryStore, widgetResource } from "./widget-fixture.js";

function makeClient(options: {
  store?: ResourceStore;
  policy?: AuthorizationPolicy;
  publisher?: InProcessEventDispatcher;
} = {}) {
  const store = options.store ?? widgetMemoryStore();
  const resource = widgetResource({
    store,
    policy: options.policy,
    publisher: options.publisher,
  });
  const transport = createRouterTransport(resource.routes);
  return { client: createClient(WidgetService, transport), store };
}

function widgetInput(overrides: Partial<{ serialNumber: string; name: string; inspectionDate: string; ownerId: string }> = {}) {
  return create(WidgetSchema, {
    spec: {
      serialNumber: overrides.serialNumber ?? "SN-1",
      name: overrides.name ?? "test widget",
      inspectionDate: overrides.inspectionDate,
      ownerId: overrides.ownerId ?? "",
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: Code, messagePattern?: RegExp) {
  try {
    await promise;
    expect.fail(`expected ConnectError with code ${Code[code]}, got success`);
  } catch (err) {
    const cerr = ConnectError.from(err);
    expect(cerr.code, `expected ${Code[code]}, got ${Code[cerr.code]}: ${cerr.message}`).toBe(code);
    if (messagePattern) {
      expect(cerr.message).toMatch(messagePattern);
    }
  }
}

describe("create", () => {
  it("stamps the full envelope and ignores client-sent metadata/status", async () => {
    const { client } = makeClient();
    const input = widgetInput();
    // A client trying to smuggle system-managed fields:
    input.metadata = create(ResourceMetadataSchema, { id: "wdg_forged", version: 99n });
    input.status = create(WidgetStatusSchema, { retired: true, nameLength: 42 });

    const created = await client.create(input, asCaller("lawyer-1"));

    expect(created.metadata?.id).toMatch(/^wdg_[0-9a-z]{26}$/);
    expect(created.metadata?.id).not.toBe("wdg_forged");
    expect(created.metadata?.version).toBe(1n);
    expect(created.metadata?.createdBy?.id).toBe("lawyer-1");
    expect(created.metadata?.updatedBy?.id).toBe("lawyer-1");
    expect(created.metadata?.createdAt).toBeDefined();
    expect(created.apiVersion).toBe("testing.stigmer.ai/v1");
    expect(created.kind).toBe("Widget");
    // Smuggled status discarded; derived status computed fresh.
    expect(created.status?.retired).toBe(false);
    expect(created.status?.nameLength).toBe("test widget".length);
  });

  it("rejects invalid input with INVALID_ARGUMENT naming the violation", async () => {
    const { client } = makeClient();
    await expectCode(
      client.create(create(WidgetSchema, { spec: { serialNumber: "", name: "x" } }), asCaller("u1")),
      Code.InvalidArgument,
      /serial_number/,
    );
  });

  it("rejects a missing spec (the resource envelope is mandatory)", async () => {
    const { client } = makeClient();
    await expectCode(
      client.create(create(WidgetSchema, {}), asCaller("u1")),
      Code.InvalidArgument,
      /spec/,
    );
  });

  it("answers UNAUTHENTICATED when no caller identity is present", async () => {
    const { client } = makeClient();
    await expectCode(client.create(widgetInput()), Code.Unauthenticated);
  });

  it("answers PERMISSION_DENIED with the policy's reason", async () => {
    const { client } = makeClient({
      policy: { authorize: () => deny("Widgets are read-only for you") },
    });
    await expectCode(
      client.create(widgetInput(), asCaller("u1")),
      Code.PermissionDenied,
      /read-only for you/,
    );
  });

  it("rejects duplicate natural keys, naming resource, key, and value", async () => {
    const { client } = makeClient();
    await client.create(widgetInput({ serialNumber: "SN-DUP" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-DUP" }), asCaller("u2")),
      Code.AlreadyExists,
      /Widget with serial number 'SN-DUP' already exists/,
    );
  });

  it("maps the store's duplicate backstop to ALREADY_EXISTS (concurrent-create race)", async () => {
    // Simulate the race: the friendly pre-check misses (another writer
    // commits in between), so persist hits the uniqueness constraint.
    const real = widgetMemoryStore();
    let misses = 0;
    const racy: ResourceStore = {
      save: (kind, r) => real.save(kind, r),
      getById: (kind, id) => real.getById(kind, id),
      getByNaturalKey: async (kind, value) => {
        if (misses++ === 1) return undefined; // second create's pre-check lies
        return real.getByNaturalKey(kind, value);
      },
      list: (kind, q) => real.list(kind, q),
      countBy: (kind, field, values) => real.countBy(kind, field, values),
    };
    const { client } = makeClient({ store: racy });
    await client.create(widgetInput({ serialNumber: "SN-RACE" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-RACE" }), asCaller("u2")),
      Code.AlreadyExists,
      /SN-RACE/,
    );
  });
});

describe("update", () => {
  it("replaces spec, bumps version, preserves identity and create-audit", async () => {
    const { client } = makeClient();
    const created = await client.create(
      widgetInput({ serialNumber: "SN-1", name: "before" }),
      asCaller("author"),
    );

    const edit = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-1", name: "after" },
    } as never);
    const updated = await client.update(edit, asCaller("editor"));

    expect(updated.metadata?.id).toBe(created.metadata?.id);
    expect(updated.metadata?.version).toBe(2n);
    expect(updated.metadata?.createdBy?.id).toBe("author");
    expect(updated.metadata?.updatedBy?.id).toBe("editor");
    expect(updated.spec?.name).toBe("after");
  });

  it("preserves stored status across client updates (no clobbering)", async () => {
    const { client } = makeClient();
    const created = await client.create(widgetInput({ serialNumber: "SN-1" }), asCaller("u1"));
    await client.retire({ id: created.metadata?.id ?? "" }, asCaller("u1"));

    const edit = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-1", name: "renamed" },
      status: { retired: false, nameLength: 0 }, // client tries to un-retire
    } as never);
    const updated = await client.update(edit, asCaller("u1"));

    // Stored status came from the existing row, not the client.
    expect(updated.status?.retired).toBe(true);
    expect(updated.spec?.name).toBe("renamed");
  });

  it("answers NOT_FOUND (not PERMISSION_DENIED) for a missing id, even under deny-all", async () => {
    // The ordering contract: load precedes authorize (stigmer/stigmer#224).
    const { client } = makeClient({
      policy: { authorize: () => deny("nobody may do anything") },
    });
    const edit = create(WidgetSchema, {
      metadata: { id: "wdg_missing" },
      spec: { serialNumber: "SN-X", name: "x" },
    } as never);
    await expectCode(client.update(edit, asCaller("u1")), Code.NotFound, /wdg_missing/);
  });

  it("re-validates uniqueness when the natural key changes", async () => {
    const { client } = makeClient();
    await client.create(widgetInput({ serialNumber: "SN-A" }), asCaller("u1"));
    const b = await client.create(widgetInput({ serialNumber: "SN-B" }), asCaller("u1"));

    const edit = create(WidgetSchema, {
      metadata: { id: b.metadata?.id ?? "" },
      spec: { serialNumber: "SN-A", name: "collides" },
    } as never);
    await expectCode(client.update(edit, asCaller("u1")), Code.AlreadyExists, /SN-A/);
  });

  it("allows a natural-key edit to a free value", async () => {
    const { client } = makeClient();
    const created = await client.create(widgetInput({ serialNumber: "SN-OLD" }), asCaller("u1"));
    const edit = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-NEW", name: "renumbered" },
    } as never);
    const updated = await client.update(edit, asCaller("u1"));
    expect(updated.spec?.serialNumber).toBe("SN-NEW");
    const fetched = await client.get({ serialNumber: "SN-NEW" }, asCaller("u1"));
    expect(fetched.metadata?.id).toBe(created.metadata?.id);
  });
});

describe("get", () => {
  it("loads by id and by natural key, with derived status", async () => {
    const { client } = makeClient();
    const created = await client.create(
      widgetInput({ serialNumber: "SN-9", name: "nine" }),
      asCaller("u1"),
    );

    const byId = await client.get({ id: created.metadata?.id ?? "" }, asCaller("u1"));
    expect(byId.spec?.serialNumber).toBe("SN-9");
    expect(byId.status?.nameLength).toBe(4);

    const byKey = await client.get({ serialNumber: "SN-9" }, asCaller("u1"));
    expect(byKey.metadata?.id).toBe(created.metadata?.id);
  });

  it("answers NOT_FOUND naming the reference", async () => {
    const { client } = makeClient();
    await expectCode(
      client.get({ serialNumber: "SN-GHOST" }, asCaller("u1")),
      Code.NotFound,
      /Widget 'SN-GHOST' not found/,
    );
  });

  it("rejects an empty reference with INVALID_ARGUMENT", async () => {
    const { client } = makeClient();
    await expectCode(client.get({}, asCaller("u1")), Code.InvalidArgument, /id or serial number/);
  });
});

describe("list", () => {
  it("orders by the declared field ascending with unset values last", async () => {
    const { client } = makeClient();
    await client.create(widgetInput({ serialNumber: "B", inspectionDate: "2026-09-15" }), asCaller("u1"));
    await client.create(widgetInput({ serialNumber: "NONE" }), asCaller("u1"));
    await client.create(widgetInput({ serialNumber: "A", inspectionDate: "2026-08-20" }), asCaller("u1"));

    const res = await client.list({}, asCaller("u1"));
    expect(res.items.map((w) => w.spec?.serialNumber)).toEqual(["A", "B", "NONE"]);
    expect(res.totalCount).toBe(3n);
  });

  it("defaults to page size 20 and reports the full total", async () => {
    const { client } = makeClient();
    for (let i = 0; i < 25; i++) {
      await client.create(
        widgetInput({ serialNumber: `SN-${String(i).padStart(2, "0")}`, inspectionDate: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` }),
        asCaller("u1"),
      );
    }
    const res = await client.list({}, asCaller("u1"));
    expect(res.items).toHaveLength(20);
    expect(res.totalCount).toBe(25n);

    const page2 = await client.list({ pageOffset: 20 }, asCaller("u1"));
    expect(page2.items).toHaveLength(5);
  });

  it("applies declared equality filters", async () => {
    const { client } = makeClient();
    await client.create(widgetInput({ serialNumber: "M1", ownerId: "mine" }), asCaller("u1"));
    await client.create(widgetInput({ serialNumber: "T1", ownerId: "theirs" }), asCaller("u1"));
    const res = await client.list({ ownerId: "mine" }, asCaller("u1"));
    expect(res.items.map((w) => w.spec?.serialNumber)).toEqual(["M1"]);
  });

  it("rejects an out-of-range page size via proto rules", async () => {
    const { client } = makeClient();
    await expectCode(client.list({ pageSize: 1000 }, asCaller("u1")), Code.InvalidArgument);
  });

  it("requires authentication like every other operation", async () => {
    const { client } = makeClient();
    await expectCode(client.list({}), Code.Unauthenticated);
  });
});

describe("custom operation (retire)", () => {
  it("mutates stored status with update audit semantics", async () => {
    const { client } = makeClient();
    const created = await client.create(widgetInput({ serialNumber: "SN-R" }), asCaller("owner"));
    const retired = await client.retire({ id: created.metadata?.id ?? "" }, asCaller("closer"));

    expect(retired.status?.retired).toBe(true);
    expect(retired.metadata?.version).toBe(2n);
    expect(retired.metadata?.createdBy?.id).toBe("owner");
    expect(retired.metadata?.updatedBy?.id).toBe("closer");

    const fetched = await client.get({ id: created.metadata?.id ?? "" }, asCaller("owner"));
    expect(fetched.status?.retired).toBe(true);
  });

  it("authorizes through load: deny-all policy still yields NOT_FOUND for missing ids", async () => {
    const { client } = makeClient({ policy: { authorize: () => deny("no") } });
    await expectCode(client.retire({ id: "wdg_missing" }, asCaller("u1")), Code.NotFound);
  });

  it("is unauthenticated without a caller", async () => {
    const { client } = makeClient();
    const created = await client.create(widgetInput({ serialNumber: "SN-R2" }), asCaller("u1"));
    await expectCode(client.retire({ id: created.metadata?.id ?? "" }), Code.Unauthenticated);
  });
});

describe("declared absence", () => {
  it("answers UNIMPLEMENTED for a service method not bound in the declaration", async () => {
    const { client } = makeClient();
    await expectCode(
      client.archive({ id: "wdg_whatever" }, asCaller("u1")),
      Code.Unimplemented,
      /Archive/,
    );
  });
});

describe("events", () => {
  it("publishes created and updated events with previous state on update", async () => {
    const events: ResourceEvent[] = [];
    const dispatcher = new InProcessEventDispatcher();
    dispatcher.subscribe("Widget", (e) => {
      events.push(e);
    });
    const { client } = makeClient({ publisher: dispatcher });

    const created = await client.create(
      widgetInput({ serialNumber: "SN-E", name: "v1" }),
      asCaller("u1"),
    );
    const edit = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-E", name: "v2" },
    } as never);
    await client.update(edit, asCaller("u2"));

    expect(events.map((e) => e.type)).toEqual(["created", "updated"]);
    expect(events[0]?.actor.id).toBe("u1");
    expect(events[1]?.actor.id).toBe("u2");
    const updatedEvent = events[1];
    expect((updatedEvent?.previous as Widget | undefined)?.spec?.name).toBe("v1");
    expect((updatedEvent?.resource as Widget)?.spec?.name).toBe("v2");
  });

  it("never fails the request when a subscriber throws (publish is best-effort)", async () => {
    const dispatcher = new InProcessEventDispatcher();
    dispatcher.subscribe("Widget", () => {
      throw new Error("subscriber exploded");
    });
    const { client, store } = makeClient({ publisher: dispatcher });

    const created = await client.create(widgetInput({ serialNumber: "SN-BOOM" }), asCaller("u1"));
    // The write stands and the client saw success.
    expect(created.metadata?.id).toBeDefined();
    expect(await store.getById("Widget", created.metadata?.id ?? "")).toBeDefined();
  });

  it("never fails the request when the publisher itself fails", async () => {
    const { client } = makeClient({
      publisher: {
        publish: async () => {
          throw new Error("broker down");
        },
      } as never,
    });
    const created = await client.create(widgetInput({ serialNumber: "SN-DOWN" }), asCaller("u1"));
    expect(created.metadata?.id).toBeDefined();
  });
});
