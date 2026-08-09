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
 * The filter vocabulary is a closed union of four shapes (equality, set
 * membership, range, absent), combined with AND semantics only — the
 * parent commons' record-filter grammar is likewise AND-only in v1.
 * Deliberately NOT in the vocabulary: negation (`neq`/`not_in`) — plain
 * SQL inequality silently drops rows where the field is absent, so both
 * parents had to special-case NULL to make it truthful, and no consumer
 * here needs it; and OR groups. Each variant exists because a real
 * consumer forced it (equality T02, the rest T05's named list
 * predicates); absence of anything richer is a declaration, not an
 * oversight.
 *
 * Deliberately absent: delete (no MVP resource exposes it — absence is a
 * declaration, added when the first consumer needs it) and transactions
 * spanning calls (neither parent has them; a failed later step leaves the
 * persisted write in place, same as Java/Go).
 */

import type { ResourceMessage } from "../envelope.js";

/**
 * One filter condition on a registered field. A bare string is equality
 * (every pre-T05 call site reads unchanged); the object forms are the
 * three additions the named list predicates forced:
 *
 * - `{ in: [...] }`  — set membership. An empty array matches nothing
 *   (SQL `= ANY('{}')` is false; the fake agrees), which is the honest
 *   answer for a composed "state in <empty set>".
 * - `{ gte/gt/lte/lt }` — range over the field's text rendering (ISO
 *   dates and RFC3339 timestamps order chronologically as text). At
 *   least one bound is required. Rows where the field is ABSENT never
 *   match a range — SQL comparison against NULL is false, and the fake
 *   mirrors it.
 * - `{ absent: true }` — the field was never set (absent from the stored
 *   proto3 JSON ⇒ the generated column is NULL). The only way to ask
 *   "matters with no hearing scheduled"; a range cannot express it by
 *   definition.
 */
export type FilterValue =
  | string
  | { readonly in: readonly string[] }
  | {
      readonly gte?: string;
      readonly gt?: string;
      readonly lte?: string;
      readonly lt?: string;
    }
  | { readonly absent: true };

/** A range bound, normalized: the comparison operator and its value. */
export interface RangeBound {
  readonly cmp: "gte" | "gt" | "lte" | "lt";
  readonly value: string;
}

/** The adapter-facing normal form of a FilterValue (see normalizeFilterValue). */
export type NormalizedFilter =
  | { readonly op: "eq"; readonly value: string }
  | { readonly op: "in"; readonly values: readonly string[] }
  | { readonly op: "range"; readonly bounds: readonly RangeBound[] }
  | { readonly op: "absent" };

/**
 * Validates a FilterValue and reduces it to one unambiguous normal form.
 * Lives on the port, not in an adapter, so both adapters reject a
 * malformed filter with the SAME loud error — a shape the fake tolerated
 * but Postgres rejected (or vice versa) would make tests written on the
 * fake prove nothing. Loud, not silent, like unregistered field names:
 * an empty range or a mixed object is a programming error, and guessing
 * a meaning for it would return wrong data.
 */
export function normalizeFilterValue(field: string, value: FilterValue): NormalizedFilter {
  if (typeof value === "string") {
    return { op: "eq", value };
  }
  const keys = Object.keys(value);
  if ("in" in value) {
    if (keys.length !== 1) {
      throw new Error(
        `Filter on '${field}' mixes 'in' with other conditions (${keys.join(", ")}); ` +
          `one condition shape per field`,
      );
    }
    return { op: "in", values: value.in };
  }
  if ("absent" in value) {
    if (keys.length !== 1 || value.absent !== true) {
      throw new Error(
        `Filter on '${field}' misuses 'absent' (got keys ${keys.join(", ")}); ` +
          `the only valid form is { absent: true }`,
      );
    }
    return { op: "absent" };
  }
  const bounds: RangeBound[] = [];
  for (const cmp of ["gte", "gt", "lte", "lt"] as const) {
    const bound = (value as Record<string, string | undefined>)[cmp];
    if (bound !== undefined) {
      bounds.push({ cmp, value: bound });
    }
  }
  if (bounds.length === 0 || bounds.length !== keys.length) {
    throw new Error(
      `Filter on '${field}' is not a valid range (got keys ${keys.join(", ") || "(none)"}); ` +
        `a range needs at least one of gte/gt/lte/lt and nothing else`,
    );
  }
  return { op: "range", bounds };
}

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
  /** Conditions on registered fields, ANDed (see FilterValue). */
  readonly filter?: Readonly<Record<string, FilterValue>>;
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
