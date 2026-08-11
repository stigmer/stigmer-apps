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
 * Pipelines are transport-independent (T03 D1, completed for every
 * flavor in T05): each operation's chain is built once and exposed on
 * `DefinedResource.invoke` as a plain async function taking an explicit
 * caller, with the Connect handlers as thin adapters that extract the
 * caller and delegate. That is what lets a system-written resource
 * (e.g. a Notification created by an event handler) run the FULL
 * pipeline — validation included, see validate.ts's documented double
 * arrangement — without a service method existing at all
 * (`systemOperations`), and what lets an in-process surface like the MCP
 * gate serve reads and named custom operations through the same
 * pipelines the wire uses, passing a principal instead of materialising
 * a credential. The Java parent cannot do this: its handlers thread the
 * gRPC StreamObserver into the pipeline context. This edition already
 * rejected that coupling by returning values from pipelines; the invoker
 * completes the separation.
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
import { ConnectError } from "@connectrpc/connect";
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
import {
  DuplicateNaturalKeyError,
  type FilterValue,
  type ListQuery,
  type ResourceStore,
} from "./store/store.js";
import { validateMessage } from "./validate.js";

/** The contract's list defaults: page size 20, hard cap 100. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * The transport-identity seam's shape. May be async: real credential
 * verification does cryptographic work (and, for future authenticators,
 * I/O like a JWKS fetch); the sync form remains valid for tests and
 * shims (T04a).
 */
export type CallerExtractor = (
  ctx: HandlerContext,
) => CallerPrincipal | undefined | Promise<CallerPrincipal | undefined>;

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
   * enforcement seam (JWT verification, test headers, MCP gate) — the
   * pipeline never parses credentials itself.
   */
  readonly caller: CallerExtractor;
  /**
   * Read-side status derivation (e.g. Case.document_count, Task.overdue):
   * runs once per response on the WHOLE page — a one-element array for
   * get/create/update — so a derivation that needs a query issues it once
   * per page, never once per row (T03 D4; pair with `store.countBy`).
   * Derived fields are never stored (§R3).
   */
  readonly deriveStatus?: (resources: readonly R[]) => void | Promise<void>;
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

/**
 * The transport-independent write executor (T03 D1): the full pipeline as
 * a plain async function. An undefined caller still runs the chain — and
 * fails in the authorize step with UNAUTHENTICATED, exactly like the wire.
 */
type WriteExecutor<R extends ResourceMessage> = (
  input: R,
  caller: CallerPrincipal | undefined,
) => Promise<R>;

/**
 * One operation as a transport-free async function — what `invoke`
 * exposes. The public signature demands a caller (in-process code always
 * knows who it is acting as); the internal cores accept `undefined` so
 * the wire adapters can delegate and let the authorize step answer
 * UNAUTHENTICATED, exactly like create/update always have.
 */
export type Invokable<I, O> = (input: I, caller: CallerPrincipal) => Promise<O>;

type InvokableCore<I, O> = (input: I, caller: CallerPrincipal | undefined) => Promise<O>;

/**
 * The I/O type parameters exist so `invoke` can be typed per operation
 * from the factory call sites (where apps already name their request and
 * response types) — NOT unified with the method descriptors, per the
 * recorded typing stance above. They default to `unknown`, so an
 * operation declared without them still compiles and simply yields an
 * untyped invokable.
 */
