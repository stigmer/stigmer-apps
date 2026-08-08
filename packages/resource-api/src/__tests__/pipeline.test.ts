import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { WidgetService } from "../gen/stigmer/resourceapi/testing/v1/widget_pb.js";
import { invalidArgument } from "../errors.js";
import { Pipeline, type PipelineStep } from "../pipeline.js";
import { customOperation, defineResource } from "../resource.js";
import { asCaller, callerFromTestHeaders, widgetMemoryStore, widgetResource } from "./widget-fixture.js";
import { allowAnyAuthenticated } from "../policy.js";
import { WidgetSchema, type Widget } from "../gen/stigmer/resourceapi/testing/v1/widget_pb.js";

interface Ctx {
  log: string[];
}

function step(name: string, opts?: Partial<PipelineStep<Ctx>>): PipelineStep<Ctx> {
  return {
    name,
    traits: opts?.traits,
    execute: opts?.execute ?? ((ctx) => void ctx.log.push(name)),
  };
}

describe("Pipeline", () => {
  it("runs steps in order and halts on the first failure", async () => {
    const ctx: Ctx = { log: [] };
    const pipeline = new Pipeline<Ctx>("test", [
      step("one"),
      step("two", {
        execute: () => {
          throw invalidArgument("nope");
        },
      }),
      step("three"),
    ]);
    await expect(pipeline.execute(ctx)).rejects.toThrowError(/nope/);
    expect(ctx.log).toEqual(["one"]);
  });

  it("passes typed ConnectErrors through with code and message intact", async () => {
    const pipeline = new Pipeline<Ctx>("test", [
      step("boom", {
        execute: () => {
          throw invalidArgument("field X is bad");
        },
      }),
    ]);
    try {
      await pipeline.execute({ log: [] });
      expect.fail("expected error");
    } catch (err) {
      const cerr = ConnectError.from(err);
      expect(cerr.code).toBe(Code.InvalidArgument);
      expect(cerr.message).toContain("field X is bad");
      // No pipeline/step internals leak to the wire message.
      expect(cerr.message).not.toContain("boom");
    }
  });

  it("maps untyped errors to INTERNAL, never UNKNOWN, without leaking details", async () => {
    const pipeline = new Pipeline<Ctx>("widget-create", [
      step("bug", {
        execute: () => {
          throw new Error("secret connection string in a bare error");
        },
      }),
    ]);
    try {
      await pipeline.execute({ log: [] });
      expect.fail("expected error");
    } catch (err) {
      const cerr = ConnectError.from(err);
      expect(cerr.code).toBe(Code.Internal);
      expect(cerr.message).not.toContain("secret");
    }
  });

  it("refuses construction when authorization precedes the existence check", () => {
    expect(
      () =>
        new Pipeline<Ctx>("bad-order", [
          step("authorize", { traits: ["authorization"] }),
          step("load", { traits: ["existence-check"] }),
        ]),
    ).toThrowError(/NOT_FOUND, not PERMISSION_DENIED/);
  });

  it("accepts existence-check before authorization, and chains with only one of them", () => {
    expect(
      () =>
        new Pipeline<Ctx>("good-order", [
          step("load", { traits: ["existence-check"] }),
          step("authorize", { traits: ["authorization"] }),
        ]),
    ).not.toThrow();
    expect(() => new Pipeline<Ctx>("authorize-only", [step("authorize", { traits: ["authorization"] })])).not.toThrow();
    expect(() => new Pipeline<Ctx>("load-only", [step("load", { traits: ["existence-check"] })])).not.toThrow();
  });
});

describe("custom operation fail-closed authorization", () => {
  it("answers INTERNAL when a handler completes without any authorization check", async () => {
    // A deliberately buggy custom operation: does work, never authorizes.
    const resource = defineResource({
      definition: {
        kind: "Widget",
        apiVersion: "testing.stigmer.ai/v1",
        idPrefix: "wdg",
        schema: WidgetSchema,
        store: widgetMemoryStore(),
        policy: allowAnyAuthenticated(),
        caller: callerFromTestHeaders,
      },
      service: WidgetService,
      operations: {
        retire: customOperation<Widget, unknown, unknown>({
          handler: async (ctx) => ctx.input,
        }),
      },
    });
    const client = createClient(WidgetService, createRouterTransport(resource.routes));

    try {
      await client.retire({ id: "wdg_x" }, asCaller("u1"));
      expect.fail("expected error");
    } catch (err) {
      const cerr = ConnectError.from(err);
      expect(cerr.code).toBe(Code.Internal);
      expect(cerr.message).toContain("without an authorization check");
    }
  });
});

describe("defineResource declaration checks", () => {
  it("rejects operations that name no service method, listing the valid names", () => {
    expect(() =>
      defineResource({
        definition: {
          kind: "Widget",
          apiVersion: "testing.stigmer.ai/v1",
          idPrefix: "wdg",
          schema: WidgetSchema,
          store: widgetMemoryStore(),
          policy: allowAnyAuthenticated(),
          caller: callerFromTestHeaders,
        },
        service: WidgetService,
        operations: {
          // Cast simulates a stale declaration after a proto rename — the
          // compile-time check catches this in consumers; the runtime check
          // is the belt to that suspender.
          destroy: customOperation({ handler: async () => ({}) as never }),
        } as never,
      }),
    ).toThrowError(/destroy.*create, update, get, list, retire, archive/s);
  });

  it("exposes routes that answer real requests (sanity)", async () => {
    const resource = widgetResource({ store: widgetMemoryStore() });
    const client = createClient(WidgetService, createRouterTransport(resource.routes));
    const res = await client.list({}, asCaller("u1"));
    expect(res.totalCount).toBe(0n);
  });
});
