/**
 * The kind-generic store port. Both parent commons abstract persistence
 * behind exactly one kind-keyed interface (Go: `store.Store` over SQLite
 * byte blobs; Java: Mongo repositories behind a registry) — that is what
 * lets every resource ride the same pipeline with zero per-resource
 * persistence code, and this port keeps that property.
 *
 * List semantics are part of the port contract so the in-memory fake and
 * the Postgres adapter are interchangeable in tests: `orderBy`/`filter`
 * use per-kind *logical field names* (camelCase, e.g. "serialNumber"),
 * each registered in the adapter's kind config against a proto3-JSON path
 * under spec, status, or metadata (e.g. "status.retired",
 * "metadata.createdAt" — RFC3339 UTC text, so text ordering IS
 * chronological ordering). Values compare as the field's proto3-JSON
 * scalar rendered to text — booleans match "true"/"false" — which is
 * exactly what Postgres `->>` yields, so the adapters cannot disagree.
 * Every adapter MUST reject unregistered names loudly (a typo'd field
 * silently ignored would return wrong data).
 *
 * Deliberately absent: delete (no MVP resource exposes it — absence is a
 * declaration, added when the first consumer needs it) and transactions
 * spanning calls (neither parent has them; a failed later step leaves the
 * persisted write in place, same as Java/Go).
 */

import type { ResourceMessage } from "../envelope.js";

export interface ListQuery {
  readonly limit: number;
  readonly offset: number;
  readonly orderBy?: {
    readonly field: string;
    readonly direction: "asc" | "desc";
    /**
     * Where rows with an unset field sort. Postgres defaults put NULLs
     * first on DESC and last on ASC; making it explicit here keeps the
     * memory fake and Postgres identical.
     */
    readonly nulls: "first" | "last";
  };
  /** Equality filters, ANDed. */
  readonly filter?: Readonly<Record<string, string>>;
}

export interface ListResult<R extends ResourceMessage> {
  readonly items: readonly R[];
  /** Total matching rows ignoring limit/offset (for pagination UIs). */
  readonly totalCount: number;
}

/**
 * Thrown by `save` when a database uniqueness constraint on the resource's
 * natural key fires — the backstop for the race window between the
 * pipeline's duplicate-check step and persist (two concurrent creates).
 * The operation layer maps this to ALREADY_EXISTS.
 */
export class DuplicateNaturalKeyError extends Error {
  constructor(
    readonly kind: string,
    readonly value: string,
  ) {
    super(`${kind} with duplicate natural key '${value}'`);
    this.name = "DuplicateNaturalKeyError";
  }
}

export interface ResourceStore {
  /** Upsert by `metadata.id`. Throws DuplicateNaturalKeyError (see above). */
  save(kind: string, resource: ResourceMessage): Promise<void>;

  getById(kind: string, id: string): Promise<ResourceMessage | undefined>;

  /**
   * Lookup by the resource's natural key (e.g. case number, email).
   * Undefined when the kind has no natural key configured or no row
   * matches.
   */
  getByNaturalKey(kind: string, value: string): Promise<ResourceMessage | undefined>;

  list(kind: string, query: ListQuery): Promise<ListResult<ResourceMessage>>;

  /**
   * Row counts grouped by a registered logical field, for the values
   * given — one round trip regardless of page size, so a page-shaped
   * deriveStatus (e.g. Case.document_count over 20 cases) is never an
   * N+1. Values absent from the result have count 0. Forced by the first
   * derived-count consumer (T03 D4).
   */
  countBy(kind: string, field: string, values: readonly string[]): Promise<Map<string, number>>;

  /**
   * Bulk getById — one round trip for a page's worth of references, so a
   * page-shaped deriveStatus that renders REFERENCED resources (e.g.
   * Task.case_number over 20 tasks) is never an N+1; the countBy
   * precedent applied to lookups. Unknown ids are simply absent from the
   * map. Forced by the first derived-reference consumer (T04b D9).
   */
  getByIds(kind: string, ids: readonly string[]): Promise<Map<string, ResourceMessage>>;
}