export interface OperationBinding<R extends ResourceMessage, I = unknown, O = unknown> {
  readonly flavor: "create" | "update" | "get" | "list" | "custom";
  /** @internal pipeline construction for create/update (method-free, D1). */
  buildExecutor?(runtime: Runtime<R>, operationName: string): WriteExecutor<R>;
  /**
   * @internal transport-free core for get/list/custom (T05): the full
   * pipeline as a plain async function, which `defineResource` both
   * exposes on `invoke` and adapts to the wire — the same arrangement
   * create/update have always had. Needs the method descriptor (its
   * input schema drives validation), unlike the write executors, which
   * validate against the resource schema.
   */
  buildInvokable?(
    runtime: Runtime<R>,
    method: DescMethod,
    operationName: string,
  ): InvokableCore<I, O>;
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

/**
 * Runs the consumer's status derivation with the same error discipline as
 * pipeline steps: ConnectErrors pass through; anything untyped is a bug —
 * logged with context, surfaced as INTERNAL, never UNKNOWN. Derivation
 * runs after the pipeline (on its results), so it cannot ride the
 * pipeline's own mapper.
 */
async function deriveAll<R extends ResourceMessage>(
  runtime: Runtime<R>,
  resources: readonly R[],
): Promise<void> {
  if (resources.length === 0 || !runtime.def.deriveStatus) {
    return;
  }
  try {
    await runtime.def.deriveStatus(resources);
  } catch (err) {
    if (err instanceof ConnectError) {
      throw err;
    }
    console.error(`deriveStatus failed (kind=${runtime.def.kind}):`, err);
    throw internal(`Internal error deriving ${runtime.displayName} status`, err);
  }
}

/* -------------------------- create -------------------------------- */

export interface CreateOperationOptions<R extends ResourceMessage> {
  /**
   * Domain steps between build-state and persist (reference/guard checks,
   * normalization, domain defaults — the extension point the Go consumers
   * use most). ctx.newState is set.
   */
  readonly beforePersist?: readonly PipelineStep<WriteContext<R>>[];
  /**
   * Steps between persist and publish — for same-request side effects
   * that must not ride the best-effort event bus (the projected
   * authorization-tuple sync is the motivating consumer). The row is
   * already persisted when these run: a step that throws fails the
   * REQUEST but not the write, so steps whose effect is best-effort by
   * design must contain their own failures and log instead.
   */
  readonly afterPersist?: readonly PipelineStep<WriteContext<R>>[];
}

function buildCreateExecutor<R extends ResourceMessage>(
  runtime: Runtime<R>,
  operationName: string,
  options: CreateOperationOptions<R>,
): WriteExecutor<R> {
  const { def } = runtime;
  // Create speaks the resource message itself (asserted for bound
  // methods in defineResource), so validating against the definition's
  // schema keeps the chain identical with or without a transport.
  const pipeline = new Pipeline<WriteContext<R>>(`${def.kind}-${operationName}`, [
    validateInputStep(def.schema, runtime.displayName),
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
    ...(options.afterPersist ?? []),
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

  return async (input, caller) => {
    const ctx: WriteContext<R> = { caller, input };
    await pipeline.execute(ctx);
    const created = ctx.newState as R;
    await deriveAll(runtime, [created]);
    return created;
  };
}

export function createOperation<R extends ResourceMessage>(
  options: CreateOperationOptions<R> = {},
): OperationBinding<R, R, R> {
  return {
    flavor: "create",
    buildExecutor(runtime, operationName) {
      return buildCreateExecutor(runtime, operationName, options);
    },
  };
}

/* -------------------------- update -------------------------------- */

export interface UpdateOperationOptions<R extends ResourceMessage> {
  readonly beforePersist?: readonly PipelineStep<WriteContext<R>>[];
  /** See CreateOperationOptions.afterPersist — identical contract. */
  readonly afterPersist?: readonly PipelineStep<WriteContext<R>>[];
}

function buildUpdateExecutor<R extends ResourceMessage>(
  runtime: Runtime<R>,
  operationName: string,
  options: UpdateOperationOptions<R>,
): WriteExecutor<R> {
  const { def } = runtime;
  const pipeline = new Pipeline<WriteContext<R>>(`${def.kind}-${operationName}`, [
    validateInputStep(def.schema, runtime.displayName),
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
    ...(options.afterPersist ?? []),
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

  return async (input, caller) => {
    const ctx: WriteContext<R> = { caller, input };
    await pipeline.execute(ctx);
    const updated = ctx.newState as R;
    await deriveAll(runtime, [updated]);
    return updated;
  };
}

export function updateOperation<R extends ResourceMessage>(
  options: UpdateOperationOptions<R> = {},
): OperationBinding<R, R, R> {
  return {
    flavor: "update",
    buildExecutor(runtime, operationName) {
      return buildUpdateExecutor(runtime, operationName, options);
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
): OperationBinding<R, I, R> {
  const buildInvokable = (
    runtime: Runtime<R>,
    method: DescMethod,
    operationName: string,
  ): InvokableCore<I, R> => {
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

    return async (input, caller) => {
      const ctx: ReadContext<R, I> = { caller, input };
      await pipeline.execute(ctx);
      const target = ctx.target as R;
      await deriveAll(runtime, [target]);
      return target;
    };
  };

  return { flavor: "get", buildInvokable };
}

/* ---------------------------- list --------------------------------- */

export interface ListOperationOptions<R extends ResourceMessage, I, O> {
  /**
   * Fixed ordering for this resource — part of its list contract (e.g.
   * cases by next_hearing_date ascending, dateless last), and mandatory:
   * an unordered list paginates nondeterministically (T03 recipe rule).
   */
  readonly orderBy: NonNullable<ListQuery["orderBy"]>;
  /**
   * Maps the request to paging and filters (any FilterValue shape — the
   * named list predicates compose set-membership and ranges here). The
   * caller is the authorized principal (T03 D2) — the seam for
   * caller-scoped defaults like "My Tasks" or a recipient's own
   * notifications.
   */
  readonly query: (
    request: I,
    caller: CallerPrincipal,
  ) => {
    readonly pageSize?: number;
    readonly pageOffset?: number;
    readonly filter?: Readonly<Record<string, FilterValue>>;
  };
  /** Builds the response message from the page. */
  readonly respond: (items: R[], totalCount: number) => O;
}

export function listOperation<R extends ResourceMessage, I, O>(
  options: ListOperationOptions<R, I, O>,
): OperationBinding<R, I, O> {
  const buildInvokable = (
    runtime: Runtime<R>,
    method: DescMethod,
    operationName: string,
  ): InvokableCore<I, O> => {
    const { def } = runtime;
    // Authorization is scope-level and runs first (the Java find
    // pipeline): there is no single resource to load.
    const pipeline = new Pipeline<ReadContext<R, I>>(`${def.kind}-${operationName}`, [
      validateInputStep(method.input, runtime.displayName),
      authorizeStep(runtime, operationName, () => undefined),
    ]);

    return async (input, caller) => {
      const ctx: ReadContext<R, I> = { caller, input };
      await pipeline.execute(ctx);

      // authorize guaranteed a caller above.
      const q = options.query(ctx.input, ctx.caller as CallerPrincipal);
      const limit = Math.min(q.pageSize && q.pageSize > 0 ? q.pageSize : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const offset = q.pageOffset && q.pageOffset > 0 ? q.pageOffset : 0;
      const { items, totalCount } = await def.store.list(def.kind, {
        limit,
        offset,
        orderBy: options.orderBy,
        filter: q.filter,
      });
      // One derivation for the whole page (T03 D4) — a counting
      // derivation costs one query here, not one per row.
      await deriveAll(runtime, items as R[]);
      return options.respond(items as R[], totalCount);
    };
  };

  return { flavor: "list", buildInvokable };
}

/* --------------------------- custom -------------------------------- */

export interface CustomOperationOptions<R extends ResourceMessage, I, O> {
  readonly handler: (ctx: CustomContext<R, I>) => Promise<O>;
}

export function customOperation<R extends ResourceMessage, I, O>(
  options: CustomOperationOptions<R, I, O>,
): OperationBinding<R, I, O> {
  const buildInvokable = (
    runtime: Runtime<R>,
    method: DescMethod,
    operationName: string,
  ): InvokableCore<I, O> => {
    return async (input, caller) => {
      validateMessage(method.input, input, `${runtime.displayName} ${operationName}`);

      // Fail-closed authorization: the handler MUST authorize (via
      // load() or authorize()) before this call returns. Forgetting is
      // an INTERNAL error caught by the operation's first test — never
      // a silently unprotected endpoint. Deny-by-default, mechanically.
      let authorized = false;

      const ctx: CustomContext<R, I> = {
        caller,
        input,
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
  };

  return { flavor: "custom", buildInvokable };
}

/* ------------------------ defineResource --------------------------- */

type ServiceMethodNames<S extends DescService> = S extends { method: infer M }
  ? Extract<keyof M, string>
  : string;

/**
 * The in-process invocation surface (T03 D1, completed T05). Every
 * declared operation — create/update (wire-bound or system-only), get,
 * list, and each named custom operation — is reachable as a plain async
 * function running its FULL pipeline, typed to demand a caller:
 * in-process code always knows who it is acting as (an event handler
 * passes SYSTEM_PRINCIPAL; the MCP gate passes the channel-resolved
 * user). This baseline interface carries the always-possible
 * create/update slots; `InvokerFor` layers the per-operation typing on
 * top when `defineResource` can see the concrete operations map.
 */
export interface ResourceInvoker<R extends ResourceMessage> {
  readonly create?: (input: R, caller: CallerPrincipal) => Promise<R>;
  readonly update?: (input: R, caller: CallerPrincipal) => Promise<R>;
}

/**
 * The fully-typed invoke surface derived from a concrete operations map:
 * one function per declared operation name, I/O types flowing from the
 * factory call sites (`getOperation<Task, GetTaskRequest>` ⇒
 * `invoke.get(req, caller): Promise<Task>`). Intersected with the
 * baseline so system-only create/update stay reachable.
 */
export type InvokerFor<R extends ResourceMessage, Ops> = ResourceInvoker<R> & {
  readonly [K in keyof Ops]-?: Ops[K] extends OperationBinding<R, infer I, infer O>
    ? Invokable<I, O>
    : never;
};

export interface DefinedResource<
  R extends ResourceMessage,
  S extends DescService,
  Inv extends ResourceInvoker<R> = ResourceInvoker<R>,
> {
  readonly service: S;
  readonly impl: Partial<ServiceImpl<S>>;
  /** Registers the service on a ConnectRouter. */
  routes(router: ConnectRouter): void;
  /** Same pipelines, no transport (T03 D1). */
  readonly invoke: Inv;
}

export function defineResource<
  R extends ResourceMessage,
  S extends DescService,
  Ops extends { readonly [K in ServiceMethodNames<S>]?: OperationBinding<R, never, unknown> },
>(opts: {
  definition: ResourceDefinition<R>;
  service: S;
  operations: Ops;
  /**
   * Operations that exist ONLY in-process — no service method, absent
   * from the wire by construction, reachable through `invoke` alone. The
   * system-written-resource seam: DD-001's "create: system" cell is
   * `systemOperations: { create: {} }` plus a system-only policy branch.
   */
  systemOperations?: {
    readonly create?: CreateOperationOptions<R>;
    readonly update?: UpdateOperationOptions<R>;
  };
}): DefinedResource<R, S, InvokerFor<R, Ops>> {
  const { definition, service, operations, systemOperations } = opts;
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
  const invoke: Record<string, InvokableCore<never, unknown> | WriteExecutor<R>> = {};

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
    if (binding.flavor === "create" || binding.flavor === "update") {
      // Runtime half of the typing stance: create/update must speak the
      // resource message itself (the resource-API convention) — which is
      // also what lets their pipelines validate against the definition's
      // schema and run without a transport.
      if (
        method.input.typeName !== definition.schema.typeName ||
        method.output.typeName !== definition.schema.typeName
      ) {
        throw new Error(
          `${definition.kind}: '${name}' must take and return ${definition.schema.typeName} ` +
            `(got ${method.input.typeName} -> ${method.output.typeName})`,
        );
      }
      const executor = (binding.buildExecutor as NonNullable<typeof binding.buildExecutor>)(
        runtime,
        name,
      );
      // Exposed under BOTH the operation name (what InvokerFor promises)
      // and the flavor (what ResourceInvoker's baseline and the event
      // handlers use) — the same executor either way.
      invoke[binding.flavor] = executor;
      invoke[name] = executor;
      impl[name] = async (req, hctx) => executor(req as R, await definition.caller(hctx));
    } else {
      const run = (binding.buildInvokable as NonNullable<typeof binding.buildInvokable>)(
        runtime,
        method,
        name,
      );
      invoke[name] = run;
      // The wire adapter — identical in shape to the create/update one:
      // extract the caller, delegate to the transport-free core.
      impl[name] = async (req, hctx) => run(req as never, await definition.caller(hctx));
    }
  }

  for (const flavor of ["create", "update"] as const) {
    const options = systemOperations?.[flavor];
    if (!options) continue;
    if (invoke[flavor]) {
      throw new Error(
        `${definition.kind}: '${flavor}' is declared both as a service operation and a ` +
          `system operation — declare it once (the service binding already populates invoke)`,
      );
    }
    invoke[flavor] =
      flavor === "create"
        ? buildCreateExecutor(runtime, flavor, options)
        : buildUpdateExecutor(runtime, flavor, options);
  }

  return {
    service,
    impl: impl as Partial<ServiceImpl<S>>,
    routes(router) {
      // Partial implementation is the declared-absence mechanism:
      // connect-es answers every unbound method with UNIMPLEMENTED.
      router.service(service, impl as Partial<ServiceImpl<S>>);
    },
    // The runtime object is name-keyed and flavor-keyed as built above;
    // the assertion narrows it to the per-operation types InvokerFor
    // computed from the factories' generics (the recorded typing stance:
    // types flow from where apps write code, not from descriptors).
    invoke: invoke as InvokerFor<R, Ops>,
  };
}

/** Convenience for message construction in respond() lambdas. */
export function buildMessage<Desc extends DescMessage>(
  schema: Desc,
  init: MessageInitShape<Desc>,
) {
  return create(schema, init);
}
