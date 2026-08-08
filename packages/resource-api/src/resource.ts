/**
 * The typed operation declaration — this edition's deliberate improvement
 * over both parents. Java declares operations via an annotation registry
 * (missing handler ⇒ UNIMPLEMENTED at runtime); Go embeds Unimplemented
 * stubs. Here the operation set is a single visible declaration per
 * resource, checked by the compiler against the service's method names,
 * and an operation absent from the declaration answers UNIMPLEMENTED by
 * construction — connect-es supplies the fallback for every method missing
 * from a partial `ServiceImpl`.
 *
 * Per-operation chains are ports of the Java edition's canonical
 * pipelines, including their deliberate ordering:
 *
 *   create: validate → authorize → duplicate-check → build state →
 *           [beforePersist…] → persist → publish
 *           (authorize precedes duplicate-check so an unauthorized caller
 *           cannot probe for existence via ALREADY_EXISTS)
 *   update: validate → load existing → authorize → duplicate-check(natural
 *           key changed) → build state → [beforePersist…] → persist → publish
 *   get:    validate → load target → authorize
 *           (load precedes authorize: missing ⇒ NOT_FOUND, not
 *           PERMISSION_DENIED — stigmer/stigmer#224; enforced by the
 *           pipeline ordering invariant)
 *   list:   validate → authorize (scope-level) → query
 *   custom: validate → handler, with authorization enforced fail-closed:
 *           a custom operation that completes without an authorization
 *           check is an INTERNAL error, never a silent allow.
 *
 * Typing stance (recorded guardrail): operation KEYS are compile-time
 * checked against the service; request/response types are enforced where
 * apps write code (the factory lambdas) plus a runtime schema assertion at
 * definition time for create/update. Full type-level unification of
 * bindings with method descriptors was tried and rejected — the compiler
 * errors it produces are unreadable, and unreadable errors are technical
 * debt wearing a nice hat.
 */

import type { DescMessage, DescMethod, DescService, MessageInitShape } from "@bufbuild/protobuf";
import { create } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { ConnectRouter, HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  buildCreateState,
  buildUpdateState,
  stampCustomMutation,
  type EnvelopeIdentity,
} from "./audit.js";
import type { ResourceMessage } from "./envelope.js";
import { alreadyExists, internal, invalidArgument, notFound, unauthenticated, permissionDenied } from "./errors.js";
import { Pipeline, type PipelineStep } from "./pipeline.js";
import type { CallerPrincipal } from "./principal.js";
import type { AuthorizationPolicy } from "./policy.js";
import { NOOP_PUBLISHER, type ResourceEventPublisher } from "./publisher.js";
import { DuplicateNaturalKeyError, type ListQuery, type ResourceStore } from "./store/store.js";
import { validateMessage } from "./validate.js";

/** The contract's list defaults: page size 20, hard cap 100. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ResourceDefinition<R extends ResourceMessage> {
  /** Resource kind, e.g. "Case". Used as store key and event kind. */
  readonly kind: string;
  /** Human name for error messages; defaults to `kind`. */
  readonly displayName?: string;
  readonly apiVersion: string;
  /** Id prefix, e.g. "case" → `case_01j…`. */
  readonly idPrefix: string;
  readonly schema: GenMessage<R>;
  /**
   * The user-provided unique key (case number, email, …). `label` appears
   * in error messages; `get` reads the value from a resource message.
   */
  readonly naturalKey?: {
    readonly label: string;
    readonly get: (resource: R) => string;
  };
  readonly store: ResourceStore;
  readonly policy: AuthorizationPolicy;
  readonly publisher?: ResourceEventPublisher;
  /**
   * Extracts the caller from the transport context. This is the app's
   * enforcement seam (JWT middleware, test headers, MCP gate) — the
   * pipeline never parses credentials itself.
   */
  readonly caller: (ctx: HandlerContext) => CallerPrincipal | undefined;
  /**
   * Read-side status derivation (e.g. Case.document_count, Task.overdue):
   * runs on every resource returned from get/list/create/update, after
   * persistence — derived fields are never stored (§R3).
   */
  readonly deriveStatus?: (resource: R) => void | Promise<void>;
}

export interface ResourceRef {
  readonly id?: string;
  readonly naturalKey?: string;
}

/* ------------------------------------------------------------------ */
/* Contexts                                                            */
/* ------------------------------------------------------------------ */

export interface WriteContext<R extends ResourceMessage> {
  readonly caller: CallerPrincipal | undefined;
  readonly input: R;
  existing?: R;
  newState?: R;
}

