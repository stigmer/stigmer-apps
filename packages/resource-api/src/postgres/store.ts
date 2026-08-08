/**
 * Postgres ResourceStore: table per kind, hybrid rows.
 *
 * Each resource kind gets one table with exactly two authored columns —
 * `id text PRIMARY KEY` and `resource jsonb NOT NULL` (the full message in
 * proto3 JSON, human-readable in psql) — plus STORED generated columns for
 * every queryable or unique field, carrying real indexes. Writes stay
 * kind-generic (this adapter never knows a resource's fields); reads get
 * honest columns and EXPLAIN plans; uniqueness is database-owned, which
 * makes the unique index the ALREADY_EXISTS backstop for concurrent
 * creates (the race the pipeline's friendly pre-check cannot close).
 *
 * The per-resource migration file IS the storage design artifact: table,
 * generated columns, indexes, and the natural-key constraint (named
 * `<table>_natural_key` so this adapter can map violations). Example,
 * using this package's own Widget test fixture (the commons illustrates
 * with its fixture, never a consumer's resource):
 *
 *   CREATE TABLE widgets (
 *     id       text PRIMARY KEY,
 *     resource jsonb NOT NULL,
 *     serial_number text GENERATED ALWAYS AS (resource->'spec'->>'serialNumber') STORED,
 *     CONSTRAINT widgets_natural_key UNIQUE (serial_number)
 *   );
 *
 * Generated-column expressions read proto3 JSON, so keys are camelCase.
 */

import { type DescMessage, fromJson, toJson } from "@bufbuild/protobuf";
import type pg from "pg";
import type { ResourceMessage } from "../envelope.js";
import {
  DuplicateNaturalKeyError,
  type ListQuery,
  type ListResult,
  type ResourceStore,
} from "../store/store.js";

export interface PostgresKindConfig {
  readonly schema: DescMessage;
  readonly table: string;
  readonly naturalKey?: {
    /** Generated column holding the natural key. */
    readonly column: string;
    /** Spec proto3-JSON key (to report the clashing value on races). */
    readonly jsonField: string;
  };
  /**
   * Logical field name → generated column. The column's expression (in
   * the migration) may read any proto3-JSON path — spec, status, or
   * metadata (e.g. `resource->'status'->>'read'`,
   * `resource->'metadata'->>'createdAt'`); `->>` renders booleans as
   * 'true'/'false' text, which is exactly how the port contract compares
   * them.
   */
  readonly columns?: Readonly<Record<string, string>>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export class PostgresResourceStore implements ResourceStore {
  readonly #pool: pg.Pool;
  readonly #kinds: Record<string, PostgresKindConfig>;

  constructor(pool: pg.Pool, kinds: Record<string, PostgresKindConfig>) {
    // Identifiers come from adapter config (code, never user input), but
    // they are interpolated into SQL — validate once at construction as
    // defense in depth.
    for (const [kind, config] of Object.entries(kinds)) {
      const names = [
        config.table,
        config.naturalKey?.column,
        ...Object.values(config.columns ?? {}),
      ].filter((n): n is string => n !== undefined);
      for (const name of names) {
        if (!IDENTIFIER.test(name)) {
          throw new Error(`Invalid SQL identifier '${name}' in config for kind '${kind}'`);
        }
      }
    }
    this.#pool = pool;
    this.#kinds = kinds;
  }

  async save(kind: string, resource: ResourceMessage): Promise<void> {
    const config = this.#config(kind);
    const id = resource.metadata?.id;
    if (!id) {
      throw new Error(`Cannot save ${kind} without metadata.id (pipeline bug)`);
    }
    const json = toJson(config.schema, resource as never);
    try {
      await this.#pool.query(
        `INSERT INTO ${config.table} (id, resource) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET resource = EXCLUDED.resource`,
        [id, JSON.stringify(json)],
      );
    } catch (err) {
      if (isUniqueViolation(err) && err.constraint === `${config.table}_natural_key`) {
        const spec = (json as { spec?: Record<string, unknown> }).spec;
        const value = config.naturalKey ? String(spec?.[config.naturalKey.jsonField] ?? "") : "";
        throw new DuplicateNaturalKeyError(kind, value);
      }
      throw err;
    }
  }

