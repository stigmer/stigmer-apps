/**
 * The T03 seams: the in-process invoker + systemOperations (D1), the
 * caller-aware list query (D2), the reference-exists step (D3), and
 * page-shaped status derivation (D4). Same fixture discipline as every
 * commons test: Widget, never a product resource.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  type GetWidgetRequest,
  GetWidgetRequestSchema,
  type ListWidgetsRequest,
  ListWidgetsRequestSchema,
  type ListWidgetsResponse,
  ListWidgetsResponseSchema,
  RetireWidgetRequestSchema,
  type Widget,
  WidgetSchema,
  WidgetService,
} from "../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { ALLOW, allowAnyAuthenticated, deny, type AuthorizationPolicy } from "../policy.js";
import { SYSTEM_PRINCIPAL } from "../principal.js";
import { InProcessEventDispatcher, type ResourceEvent } from "../publisher.js";
import { referencesExistStep } from "../references.js";
import {
  createOperation,
  defineResource,
  getOperation,
  listOperation,
  type ResourceDefinition,
} from "../resource.js";
import type { ResourceStore } from "../store/store.js";
import { asCaller, callerFromTestHeaders, widgetMemoryStore, widgetResource } from "./widget-fixture.js";

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

function widgetInput(overrides: Partial<{ serialNumber: string; name: string; ownerId: string }> = {}) {
  return create(WidgetSchema, {
    spec: {
      serialNumber: overrides.serialNumber ?? "SN-1",
      name: overrides.name ?? "test widget",
      ownerId: overrides.ownerId ?? "",
    },
  });
}

function definition(options: {
  store: ResourceStore;
  policy?: AuthorizationPolicy;
  publisher?: InProcessEventDispatcher;
  deriveStatus?: ResourceDefinition<Widget>["deriveStatus"];
}): ResourceDefinition<Widget> {
  return {
    kind: "Widget",
    apiVersion: "testing.stigmer.ai/v1",
    idPrefix: "wdg",
    schema: WidgetSchema,
    naturalKey: { label: "serial number", get: (w) => w.spec?.serialNumber ?? "" },
    store: options.store,
    policy: options.policy ?? allowAnyAuthenticated(),
    publisher: options.publisher,
    caller: callerFromTestHeaders,
    deriveStatus: options.deriveStatus,
  };
}

describe("systemOperations + invoke (D1)", () => {
  /** Widget as a system-written resource: no Create on the wire at all. */
  function systemWrittenWidget(options: {
    store: ResourceStore;
    policy?: AuthorizationPolicy;
    publisher?: InProcessEventDispatcher;
  }) {
    return defineResource({
      definition: definition(options),
      service: WidgetService,
      operations: {
        get: getOperation<Widget, GetWidgetRequest>({
          ref: (req) => ({ id: req.id || undefined, naturalKey: req.serialNumber || undefined }),
        }),
      },
      systemOperations: { create: {} },
    });
  }

  it("a system-operation create is UNIMPLEMENTED on the wire but runs the full pipeline in-process", async () => {
    const store = widgetMemoryStore();
    const events: ResourceEvent[] = [];
    const publisher = new InProcessEventDispatcher();
    publisher.subscribe("Widget", (e) => {
      events.push(e);
    });
    const resource = systemWrittenWidget({ store, publisher });
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    // The wire has no create: declared-absence answers UNIMPLEMENTED.
    await expectCode(client.create(widgetInput(), asCaller("u1")), Code.Unimplemented);

    // In-process, the same chain runs end to end: envelope stamped,
    // persisted, event published, audit attributed to the system actor.
    const created = await resource.invoke.create!(widgetInput(), SYSTEM_PRINCIPAL);
    expect(created.metadata?.id).toMatch(/^wdg_[0-9a-z]{26}$/);
    expect(created.metadata?.createdBy?.id).toBe("system");
    expect(await store.getById("Widget", created.metadata?.id ?? "")).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("created");

    // And it is reachable over the wire through the operations that ARE
    // declared — one pipeline, two transports.
    const fetched = await client.get({ id: created.metadata?.id ?? "" }, asCaller("u1"));
    expect(fetched.spec?.serialNumber).toBe("SN-1");
  });

  it("validation holds on the in-process path (no transport interceptor to rely on)", async () => {
    const resource = systemWrittenWidget({ store: widgetMemoryStore() });
    await expectCode(
      resource.invoke.create!(create(WidgetSchema, { spec: { serialNumber: "", name: "x" } }), SYSTEM_PRINCIPAL),
      Code.InvalidArgument,
      /serial_number/,
    );
  });

  it("the authorize slot runs in-process: policy can reject non-system principals", async () => {
    const systemOnly: AuthorizationPolicy = {
      authorize: ({ caller }) =>
        caller?.kind === "system" ? ALLOW : deny("Widgets are system-written"),
    };
    const resource = systemWrittenWidget({ store: widgetMemoryStore(), policy: systemOnly });

    await expectCode(
      resource.invoke.create!(widgetInput(), { id: "user-1", kind: "user" }),
      Code.PermissionDenied,
      /system-written/,
    );
    await resource.invoke.create!(widgetInput({ serialNumber: "SN-OK" }), SYSTEM_PRINCIPAL);
  });

  it("the duplicate contract holds in-process: ALREADY_EXISTS names the value", async () => {
    const resource = systemWrittenWidget({ store: widgetMemoryStore() });
    await resource.invoke.create!(widgetInput({ serialNumber: "SN-DUP" }), SYSTEM_PRINCIPAL);
    await expectCode(
      resource.invoke.create!(widgetInput({ serialNumber: "SN-DUP" }), SYSTEM_PRINCIPAL),
      Code.AlreadyExists,
      /SN-DUP/,
    );
  });

  it("a wire-bound create populates invoke too — one pipeline, shared", async () => {
    const resource = widgetResource({ store: widgetMemoryStore() });
    expect(resource.invoke.create).toBeDefined();
    expect(resource.invoke.update).toBeDefined();
    const created = await resource.invoke.create!(widgetInput(), { id: "u1", kind: "user" });
    expect(created.metadata?.createdBy?.id).toBe("u1");
  });

  it("declaring an operation as both service and system is a construction error", () => {
    expect(() =>
      defineResource({
        definition: definition({ store: widgetMemoryStore() }),
        service: WidgetService,
        operations: { create: createOperation<Widget>() },
        systemOperations: { create: {} },
      }),
    ).toThrowError(/declared both/);
  });
});

