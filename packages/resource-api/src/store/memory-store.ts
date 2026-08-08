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
  type ListQuery,
  type ListResult,
  type ResourceStore,
} from "./store.js";

export interface MemoryKindConfig {
  /** Generated schema for the resource message (used to clone/serialize). */
  readonly schema: DescMessage;
  /** Spec proto3-JSON key of the natural key (e.g. "serialNumber"). */
  readonly naturalKeyField?: string;
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

    if (config.naturalKeyField) {
      const value = this.#jsonValue(kind, resource, `spec.${config.naturalKeyField}`);
      if (value !== undefined) {
        for (const [otherId, other] of this.#table(kind)) {
          if (otherId === id) continue;
          if (this.#jsonValue(kind, other, `spec.${config.naturalKeyField}`) === value) {
            throw new DuplicateNaturalKeyError(kind, value);
          }
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
    const field = this.#config(kind).naturalKeyField;
    if (!field) return undefined;
    for (const row of this.#table(kind).values()) {
      if (this.#jsonValue(kind, row, `spec.${field}`) === value) {
        return this.#cloneOut(kind, row);
      }
    }
    return undefined;
  }

  async list(kind: string, query: ListQuery): Promise<ListResult<ResourceMessage>> {
    this.#config(kind);
    let rows = [...this.#table(kind).values()];

    if (query.filter) {
      for (const [field, value] of Object.entries(query.filter)) {
        const path = this.#fieldPath(kind, field);
        rows = rows.filter((r) => this.#jsonValue(kind, r, path) === value);
      }
    }

    if (query.orderBy) {
      const { field, direction, nulls } = query.orderBy;
      const path = this.#fieldPath(kind, field);
      // Lexicographic comparison over the JSON-scalar text — correct for
      // the port's supported order fields (plain strings, ISO dates, and
      // RFC3339 timestamps all sort chronologically as text). Matches the
      // Postgres adapter's text generated columns.
      rows.sort((a, b) => {
        const av = this.#jsonValue(kind, a, path);
        const bv = this.#jsonValue(kind, b, path);
        if (av === undefined && bv === undefined) return 0;
        if (av === undefined) return nulls === "last" ? 1 : -1;
        if (bv === undefined) return nulls === "last" ? -1 : 1;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return direction === "asc" ? cmp : -cmp;
      });
    }

    const totalCount = rows.length;
    const page = rows
      .slice(query.offset, query.offset + query.limit)
      .map((r) => this.#cloneOut(kind, r));
    return { items: page, totalCount };
  }

  async countBy(
    kind: string,
    field: string,
    values: readonly string[],
  ): Promise<Map<string, number>> {
    this.#config(kind);
    const path = this.#fieldPath(kind, field);
    const wanted = new Set(values);
    const counts = new Map<string, number>();
    for (const row of this.#table(kind).values()) {
      const value = this.#jsonValue(kind, row, path);
      if (value !== undefined && wanted.has(value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return counts;
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
    let node: unknown = toJson(this.#config(kind).schema, row as never);
    for (const key of path.split(".")) {
      if (node === null || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    if (node === undefined || node === null) return undefined;
    if (typeof node === "string") return node === "" ? undefined : node;
    if (typeof node === "boolean" || typeof node === "number") return String(node);
    return undefined;
  }
}