  async getById(kind: string, id: string): Promise<ResourceMessage | undefined> {
    const config = this.#config(kind);
    const res = await this.#pool.query(
      `SELECT resource FROM ${config.table} WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? this.#toMessage(config, res.rows[0].resource) : undefined;
  }

  async getByNaturalKey(kind: string, value: string): Promise<ResourceMessage | undefined> {
    const config = this.#config(kind);
    if (!config.naturalKey) return undefined;
    const res = await this.#pool.query(
      `SELECT resource FROM ${config.table} WHERE ${config.naturalKey.column} = $1`,
      [value],
    );
    return res.rows[0] ? this.#toMessage(config, res.rows[0].resource) : undefined;
  }

  async list(kind: string, query: ListQuery): Promise<ListResult<ResourceMessage>> {
    const config = this.#config(kind);

    const where: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of Object.entries(query.filter ?? {})) {
      params.push(value);
      where.push(`${this.#column(kind, config, field)} = $${params.length}`);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

    let orderSql = "";
    if (query.orderBy) {
      const column = this.#column(kind, config, query.orderBy.field);
      const direction = query.orderBy.direction === "desc" ? "DESC" : "ASC";
      const nulls = query.orderBy.nulls === "first" ? "NULLS FIRST" : "NULLS LAST";
      // Secondary sort on id (time-ordered ULIDs) makes pagination stable
      // when the order field ties or is null.
      orderSql = ` ORDER BY ${column} ${direction} ${nulls}, id ASC`;
    }

    params.push(query.limit, query.offset);
    const pageSql = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [rows, count] = await Promise.all([
      this.#pool.query(
        `SELECT resource FROM ${config.table}${whereSql}${orderSql}${pageSql}`,
        params,
      ),
      this.#pool.query(
        `SELECT count(*)::int AS n FROM ${config.table}${whereSql}`,
        params.slice(0, params.length - 2),
      ),
    ]);

    return {
      items: rows.rows.map((r) => this.#toMessage(config, r.resource)),
      totalCount: count.rows[0].n as number,
    };
  }

  async countBy(
    kind: string,
    field: string,
    values: readonly string[],
  ): Promise<Map<string, number>> {
    const config = this.#config(kind);
    const column = this.#column(kind, config, field);
    const counts = new Map<string, number>();
    if (values.length === 0) {
      return counts;
    }
    // One GROUP BY regardless of how many values: this method exists so
    // page-shaped status derivation is never an N+1 (T03 D4).
    const res = await this.#pool.query(
      `SELECT ${column} AS value, count(*)::int AS n
         FROM ${config.table}
        WHERE ${column} = ANY($1::text[])
        GROUP BY ${column}`,
      [[...values]],
    );
    for (const row of res.rows) {
      counts.set(row.value as string, row.n as number);
    }
    return counts;
  }

  #config(kind: string): PostgresKindConfig {
    const config = this.#kinds[kind];
    if (!config) {
      throw new Error(
        `Kind '${kind}' is not registered with this PostgresResourceStore. ` +
          `Registered kinds: ${Object.keys(this.#kinds).join(", ") || "(none)"}`,
      );
    }
    return config;
  }

  #column(kind: string, config: PostgresKindConfig, field: string): string {
    const column = config.columns?.[field];
    if (!column) {
      // Loud, not silent: an unregistered field in orderBy/filter is a
      // programming error that would otherwise return wrong data.
      throw new Error(
        `Field '${field}' is not registered as a column for kind '${kind}'. ` +
          `Registered fields: ${Object.keys(config.columns ?? {}).join(", ") || "(none)"}`,
      );
    }
    return column;
  }

  #toMessage(config: PostgresKindConfig, json: unknown): ResourceMessage {
    return fromJson(config.schema, json as never) as unknown as ResourceMessage;
  }
}

function isUniqueViolation(err: unknown): err is Error & { code: string; constraint?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}