describe("caller-aware list query (D2)", () => {
  it("supports caller-scoped defaults — the 'My Tasks' seam", async () => {
    const store = widgetMemoryStore();
    const resource = defineResource({
      definition: definition({ store }),
      service: WidgetService,
      operations: {
        create: createOperation<Widget>(),
        list: listOperation<Widget, ListWidgetsRequest, unknown>({
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          // The caller-scoped default: no explicit filter means "mine".
          query: (req, caller) => ({
            pageSize: req.pageSize,
            pageOffset: req.pageOffset,
            filter: { ownerId: req.ownerId || caller.id },
          }),
          respond: (items, totalCount) =>
            create(ListWidgetsResponseSchema, { items, totalCount: BigInt(totalCount) }),
        }),
      },
    });
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    await client.create(widgetInput({ serialNumber: "SN-A", ownerId: "alice" }), asCaller("alice"));
    await client.create(widgetInput({ serialNumber: "SN-B", ownerId: "bob" }), asCaller("bob"));

    const mine = await client.list({}, asCaller("alice"));
    expect(mine.items.map((w) => w.spec?.serialNumber)).toEqual(["SN-A"]);
    expect(mine.totalCount).toBe(1n);

    // An explicit filter still overrides the default.
    const bobs = await client.list({ ownerId: "bob" }, asCaller("alice"));
    expect(bobs.items.map((w) => w.spec?.serialNumber)).toEqual(["SN-B"]);
  });
});

describe("reference-exists step (D3)", () => {
  /** ownerId modeled as a reference to another Widget (self-referential kind). */
  function referencingWidget(store: ResourceStore) {
    return defineResource({
      definition: definition({ store }),
      service: WidgetService,
      operations: {
        create: createOperation<Widget>({
          beforePersist: [
            referencesExistStep(store, [
              { kind: "Widget", label: "owner widget", get: (w) => w.spec?.ownerId || undefined },
            ]),
          ],
        }),
      },
    });
  }

  it("answers FAILED_PRECONDITION naming the missing reference (the Go parent's contract)", async () => {
    const store = widgetMemoryStore();
    const resource = referencingWidget(store);
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    await expectCode(
      client.create(widgetInput({ ownerId: "wdg_ghost" }), asCaller("u1")),
      Code.FailedPrecondition,
      /owner widget 'wdg_ghost' not found/,
    );
    // Nothing persisted: the step runs before persist.
    expect((await store.list("Widget", { limit: 10, offset: 0 })).totalCount).toBe(0);
  });

  it("passes when the reference exists and skips when the optional reference is unset", async () => {
    const store = widgetMemoryStore();
    const resource = referencingWidget(store);
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    // Unset reference: skipped (optional references validate only when set).
    const owner = await client.create(widgetInput({ serialNumber: "SN-OWNER" }), asCaller("u1"));
    // Set and existing: passes.
    const owned = await client.create(
      widgetInput({ serialNumber: "SN-OWNED", ownerId: owner.metadata?.id ?? "" }),
      asCaller("u1"),
    );
    expect(owned.spec?.ownerId).toBe(owner.metadata?.id);
  });
});

