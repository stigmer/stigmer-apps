/**
 * In-memory ResourceStore. Not a mock: it implements the full port
 * contract (natural-key uniqueness, list ordering with explicit NULLS
 * placement, equality filters, grouped counts) and is exercised by the
 * same contract test suite as the Postgres adapter, so consumers can use
 * it in their tests with confidence that behavior matches production.
 */

import { clone, type DescMessage, toJson } from "@bufbuild/protobuf";
import type { ResourceMessage } from "../envelope.js";
import {
  DuplicateNaturalKeyError,
  type FilterValue,
  type ListQuery,
  type ListResult,
  type NormalizedFilter,
  normalizeFilterValue,
  type ResourceStore,
} from "./store.js";

export interface MemoryKindConfig {
  /** Generated schema for the resource message (used to clone/serialize). */
  readonly schema: DescMessage;
  /** Spec proto3-JSON key of the natural key (e.g. "serialNumber"). */
  readonly naturalKeyField?: string;
  /**
   * Composite/derived natural keys: the fake's analogue of a Postgres
   * generated-column EXPRESSION (e.g. `caseId || ':' || memberId`).
   * When set, uniqueness and getByNaturalKey use this function and
   * naturalKeyField is ignored. Undefined return means "no key on this
   * row" (never unique-checked, never matched).
   */
  readonly naturalKeyOf?: (resource: ResourceMessage) => string | undefined;
  /**
   * Logical field name → proto3-JSON path under the resource root (e.g.
   * "spec.ownerId", "status.retired", "metadata.createdAt") — mirrors the
   * Postgres adapter's registered generated columns, so a typo'd field
   * name fails identically here and in production instead of silently
   * matching nothing. Values compare as JSON scalars rendered to text
   * (booleans as "true"/"false"), matching Postgres `->>` semantics.
   */
  readonly fields?: Readonly<Record<string, string>>;
}

export class MemoryResourceStore implements ResourceStore {
  readonly #kinds: Record<string, MemoryKindConfig>;
  readonly #rows = new Map<string, Map<string, ResourceMessage>>();

  constructor(kinds: Record<string, MemoryKindConfig>) {
    this.#kinds = kinds;
  }

  async save(kind: string, resource: ResourceMessage): Promise<void> {
    const config = this.#config(kind);
    const id = resource.metadata?.id;
    if (!id) {
      throw new Error(`Cannot save ${kind} without metadata.id (pipeline bug)`);
    }

    const value = this.#naturalKey(kind, resource);
    if (value !== undefined) {
      for (const [otherId, other] of this.#table(kind)) {
        if (otherId === id) continue;
        if (this.#naturalKey(kind, other) === value) {
          throw new DuplicateNaturalKeyError(kind, value);
        }
      }
    }

    // Store and return clones, never references: aliasing between the
    // store and live pipeline state would hide bugs the Postgres adapter
    // (which round-trips through JSON) can never have.
    this.#table(kind).set(id, clone(config.schema, resource as never) as ResourceMessage);
  }

  async getById(kind: string, id: string): Promise<ResourceMessage | undefined> {
    this.#config(kind); // reject unregistered kinds loudly, like every method
    const row = this.#table(kind).get(id);
    return row ? this.#cloneOut(kind, row) : undefined;
  }

  async getByNaturalKey(kind: string, value: string): Promise<ResourceMessage | undefined> {
    const config = this.#config(kind);
    if (!config.naturalKeyField && !config.naturalKeyOf) return undefined;
    for (const row of this.#table(kind).values()) {
      if (this.#naturalKey(kind, row) === value) {
        return this.#cloneOut(kind, row);
      }
    }
    return undefined;
  }

