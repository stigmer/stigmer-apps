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
import { ALLOW, deny, type AuthorizationPolicy } from "../policy.js";
import type { PipelineStep } from "../pipeline.js";
import { InProcessEventDispatcher, type ResourceEvent } from "../publisher.js";
import type { WriteContext } from "../resource.js";
import type { ResourceStore } from "../store/store.js";
import { asCaller, widgetMemoryStore, widgetResource } from "./widget-fixture.js";

function makeClient(options: {
  store?: ResourceStore;
  policy?: AuthorizationPolicy;
  publisher?: InProcessEventDispatcher;
  duplicate?: "refuse" | "idempotent";
  beforePersist?: readonly PipelineStep<WriteContext<Widget>>[];
} = {}) {
  const store = options.store ?? widgetMemoryStore();
  const resource = widgetResource({
    store,
    policy: options.policy,
    publisher: options.publisher,
    duplicate: options.duplicate,
    beforePersist: options.beforePersist,
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
    // Both audit fields carry the caller's kind: the envelope is the one
    // home of provenance, so no spec ever needs a copy (S29).
    expect(created.metadata?.createdBy?.kind).toBe("user");
    expect(created.metadata?.updatedBy?.kind).toBe("user");
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

  it("shows the policy the validated input, so ownership is a policy rule", async () => {
    // "A user may create only what they own" needs the input; before S28
    // the slot saw undefined on create and products carried the rule as a
    // beforePersist guard. The policy also sees no stored resource here:
    // there is none yet, and the two must never be confused.
    const seen: unknown[] = [];
    const { client } = makeClient({
      policy: {
        authorize: ({ caller, operation, resource, input }) => {
          seen.push({ operation, resource, ownerId: (input as Widget | undefined)?.spec?.ownerId });
          const owner = (input as Widget | undefined)?.spec?.ownerId;
          return operation === "create" && owner !== caller?.id
            ? deny("You may only create widgets you own")
            : ALLOW;
        },
      },
    });
    await client.create(widgetInput({ ownerId: "u1" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-2", ownerId: "u2" }), asCaller("u1")),
      Code.PermissionDenied,
      /only create widgets you own/,
    );
    expect(seen).toEqual([
      { operation: "create", resource: undefined, ownerId: "u1" },
      { operation: "create", resource: undefined, ownerId: "u2" },
    ]);
  });

  it("refuses an unauthorized create before the duplicate check, so a held key cannot be probed", async () => {
    // The S28 probe: without the input in the slot, "may I create this"
    // could only be asked after ALREADY_EXISTS had already answered
    // "someone has this key". Authorization now comes first, so a caller
    // who may not create the resource learns nothing about its key.
    const { client } = makeClient({
      policy: {
        authorize: ({ caller, operation, input }) =>
          operation === "create" && (input as Widget | undefined)?.spec?.ownerId !== caller?.id
            ? deny("You may only create widgets you own")
            : ALLOW,
      },
    });
    await client.create(widgetInput({ serialNumber: "SN-HELD", ownerId: "u1" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-HELD", ownerId: "u1" }), asCaller("u2")),
      Code.PermissionDenied,
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
    const { client } = makeClient({ store: racyStore() });
    await client.create(widgetInput({ serialNumber: "SN-RACE" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-RACE" }), asCaller("u2")),
      Code.AlreadyExists,
      /SN-RACE/,
    );
  });
});

/**
 * Simulates the two-concurrent-creates race: the second create's friendly
 * pre-check misses (another writer commits in between), so the insert
 * hits the uniqueness constraint. The store's answers otherwise are real.
 */
function racyStore(): ResourceStore {
  const real = widgetMemoryStore();
  let lookups = 0;
  return {
    insert: (kind, r) => real.insert(kind, r),
    save: (kind, r) => real.save(kind, r),
    getById: (kind, id) => real.getById(kind, id),
    getByNaturalKey: async (kind, value) => {
      if (lookups++ === 1) return undefined; // second create's pre-check lies
      return real.getByNaturalKey(kind, value);
    },
    list: (kind, q) => real.list(kind, q),
    countBy: (kind, field, values, filter) => real.countBy(kind, field, values, filter),
    sumBy: (kind, groupField, valueField, values, filter) =>
      real.sumBy(kind, groupField, valueField, values, filter),
    searchText: (kind, field, query, limit) => real.searchText(kind, field, query, limit),
    getByIds: (kind, ids) => real.getByIds(kind, ids),
  };
}

describe("idempotent create (naturalKey.duplicate: idempotent)", () => {
  // The append-only ledger's contract (invest FR-LEDGER-002, gap 8): a
  // second write under a held key with the same content is "already
  // recorded" — the holder comes back, nothing is written or published;
  // a writer that disagrees with the record is refused, not kept.
  function idempotentClient(extra: { store?: ResourceStore; beforePersist?: readonly PipelineStep<WriteContext<Widget>>[] } = {}) {
    const events: ResourceEvent[] = [];
    const publisher = new InProcessEventDispatcher();
    publisher.subscribe("Widget", (e) => {
      events.push(e);
    });
    const made = makeClient({ ...extra, publisher, duplicate: "idempotent" });
    return { ...made, events };
  }

  it("returns the holder for identical content — same id, nothing written, no second event", async () => {
    const { client, store, events } = idempotentClient();
    const first = await client.create(widgetInput({ serialNumber: "SN-I" }), asCaller("u1"));
    const again = await client.create(widgetInput({ serialNumber: "SN-I" }), asCaller("u2", "system"));

    expect(again.metadata?.id).toBe(first.metadata?.id);
    expect(again.metadata?.version).toBe(1n);
    // The first writer's stamp stands: content converged, provenance did not move.
    expect(again.metadata?.createdBy?.id).toBe("u1");
    expect((await store.list("Widget", { limit: 10, offset: 0 })).totalCount).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["created"]);
  });

  it("refuses different content under the held key, naming the difference", async () => {
    const { client, events } = idempotentClient();
    await client.create(widgetInput({ serialNumber: "SN-I", name: "one" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-I", name: "two" }), asCaller("u1")),
      Code.AlreadyExists,
      /Widget with serial number 'SN-I' already exists with different content/,
    );
    expect(events).toHaveLength(1);
  });

  it("compares the content the create WOULD persist: a beforePersist normaliser is honoured", async () => {
    // identity's normalize-user lowercases the email in beforePersist
    // ("shapes exactly what gets persisted"); a compare on the raw input
    // would call the holder and its own retry different.
    const normalizeName: PipelineStep<WriteContext<Widget>> = {
      name: "normalize-name",
      execute(ctx) {
        const state = ctx.newState as Widget;
        if (state.spec) state.spec.name = state.spec.name.trim().toUpperCase();
      },
    };
    const { client, store } = idempotentClient({ beforePersist: [normalizeName] });
    const first = await client.create(
      widgetInput({ serialNumber: "SN-N", name: "  widget " }),
      asCaller("u1"),
    );
    expect(first.spec?.name).toBe("WIDGET");
    const again = await client.create(widgetInput({ serialNumber: "SN-N", name: "widget" }), asCaller("u1"));
    expect(again.metadata?.id).toBe(first.metadata?.id);
    expect((await store.list("Widget", { limit: 10, offset: 0 })).totalCount).toBe(1);
  });

  it("applies the same verdict when the duplicate is only found at insert (the race backstop)", async () => {
    const { client, events } = idempotentClient({ store: racyStore() });
    const first = await client.create(widgetInput({ serialNumber: "SN-IR" }), asCaller("u1"));
    const again = await client.create(widgetInput({ serialNumber: "SN-IR" }), asCaller("u2"));
    expect(again.metadata?.id).toBe(first.metadata?.id);
    expect(events).toHaveLength(1);

    const { client: other } = idempotentClient({ store: racyStore() });
    await other.create(widgetInput({ serialNumber: "SN-IR2", name: "one" }), asCaller("u1"));
    await expectCode(
      other.create(widgetInput({ serialNumber: "SN-IR2", name: "two" }), asCaller("u1")),
      Code.AlreadyExists,
      /different content/,
    );
  });

  it("a refuse kind is unchanged: identical content is still ALREADY_EXISTS", async () => {
    const { client } = makeClient();
    await client.create(widgetInput({ serialNumber: "SN-R" }), asCaller("u1"));
    await expectCode(
      client.create(widgetInput({ serialNumber: "SN-R" }), asCaller("u1")),
      Code.AlreadyExists,
      /Widget with serial number 'SN-R' already exists$/,
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
    const updated = await client.update(edit, asCaller("editor", "operator"));

    expect(updated.metadata?.id).toBe(created.metadata?.id);
    expect(updated.metadata?.version).toBe(2n);
    expect(updated.metadata?.createdBy?.id).toBe("author");
    expect(updated.metadata?.createdBy?.kind).toBe("user");
    expect(updated.metadata?.updatedBy?.id).toBe("editor");
    expect(updated.metadata?.updatedBy?.kind).toBe("operator");
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

  it("shows the policy the stored resource AND the proposal, so a spec change can be refused", async () => {
    // An owner transfer is visible to neither the fact nor the proposal
    // alone; the update slot carries both, apart, so the policy compares.
    const { client } = makeClient({
      policy: {
        authorize: ({ operation, resource, input }) => {
          if (operation !== "update") return ALLOW;
          const before = (resource as Widget | undefined)?.spec?.ownerId;
          const after = (input as Widget | undefined)?.spec?.ownerId;
          return before === after ? ALLOW : deny("Widgets cannot change owner");
        },
      },
    });
    const created = await client.create(widgetInput({ ownerId: "u1" }), asCaller("u1"));
    const transfer = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-1", name: "moved", ownerId: "u2" },
    } as never);
    await expectCode(client.update(transfer, asCaller("u1")), Code.PermissionDenied, /cannot change owner/);
    const rename = create(WidgetSchema, {
      metadata: { id: created.metadata?.id ?? "" },
      spec: { serialNumber: "SN-1", name: "renamed", ownerId: "u1" },
    } as never);
    expect((await client.update(rename, asCaller("u1"))).spec?.name).toBe("renamed");
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
    const retired = await client.retire({ id: created.metadata?.id ?? "" }, asCaller("closer", "system"));

    expect(retired.status?.retired).toBe(true);
    expect(retired.metadata?.version).toBe(2n);
    expect(retired.metadata?.createdBy?.id).toBe("owner");
    expect(retired.metadata?.updatedBy?.id).toBe("closer");
    expect(retired.metadata?.updatedBy?.kind).toBe("system");

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
