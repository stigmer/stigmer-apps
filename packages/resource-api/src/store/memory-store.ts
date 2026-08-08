/**
 * In-memory ResourceStore. Not a mock: it implements the full port
 * contract (natural-key uniqueness, list ordering with explicit NULLS
 * placement, equality filters) and is exercised by the same contract test
 * suite as the Postgres adapter, so consumers can use it in their tests
 * with confidence that behavior matches production.
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
   * Spec fields allowed in list orderBy/filter — mirrors the Postgres
   * adapter's registered generated columns, so a typo'd field name fails
   * identically here and in production instead of silently matching
   * nothing.
   */
  readonly queryableFields?: readonly string[];
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
      const value = this.#specField(kind, resource, config.naturalKeyField);
      if (value !== undefined) {
        for (const [otherId, other] of this.#table(kind)) {
          if (otherId === id) continue;
          if (this.#specField(kind, other, config.naturalKeyField) === value) {
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
      if (this.#specField(kind, row, field) === value) {
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
        this.#assertQueryable(kind, field);
        rows = rows.filter((r) => this.#specField(kind, r, field) === value);
      }
    }

    if (query.orderBy) {
      const { field, direction, nulls } = query.orderBy;
      this.#assertQueryable(kind, field);
      // Lexicographic comparison — correct for the port's supported order
      // fields (plain strings and ISO dates, which sort chronologically as
      // text). Matches the Postgres adapter's text generated columns.
      rows.sort((a, b) => {
        const av = this.#specField(kind, a, field);
        const bv = this.#specField(kind, b, field);
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

  #assertQueryable(kind: string, field: string): void {
    const { queryableFields } = this.#config(kind);
    if (queryableFields && !queryableFields.includes(field)) {
      throw new Error(
        `Field '${field}' is not registered as queryable for kind '${kind}'. ` +
          `Registered fields: ${queryableFields.join(", ") || "(none)"}`,
      );
    }
  }

  /** Reads a spec field by its proto3-JSON key — the port's logical field naming. */
  #specField(kind: string, row: ResourceMessage, field: string): string | undefined {
    const json = toJson(this.#config(kind).schema, row as never) as {
      spec?: Record<string, unknown>;
    };
    const value = json.spec?.[field];
    return typeof value === "string" && value !== "" ? value : undefined;
  }
}