  #naturalKey(kind: string, row: ResourceMessage): string | undefined {
    const config = this.#config(kind);
    if (config.naturalKeyOf) {
      return config.naturalKeyOf(row);
    }
    if (config.naturalKeyField) {
      return this.#jsonValue(kind, row, `spec.${config.naturalKeyField}`);
    }
    return undefined;
  }

  async list(kind: string, query: ListQuery): Promise<ListResult<ResourceMessage>> {
    this.#config(kind);
    let rows = [...this.#table(kind).values()];

    if (query.filter) {
      for (const [field, value] of Object.entries(query.filter)) {
        const path = this.#fieldPath(kind, field);
        const condition = normalizeFilterValue(field, value);
        rows = rows.filter((r) => matchesCondition(this.#jsonValue(kind, r, path), condition));
      }
    }

    if (query.orderBy) {
      const { field, direction, nulls } = query.orderBy;
      const path = this.#fieldPath(kind, field);
      // Lexicographic comparison over the JSON-scalar text — correct for
      // the port's supported order fields (plain strings, ISO dates, and
      // RFC3339 timestamps all sort chronologically as text). Matches the
      // Postgres adapter's text generated columns. Ties (including both
      // unset) fall through to id ASC, mirroring the Postgres adapter's
      // unconditional `, id ASC` — without it, equal keys page by
      // insertion order here and by ULID there, and the divergence only
      // shows up as a page-boundary flake.
      rows.sort((a, b) => {
        const av = this.#jsonValue(kind, a, path);
        const bv = this.#jsonValue(kind, b, path);
        let primary = 0;
        if (av === undefined && bv !== undefined) {
          primary = nulls === "last" ? 1 : -1;
        } else if (bv === undefined && av !== undefined) {
          primary = nulls === "last" ? -1 : 1;
        } else if (av !== undefined && bv !== undefined) {
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          primary = direction === "asc" ? cmp : -cmp;
        }
        if (primary !== 0) return primary;
        const aid = a.metadata?.id ?? "";
        const bid = b.metadata?.id ?? "";
        return aid < bid ? -1 : aid > bid ? 1 : 0;
      });
    }

    const totalCount = rows.length;
    const page = rows
      .slice(query.offset, query.offset + query.limit)
      .map((r) => this.#cloneOut(kind, r));
    return { items: page, totalCount };
  }

  async getByIds(kind: string, ids: readonly string[]): Promise<Map<string, ResourceMessage>> {
    this.#config(kind);
    const table = this.#table(kind);
    const found = new Map<string, ResourceMessage>();
    for (const id of ids) {
      const row = table.get(id);
      if (row) {
        found.set(id, this.#cloneOut(kind, row));
      }
    }
    return found;
  }

  async countBy(
    kind: string,
    field: string,
    values: readonly string[],
    filter?: Readonly<Record<string, FilterValue>>,
  ): Promise<Map<string, number>> {
    this.#config(kind);
    const path = this.#fieldPath(kind, field);
    const wanted = new Set(values);
    const counts = new Map<string, number>();
    for (const row of this.#filteredRows(kind, filter)) {
      const value = this.#jsonValue(kind, row, path);
      if (value !== undefined && wanted.has(value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return counts;
  }

  async sumBy(
    kind: string,
    groupField: string,
    valueField: string,
    values: readonly string[],
    filter?: Readonly<Record<string, FilterValue>>,
  ): Promise<Map<string, number>> {
    this.#config(kind);
    const groupPath = this.#fieldPath(kind, groupField);
    const valuePath = this.#fieldPath(kind, valueField);
    const wanted = new Set(values);
    const sums = new Map<string, number>();
    for (const row of this.#filteredRows(kind, filter)) {
      const group = this.#jsonValue(kind, row, groupPath);
      if (group === undefined || !wanted.has(group)) continue;
      const rendered = this.#jsonValue(kind, row, valuePath);
      // Absent contributes nothing (the SQL SUM-over-NULL behavior);
      // present-but-not-an-integer is a loud error, matching the
      // Postgres adapter's ::bigint cast failure.
      if (rendered === undefined) continue;
      if (!/^-?\d+$/.test(rendered)) {
        throw new Error(
          `sumBy on '${kind}.${valueField}': value '${rendered}' is not an integer ` +
            `(row ${row.metadata?.id})`,
        );
      }
      sums.set(group, (sums.get(group) ?? 0) + Number(rendered));
    }
    return sums;
  }

  async searchText(
    kind: string,
    field: string,
    query: string,
    limit: number,
    filter?: Readonly<Record<string, FilterValue>>,
  ): Promise<readonly ResourceMessage[]> {
    this.#config(kind);
    const path = this.#fieldPath(kind, field);
    if (query.length === 0) {
      throw new Error(`searchText on '${kind}.${field}': query must not be empty`);
    }
    const needle = query.toLowerCase();
    const hits: { rendered: string; row: ResourceMessage }[] = [];
    // Filter BEFORE the limit (the port contract): out-of-scope rows
    // must never occupy result slots.
    for (const row of this.#filteredRows(kind, filter)) {
      const rendered = this.#searchValue(kind, row, path);
      if (rendered !== undefined && rendered.toLowerCase().includes(needle)) {
        hits.push({ rendered, row });
      }
    }
    // Searched-field ascending with the id tiebreak — the list ordering
    // discipline applied to search results.
    hits.sort((a, b) => {
      if (a.rendered !== b.rendered) return a.rendered < b.rendered ? -1 : 1;
      const aid = a.row.metadata?.id ?? "";
      const bid = b.row.metadata?.id ?? "";
      return aid < bid ? -1 : aid > bid ? 1 : 0;
    });
    return hits.slice(0, Math.max(0, limit)).map((h) => this.#cloneOut(kind, h.row));
  }

  /** Rows passing a list-shaped filter — shared by countBy and sumBy. */
  #filteredRows(
    kind: string,
    filter: Readonly<Record<string, FilterValue>> | undefined,
  ): ResourceMessage[] {
    let rows = [...this.#table(kind).values()];
    if (filter) {
      for (const [field, value] of Object.entries(filter)) {
        const path = this.#fieldPath(kind, field);
        const condition = normalizeFilterValue(field, value);
        rows = rows.filter((r) => matchesCondition(this.#jsonValue(kind, r, path), condition));
      }
    }
    return rows;
  }

  #config(kind: string): MemoryKindConfig {
    const config = this.#kinds[kind];
    if (!config) {
      throw new Error(
        `Kind '${kind}' is not registered with this MemoryResourceStore. ` +
          `Registered kinds: ${Object.keys(this.#kinds).join(", ") || "(none)"}`,
      );
    }
    return config;
  }

  #table(kind: string): Map<string, ResourceMessage> {
    let table = this.#rows.get(kind);
    if (!table) {
      table = new Map();
      this.#rows.set(kind, table);
    }
    return table;
  }

  #cloneOut(kind: string, row: ResourceMessage): ResourceMessage {
    return clone(this.#config(kind).schema, row as never) as ResourceMessage;
  }

  #fieldPath(kind: string, field: string): string {
    const path = this.#config(kind).fields?.[field];
    if (!path) {
      // Loud, not silent: an unregistered field in orderBy/filter/countBy
      // is a programming error that would otherwise return wrong data.
      throw new Error(
        `Field '${field}' is not registered for kind '${kind}'. ` +
          `Registered fields: ${Object.keys(this.#config(kind).fields ?? {}).join(", ") || "(none)"}`,
      );
    }
    return path;
  }

  /**
   * Reads a proto3-JSON path and renders the scalar as text — the same
   * answer Postgres `->>` gives for that path, which is what keeps the
   * two adapters bit-identical under the contract suite. Unset paths and
   * empty strings read as undefined (an absent JSON key and `->>` NULL).
   */
  #jsonValue(kind: string, row: ResourceMessage, path: string): string | undefined {
    const node = this.#jsonNode(kind, row, path);
    if (node === undefined || node === null) return undefined;
    if (typeof node === "string") return node === "" ? undefined : node;
    if (typeof node === "boolean" || typeof node === "number") return String(node);
    return undefined;
  }

  /**
   * The search rendering: scalars as #jsonValue; structured nodes as
   * their JSON text (the Postgres `(...)::text` analogue — container
   * punctuation is unspecified by the port contract, scalar content is
   * what search matches).
   */
  #searchValue(kind: string, row: ResourceMessage, path: string): string | undefined {
    const node = this.#jsonNode(kind, row, path);
    if (node === undefined || node === null) return undefined;
    if (typeof node === "string") return node === "" ? undefined : node;
    if (typeof node === "boolean" || typeof node === "number") return String(node);
    return JSON.stringify(node);
  }

  #jsonNode(kind: string, row: ResourceMessage, path: string): unknown {
    let node: unknown = toJson(this.#config(kind).schema, row as never);
    for (const key of path.split(".")) {
      if (node === null || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  }
}

/**
 * One condition against one rendered value. `undefined` is "the field is
 * absent" — it satisfies only `absent`, exactly as a NULL generated
 * column behaves under the Postgres adapter's SQL (`IS NULL` matches;
 * `=`, `= ANY`, and every comparison are false against NULL).
 */
function matchesCondition(actual: string | undefined, condition: NormalizedFilter): boolean {
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "in":
      return actual !== undefined && condition.values.includes(actual);
    case "range":
      return (
        actual !== undefined &&
        condition.bounds.every(({ cmp, value }) => {
          switch (cmp) {
            case "gte":
              return actual >= value;
            case "gt":
              return actual > value;
            case "lte":
              return actual <= value;
            case "lt":
              return actual < value;
          }
        })
      );
    case "absent":
      return actual === undefined;
  }
}
