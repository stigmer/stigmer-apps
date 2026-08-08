/**
 * The fixture resource definition used by the pipeline test suite — the
 * exact shape a consuming product writes per resource, exercised here so
 * the commons is proven without any product in sight.
 */

import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import {
  type GetWidgetRequest,
  type ListWidgetsRequest,
  ListWidgetsResponseSchema,
  type RetireWidgetRequest,
  type Widget,
  WidgetService,
  WidgetSchema,
  WidgetStatusSchema,
} from "../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { allowAnyAuthenticated, type AuthorizationPolicy } from "../policy.js";
import type { CallerPrincipal } from "../principal.js";
import type { ResourceEventPublisher } from "../publisher.js";
import {
  createOperation,
  customOperation,
  defineResource,
  getOperation,
  listOperation,
  updateOperation,
} from "../resource.js";
import { MemoryResourceStore } from "../store/memory-store.js";
import type { ResourceStore } from "../store/store.js";

/** Test transport identity: caller comes from plain headers. */
export function callerFromTestHeaders(ctx: HandlerContext): CallerPrincipal | undefined {
  const id = ctx.requestHeader.get("x-test-caller");
  if (!id) return undefined;
  const kind = (ctx.requestHeader.get("x-test-caller-kind") ?? "user") as CallerPrincipal["kind"];
  return { id, kind };
}

export function asCaller(id: string, kind?: string) {
  return {
    headers: {
      "x-test-caller": id,
      ...(kind ? { "x-test-caller-kind": kind } : {}),
    },
  };
}

export function widgetMemoryStore(): MemoryResourceStore {
  return new MemoryResourceStore({
    Widget: {
      schema: WidgetSchema,
      naturalKeyField: "serialNumber",
      queryableFields: ["inspectionDate", "ownerId"],
    },
  });
}

export function widgetResource(options: {
  store: ResourceStore;
  policy?: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
}) {
  return defineResource({
    definition: {
      kind: "Widget",
      apiVersion: "testing.stigmer.ai/v1",
      idPrefix: "wdg",
      schema: WidgetSchema,
      naturalKey: {
        label: "serial number",
        get: (w) => w.spec?.serialNumber ?? "",
      },
      store: options.store,
      policy: options.policy ?? allowAnyAuthenticated(),
      publisher: options.publisher,
      caller: callerFromTestHeaders,
      // Derived-on-read status (mirrors Case.document_count): recomputed on
      // every read, never stored; stored fields (retired) are preserved.
      deriveStatus: (w: Widget) => {
        w.status = create(WidgetStatusSchema, {
          retired: w.status?.retired ?? false,
          nameLength: w.spec?.name.length ?? 0,
        });
      },
    },
    service: WidgetService,
    operations: {
      create: createOperation<Widget>(),
      update: updateOperation<Widget>(),
      get: getOperation<Widget, GetWidgetRequest>({
        ref: (req) => ({
          id: req.id || undefined,
          naturalKey: req.serialNumber || undefined,
        }),
      }),
      list: listOperation<Widget, ListWidgetsRequest, unknown>({
        orderBy: { field: "inspectionDate", direction: "asc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
          filter: req.ownerId ? { ownerId: req.ownerId } : undefined,
        }),
        respond: (items, totalCount) =>
          create(ListWidgetsResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      // The custom-operation seam (mirrors Task.updateStatus): load
      // authorizes, save stamps update audit, publish is explicit.
      retire: customOperation<Widget, RetireWidgetRequest, Widget>({
        handler: async (ctx) => {
          const widget = await ctx.load({ id: ctx.input.id });
          widget.status = create(WidgetStatusSchema, {
            retired: true,
            nameLength: widget.status?.nameLength ?? 0,
          });
          const saved = await ctx.save(widget);
          await ctx.publish("updated", saved);
          return saved;
        },
      }),
      // "archive" is deliberately absent: declared on the service, never
      // bound — the tests assert it answers UNIMPLEMENTED by construction.
    },
  });
}