export interface ReadContext<R extends ResourceMessage, I> {
  readonly caller: CallerPrincipal | undefined;
  readonly input: I;
  target?: R;
}

/** Handed to custom operation handlers. */
export interface CustomContext<R extends ResourceMessage, I> {
  readonly caller: CallerPrincipal | undefined;
  readonly input: I;
  /** Loads the resource AND authorizes the operation against it. */
  load(ref: ResourceRef): Promise<R>;
  /** Authorization for custom operations that target no single resource. */
  authorize(): Promise<void>;
  /**
   * Persists a mutated resource with update audit semantics (version+1,
   * updated_by/at) — the stored-status mutation path (e.g. updateStatus).
   */
  save(resource: R): Promise<R>;
  publish(type: "created" | "updated", resource: R, previous?: R): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Operation bindings                                                  */
/* ------------------------------------------------------------------ */

type UnaryHandler = (req: never, ctx: HandlerContext) => Promise<unknown>;

export interface OperationBinding<R extends ResourceMessage> {
  readonly flavor: "create" | "update" | "get" | "list" | "custom";
  /** @internal assembled by defineResource */
  bind(runtime: Runtime<R>, method: DescMethod, operationName: string): UnaryHandler;
}

interface Runtime<R extends ResourceMessage> {
  readonly def: ResourceDefinition<R>;
  readonly displayName: string;
  readonly identity: EnvelopeIdentity;
  readonly publisher: ResourceEventPublisher;
}

/* -------------------- shared step builders ------------------------ */

function validateInputStep<C extends { input: unknown }>(
  schema: DescMessage,
  subject: string,
): PipelineStep<C> {
  return {
    name: "validate-input",
    execute(ctx) {
      validateMessage(schema, ctx.input, subject);
    },
  };
}

function authorizeStep<C extends { caller: CallerPrincipal | undefined }, R extends ResourceMessage>(
  runtime: Runtime<R>,
  operation: string,
  resourceOf: (ctx: C) => R | undefined,
): PipelineStep<C> {
  return {
    name: "authorize",
    traits: ["authorization"],
    async execute(ctx) {
      await authorizeOrThrow(runtime, operation, ctx.caller, resourceOf(ctx));
    },
  };
}

async function authorizeOrThrow<R extends ResourceMessage>(
  runtime: Runtime<R>,
  operation: string,
  caller: CallerPrincipal | undefined,
  resource: R | undefined,
): Promise<void> {
  if (!caller) {
    throw unauthenticated();
  }
  const decision = await runtime.def.policy.authorize({
    caller,
    kind: runtime.def.kind,
    operation,
    resource,
  });
  if (!decision.allow) {
    throw permissionDenied(decision.reason);
  }
}

async function loadByRef<R extends ResourceMessage>(
  runtime: Runtime<R>,
  ref: ResourceRef,
): Promise<R | undefined> {
  const { def } = runtime;
  // Id wins when both are present (the parents' load order: id, then
  // natural-key fallback).
  if (ref.id) {
    return (await def.store.getById(def.kind, ref.id)) as R | undefined;
  }
  if (ref.naturalKey) {
    return (await def.store.getByNaturalKey(def.kind, ref.naturalKey)) as R | undefined;
  }
  return undefined;
}

function refDescription<R extends ResourceMessage>(runtime: Runtime<R>, ref: ResourceRef): string {
  return ref.id ?? ref.naturalKey ?? "(no reference)";
}

function requireRef<R extends ResourceMessage>(runtime: Runtime<R>, ref: ResourceRef): void {
  if (!ref.id && !ref.naturalKey) {
    const key = runtime.def.naturalKey
      ? `id or ${runtime.def.naturalKey.label}`
      : "id";
    throw invalidArgument(`${runtime.displayName}: ${key} is required`);
  }
}

async function persist<R extends ResourceMessage>(runtime: Runtime<R>, resource: R): Promise<void> {
  const { def } = runtime;
  try {
    await def.store.save(def.kind, resource);
  } catch (err) {
    // The database uniqueness constraint is the backstop for the
    // duplicate-check race window (two concurrent creates) — the Java
    // persist step's DuplicateKeyException handling, mapped to the same
    // client-facing answer as the friendly pre-check.
    if (err instanceof DuplicateNaturalKeyError && def.naturalKey) {
      throw alreadyExists(runtime.displayName, def.naturalKey.label, err.value);
    }
    throw err;
  }
}

/**
 * Best-effort by design (recorded divergence from the Java parent): the
 * write already stands; a publish failure must not turn a succeeded
 * request into a client-visible error. See publisher.ts.
 */
async function publishSafely<R extends ResourceMessage>(
  runtime: Runtime<R>,
  type: "created" | "updated",
  resource: R,
  previous: R | undefined,
  actor: CallerPrincipal,
): Promise<void> {
  try {
    await runtime.publisher.publish({
      kind: runtime.def.kind,
      type,
      resource,
      previous,
      actor,
    });
  } catch (err) {
    console.error(
      `event publish failed (kind=${runtime.def.kind}, type=${type}, ` +
        `id=${resource.metadata?.id}); request succeeds, event is lost:`,
      err,
    );
  }
}

async function derive<R extends ResourceMessage>(runtime: Runtime<R>, resource: R): Promise<R> {
  await runtime.def.deriveStatus?.(resource);
  return resource;
}

/* -------------------------- create -------------------------------- */

export interface CreateOperationOptions<R extends ResourceMessage> {
  /**
   * Domain steps between build-state and persist (reference/guard checks —
   * the extension point the Go consumers use most). ctx.newState is set.
   */
  readonly beforePersist?: readonly PipelineStep<WriteContext<R>>[];
}

export function createOperation<R extends ResourceMessage>(
  options: CreateOperationOptions<R> = {},
): OperationBinding<R> {
  return {
    flavor: "create",
    bind(runtime, method, operationName) {
      const { def } = runtime;
      const pipeline = new Pipeline<WriteContext<R>>(`${def.kind}-${operationName}`, [
        validateInputStep(method.input, runtime.displayName),
        authorizeStep(runtime, operationName, () => undefined),
        {
          name: "check-duplicate",
          async execute(ctx) {
            if (!def.naturalKey) return;
            const value = def.naturalKey.get(ctx.input);
            if (value && (await def.store.getByNaturalKey(def.kind, value))) {
              throw alreadyExists(runtime.displayName, def.naturalKey.label, value);
            }
          },
        },
        {
          name: "build-new-state",
          execute(ctx) {
            ctx.newState = buildCreateState(
              def.schema,
              runtime.identity,
              ctx.input,
              // authorize guaranteed a caller above.
              ctx.caller as CallerPrincipal,
              new Date(),
            );
          },
        },
        ...(options.beforePersist ?? []),
        {
          name: "persist",
          async execute(ctx) {
            await persist(runtime, ctx.newState as R);
          },
        },
        {
          name: "publish",
          async execute(ctx) {
            await publishSafely(
              runtime,
              "created",
              ctx.newState as R,
              undefined,
              ctx.caller as CallerPrincipal,
            );
          },
        },
      ]);

      return async (req, hctx) => {
        const ctx: WriteContext<R> = { caller: def.caller(hctx), input: req as R };
        await pipeline.execute(ctx);
        return derive(runtime, ctx.newState as R);
      };
    },
  };
}

/* -------------------------- update -------------------------------- */

export interface UpdateOperationOptions<R extends ResourceMessage> {
  readonly beforePersist?: readonly PipelineStep<WriteContext<R>>[];
}

export function updateOperation<R extends ResourceMessage>(
  options: UpdateOperationOptions<R> = {},
): OperationBinding<R> {
  return {
    flavor: "update",
    bind(runtime, method, operationName) {
      const { def } = runtime;
      const pipeline = new Pipeline<WriteContext<R>>(`${def.kind}-${operationName}`, [
        validateInputStep(method.input, runtime.displayName),
        {
          name: "load-existing",
          traits: ["existence-check"],
          async execute(ctx) {
            const ref: ResourceRef = {
              id: ctx.input.metadata?.id || undefined,
              naturalKey: def.naturalKey?.get(ctx.input) || undefined,
            };
            requireRef(runtime, ref);
            const existing = await loadByRef(runtime, ref);
            if (!existing) {
              throw notFound(runtime.displayName, refDescription(runtime, ref));
            }
            ctx.existing = existing;
          },
        },
        authorizeStep(runtime, operationName, (ctx) => ctx.existing),
        {
          name: "check-duplicate",
          async execute(ctx) {
            // Unlike the parents (immutable slugs), products here allow
            // natural-key edits (e.g. correcting a mistyped case number —
            // FR-CASE-004), so uniqueness re-validates when it changes.
            if (!def.naturalKey) return;
            const next = def.naturalKey.get(ctx.input);
            const current = def.naturalKey.get(ctx.existing as R);
            if (!next || next === current) return;
            const clash = await def.store.getByNaturalKey(def.kind, next);
            if (clash && clash.metadata?.id !== ctx.existing?.metadata?.id) {
              throw alreadyExists(runtime.displayName, def.naturalKey.label, next);
            }
          },
        },
        {
          name: "build-new-state",
          execute(ctx) {
            ctx.newState = buildUpdateState(
              def.schema,
              runtime.identity,
              ctx.input,
              ctx.existing as R,
              ctx.caller as CallerPrincipal,
              new Date(),
            );
          },
        },
        ...(options.beforePersist ?? []),
        {
          name: "persist",
          async execute(ctx) {
            await persist(runtime, ctx.newState as R);
          },
        },
        {
          name: "publish",
          async execute(ctx) {
            await publishSafely(
              runtime,
              "updated",
              ctx.newState as R,
              ctx.existing,
              ctx.caller as CallerPrincipal,
            );
          },
        },
      ]);

      return async (req, hctx) => {
        const ctx: WriteContext<R> = { caller: def.caller(hctx), input: req as R };
        await pipeline.execute(ctx);
        return derive(runtime, ctx.newState as R);
      };
    },
  };
}

/* ---------------------------- get ---------------------------------- */

export interface GetOperationOptions<R extends ResourceMessage, I> {
  /** Maps the request to a reference (id and/or natural key). */
  readonly ref: (request: I) => ResourceRef;
}

export function getOperation<R extends ResourceMessage, I>(
  options: GetOperationOptions<R, I>,
): OperationBinding<R> {
  return {
    flavor: "get",
    bind(runtime, method, operationName) {
      const { def } = runtime;
      const pipeline = new Pipeline<ReadContext<R, I>>(`${def.kind}-${operationName}`, [
        validateInputStep(method.input, runtime.displayName),
        {
          name: "load-target",
          traits: ["existence-check"],
          async execute(ctx) {
            const ref = options.ref(ctx.input);
            requireRef(runtime, ref);
            const target = await loadByRef(runtime, ref);
            if (!target) {
              throw notFound(runtime.displayName, refDescription(runtime, ref));
            }
            ctx.target = target;
          },
        },
        authorizeStep(runtime, operationName, (ctx) => ctx.target),
      ]);

      return async (req, hctx) => {
        const ctx: ReadContext<R, I> = { caller: def.caller(hctx), input: req as I };
        await pipeline.execute(ctx);
        return derive(runtime, ctx.target as R);
      };
    },
  };
}

/* ---------------------------- list --------------------------------- */

export interface ListOperationOptions<R extends ResourceMessage, I, O> {
  /**
   * Fixed ordering for this resource (part of its list contract, e.g.
   * cases by next_hearing_date ascending, dateless last).
   */
  readonly orderBy?: ListQuery["orderBy"];
  /** Maps the request to paging and equality filters. */
  readonly query: (request: I) => {
    readonly pageSize?: number;
    readonly pageOffset?: number;
    readonly filter?: Readonly<Record<string, string>>;
  };
  /** Builds the response message from the page. */
  readonly respond: (items: R[], totalCount: number) => O;
}

export function listOperation<R extends ResourceMessage, I, O>(
  options: ListOperationOptions<R, I, O>,
): OperationBinding<R> {
  return {
    flavor: "list",
    bind(runtime, method, operationName) {
      const { def } = runtime;
      // Authorization is scope-level and runs first (the Java find
      // pipeline): there is no single resource to load.
      const pipeline = new Pipeline<ReadContext<R, I>>(`${def.kind}-${operationName}`, [
        validateInputStep(method.input, runtime.displayName),
        authorizeStep(runtime, operationName, () => undefined),
      ]);

      return async (req, hctx) => {
        const ctx: ReadContext<R, I> = { caller: def.caller(hctx), input: req as I };
        await pipeline.execute(ctx);

        const q = options.query(ctx.input);
        const limit = Math.min(q.pageSize && q.pageSize > 0 ? q.pageSize : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const offset = q.pageOffset && q.pageOffset > 0 ? q.pageOffset : 0;
        const { items, totalCount } = await def.store.list(def.kind, {
          limit,
          offset,
          orderBy: options.orderBy,
          filter: q.filter,
        });
        const derived: R[] = [];
        for (const item of items) {
          derived.push(await derive(runtime, item as R));
        }
        return options.respond(derived, totalCount);
      };
    },
  };
}

/* --------------------------- custom -------------------------------- */

export interface CustomOperationOptions<R extends ResourceMessage, I, O> {
  readonly handler: (ctx: CustomContext<R, I>) => Promise<O>;
}

export function customOperation<R extends ResourceMessage, I, O>(
  options: CustomOperationOptions<R, I, O>,
): OperationBinding<R> {
  return {
    flavor: "custom",
    bind(runtime, method, operationName) {
      const { def } = runtime;
      return async (req, hctx) => {
        const caller = def.caller(hctx);
        validateMessage(method.input, req, `${runtime.displayName} ${operationName}`);

        // Fail-closed authorization: the handler MUST authorize (via
        // load() or authorize()) before this call returns. Forgetting is
        // an INTERNAL error caught by the operation's first test — never
        // a silently unprotected endpoint. Deny-by-default, mechanically.
        let authorized = false;

        const ctx: CustomContext<R, I> = {
          caller,
          input: req as I,
          async load(ref) {
            requireRef(runtime, ref);
            const resource = await loadByRef(runtime, ref);
            if (!resource) {
              throw notFound(runtime.displayName, refDescription(runtime, ref));
            }
            await authorizeOrThrow(runtime, operationName, caller, resource);
            authorized = true;
            return resource;
          },
          async authorize() {
            await authorizeOrThrow(runtime, operationName, caller, undefined);
            authorized = true;
          },
          async save(resource) {
            const stamped = stampCustomMutation(
              runtime.identity,
              resource,
              caller as CallerPrincipal,
              new Date(),
            );
            await persist(runtime, stamped);
            return stamped;
          },
          async publish(type, resource, previous) {
            await publishSafely(runtime, type, resource, previous, caller as CallerPrincipal);
          },
        };

        const response = await options.handler(ctx);
        if (!authorized) {
          throw internal(
            `${runtime.displayName} ${operationName}: handler completed without an ` +
              `authorization check (call ctx.load() or ctx.authorize())`,
          );
        }
        return response;
      };
    },
  };
}

/* ------------------------ defineResource --------------------------- */

type ServiceMethodNames<S extends DescService> = S extends { method: infer M }
  ? Extract<keyof M, string>
  : string;

export interface DefinedResource<S extends DescService> {
  readonly service: S;
  readonly impl: Partial<ServiceImpl<S>>;
  /** Registers the service on a ConnectRouter. */
  routes(router: ConnectRouter): void;
}

export function defineResource<R extends ResourceMessage, S extends DescService>(opts: {
  definition: ResourceDefinition<R>;
  service: S;
  operations: { readonly [K in ServiceMethodNames<S>]?: OperationBinding<R> };
}): DefinedResource<S> {
  const { definition, service, operations } = opts;
  const runtime: Runtime<R> = {
    def: definition,
    displayName: definition.displayName ?? definition.kind,
    identity: {
      apiVersion: definition.apiVersion,
      kind: definition.kind,
      idPrefix: definition.idPrefix,
    },
    publisher: definition.publisher ?? NOOP_PUBLISHER,
  };

  const methodsByLocalName = new Map(service.methods.map((m) => [m.localName, m]));
  const impl: Record<string, UnaryHandler> = {};

  for (const [name, binding] of Object.entries(operations) as [string, OperationBinding<R>][]) {
    if (!binding) continue;
    const method = methodsByLocalName.get(name);
    if (!method) {
      throw new Error(
        `${definition.kind}: operation '${name}' does not exist on service ` +
          `${service.typeName}. Declared methods: ${service.methods.map((m) => m.localName).join(", ")}`,
      );
    }
    if (method.methodKind !== "unary") {
      throw new Error(
        `${definition.kind}: operation '${name}' is ${method.methodKind}; only unary is supported`,
      );
    }
    // Runtime half of the typing stance: create/update must speak the
    // resource message itself (the resource-API convention).
    if (
      (binding.flavor === "create" || binding.flavor === "update") &&
      (method.input.typeName !== definition.schema.typeName ||
        method.output.typeName !== definition.schema.typeName)
    ) {
      throw new Error(
        `${definition.kind}: '${name}' must take and return ${definition.schema.typeName} ` +
          `(got ${method.input.typeName} -> ${method.output.typeName})`,
      );
    }
    impl[name] = binding.bind(runtime, method, name);
  }

  return {
    service,
    impl: impl as Partial<ServiceImpl<S>>,
    routes(router) {
      // Partial implementation is the declared-absence mechanism:
      // connect-es answers every unbound method with UNIMPLEMENTED.
      router.service(service, impl as Partial<ServiceImpl<S>>);
    },
  };
}

/** Convenience for message construction in respond() lambdas. */
export function buildMessage<Desc extends DescMessage>(
  schema: Desc,
  init: MessageInitShape<Desc>,
) {
  return create(schema, init);
}