describe("the completed invoke surface (T05): get, list, custom", () => {
  it("invoke.get runs load → authorize → derive, exactly like the wire", async () => {
    const store = widgetMemoryStore();
    const resource = widgetResource({ store });
    const created = await resource.invoke.create!(
      widgetInput({ serialNumber: "SN-G", name: "gadget" }),
      { id: "u1", kind: "user" },
    );

    const fetched = await resource.invoke.get(
      create(GetWidgetRequestSchema, { id: created.metadata?.id ?? "" }),
      { id: "u1", kind: "user" },
    );
    expect(fetched.spec?.serialNumber).toBe("SN-G");
    // Derivation ran (nameLength is derived-on-read, never stored).
    expect(fetched.status?.nameLength).toBe(6);

    await expectCode(
      resource.invoke.get(create(GetWidgetRequestSchema, { id: "wdg_ghost" }), { id: "u1", kind: "user" }),
      Code.NotFound,
    );
  });

  it("invoke.list applies the caller-scoped query with the EXPLICIT principal", async () => {
    const store = widgetMemoryStore();
    const resource = defineResource({
      definition: definition({ store }),
      service: WidgetService,
      operations: {
        create: createOperation<Widget>(),
        list: listOperation<Widget, ListWidgetsRequest, ListWidgetsResponse>({
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          query: (req, caller) => ({
            pageSize: req.pageSize,
            filter: { ownerId: req.ownerId || caller.id },
          }),
          respond: (items, totalCount) =>
            create(ListWidgetsResponseSchema, { items, totalCount: BigInt(totalCount) }),
        }),
      },
    });
    await resource.invoke.create(widgetInput({ serialNumber: "SN-A", ownerId: "alice" }), { id: "alice", kind: "user" });
    await resource.invoke.create(widgetInput({ serialNumber: "SN-B", ownerId: "bob" }), { id: "bob", kind: "user" });

    // "Mine" resolves from the passed principal — the exact property the
    // MCP gate's argument-free my_open_tasks stands on.
    const mine = await resource.invoke.list(create(ListWidgetsRequestSchema, {}), { id: "alice", kind: "user" });
    expect(mine.items.map((w) => w.spec?.serialNumber)).toEqual(["SN-A"]);
    expect(mine.totalCount).toBe(1n);
  });

  it("invoke of a named custom operation keeps the fail-closed authorization and audit stamping", async () => {
    const store = widgetMemoryStore();
    const resource = widgetResource({ store });
    const created = await resource.invoke.create!(widgetInput({ serialNumber: "SN-R" }), { id: "u1", kind: "user" });

    const retired = await resource.invoke.retire(
      create(RetireWidgetRequestSchema, { id: created.metadata?.id ?? "" }),
      { id: "u2", kind: "user" },
    );
    expect(retired.status?.retired).toBe(true);
    // Mutation audit is attributed to the passed principal, not a shim.
    expect(retired.metadata?.updatedBy?.id).toBe("u2");
    expect(retired.metadata?.version).toBe(2n);

    // Policy denial still lands as PERMISSION_DENIED in-process.
    const denyAll: AuthorizationPolicy = { authorize: () => deny("nobody may retire") };
    const guarded = widgetResource({ store: widgetMemoryStore(), policy: denyAll });
    const w = create(WidgetSchema, { spec: { serialNumber: "SN-X", name: "x" } });
    await expectCode(guarded.invoke.create!(w, { id: "u1", kind: "user" }), Code.PermissionDenied);
  });

  it("validation holds on the in-process read path too", async () => {
    const resource = widgetResource({ store: widgetMemoryStore() });
    // GetWidgetRequest with neither id nor serial number: the ref guard
    // answers INVALID_ARGUMENT, same as the wire.
    await expectCode(
      resource.invoke.get(create(GetWidgetRequestSchema, {}), { id: "u1", kind: "user" }),
      Code.InvalidArgument,
      /id or serial number/,
    );
  });
});

describe("page-shaped deriveStatus (D4)", () => {
  it("is called once per response — one call for a 3-row page, one for a get", async () => {
    const store = widgetMemoryStore();
    const derive = vi.fn((widgets: readonly Widget[]) => {
      for (const w of widgets) {
        if (w.status) w.status.nameLength = w.spec?.name.length ?? 0;
      }
    });
    const resource = defineResource({
      definition: definition({ store, deriveStatus: derive }),
      service: WidgetService,
      operations: {
        create: createOperation<Widget>(),
        get: getOperation<Widget, GetWidgetRequest>({
          ref: (req) => ({ id: req.id || undefined }),
        }),
        list: listOperation<Widget, ListWidgetsRequest, unknown>({
          orderBy: { field: "createdAt", direction: "asc", nulls: "last" },
          query: (req) => ({ pageSize: req.pageSize, pageOffset: req.pageOffset }),
          respond: (items, totalCount) =>
            create(ListWidgetsResponseSchema, { items, totalCount: BigInt(totalCount) }),
        }),
      },
    });
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    const ids: string[] = [];
    for (const sn of ["SN-1", "SN-2", "SN-3"]) {
      const w = await client.create(widgetInput({ serialNumber: sn }), asCaller("u1"));
      ids.push(w.metadata?.id ?? "");
    }
    derive.mockClear();

    const page = await client.list({}, asCaller("u1"));
    expect(page.items).toHaveLength(3);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0]?.[0]).toHaveLength(3);

    derive.mockClear();
    await client.get({ id: ids[0] ?? "" }, asCaller("u1"));
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0]?.[0]).toHaveLength(1);
  });
});
