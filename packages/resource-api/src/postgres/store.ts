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
  type FilterValue,
  type ListQuery,
  type ListResult,
  normalizeFilterValue,
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

    const params: unknown[] = [];
    const where = this.#filterConditions(kind, config, query.filter, params);
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

  async getByIds(kind: string, ids: readonly string[]): Promise<Map<string, ResourceMessage>> {
    const config = this.#config(kind);
    const found = new Map<string, ResourceMessage>();
    if (ids.length === 0) {
      return found;
    }
    // One IN-query regardless of how many ids: the countBy arrangement
    // applied to lookups, so derived references are never an N+1 (T04b D9).
    const res = await this.#pool.query(
      `SELECT id, resource FROM ${config.table} WHERE id = ANY($1::text[])`,
      [[...ids]],
    );
    for (const row of res.rows) {
      found.set(row.id as string, this.#toMessage(config, row.resource));
    }
    return found;
  }

  async countBy(
    kind: string,
    field: string,
    values: readonly string[],
    filter?: Readonly<Record<string, FilterValue>>,
  ): Promise<Map<string, number>> {
    const config = this.#config(kind);
    const column = this.#column(kind, config, field);
    const counts = new Map<string, number>();
    if (values.length === 0) {
      return counts;
    }
    const params: unknown[] = [[...values]];
    const where = [`${column} = ANY($1::text[])`, ...this.#filterConditions(kind, config, filter, params)];
    // One GROUP BY regardless of how many values: this method exists so
    // page-shaped status derivation is never an N+1 (T03 D4).
    const res = await this.#pool.query(
      `SELECT ${column} AS value, count(*)::int AS n
         FROM ${config.table}
        WHERE ${where.join(" AND ")}
        GROUP BY ${column}`,
      params,
    );
    for (const row of res.rows) {
      counts.set(row.value as string, row.n as number);
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
    const config = this.#config(kind);
    const groupColumn = this.#column(kind, config, groupField);
    const valueColumn = this.#column(kind, config, valueField);
    const sums = new Map<string, number>();
    if (values.length === 0) {
      return sums;
    }
    const params: unknown[] = [[...values]];
    const where = [
      `${groupColumn} = ANY($1::text[])`,
      ...this.#filterConditions(kind, config, filter, params),
    ];
    // ::bigint on the text generated column: int64 fields render as JSON
    // strings, and a non-integer rendering fails the cast LOUDLY — the
    // memory adapter throws the matching error. The total returns as
    // text so a sum past int4 cannot be silently truncated by the
    // driver; the port answers plain numbers (safe-range by contract).
    const res = await this.#pool.query(
      `SELECT ${groupColumn} AS value, SUM((${valueColumn})::bigint)::text AS total
         FROM ${config.table}
        WHERE ${where.join(" AND ")}
        GROUP BY ${groupColumn}`,
      params,
    );
    for (const row of res.rows) {
      // SUM over only-NULL contributions yields NULL — the group's rows
      // exist but carry no value; the contract says it contributes
      // nothing, so skip rather than report 0 vs absent inconsistently.
      if (row.total === null) continue;
      sums.set(row.value as string, Number(row.total));
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
    const config = this.#config(kind);
    const column = this.#column(kind, config, field);
    if (query.length === 0) {
      throw new Error(`searchText on '${kind}.${field}': query must not be empty`);
    }
    // The query matches LITERALLY: escape LIKE's wildcards so a '%' in
    // user input is a character, not a match-anything (the memory
    // adapter's substring semantics never had wildcards to begin with).
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const params: unknown[] = [`%${escaped}%`];
    // Filter conditions join the WHERE — inside the query, BEFORE the
    // limit (the port contract's starvation rule).
    //
    // The explicit ICU collation makes case folding the ADAPTER's
    // property, not the database's: under a C/POSIX locale (musl-libc
    // images, unpinned managed defaults) plain ILIKE folds ASCII only,
    // silently diverging from the memory adapter's Unicode folding
    // (issue #3). It rides the predicate only — ORDER BY keeps the
    // database collation, so ordering indexes stay usable. Requires an
    // ICU-enabled server; assertStoreCapabilities turns a missing
    // collation into a boot-time refusal instead of a first-search
    // failure.
    const where = [
      `${column} COLLATE "und-x-icu" ILIKE $1 ESCAPE '\\'`,
      ...this.#filterConditions(kind, config, filter, params),
    ];
    params.push(Math.max(0, limit));
    const res = await this.#pool.query(
      `SELECT resource FROM ${config.table}
        WHERE ${where.join(" AND ")}
        ORDER BY ${column} ASC, id ASC
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => this.#toMessage(config, r.resource));
  }

  /**
   * Renders a list-shaped filter to SQL conditions, appending bound
   * parameters — shared by list, countBy, and sumBy so the closed filter
   * vocabulary has exactly one SQL rendering. normalizeFilterValue lives
   * on the port so a malformed filter fails with the same error here and
   * in the memory fake. Values are always bound parameters; only the
   * registered column name reaches the SQL.
   */
  #filterConditions(
    kind: string,
    config: PostgresKindConfig,
    filter: Readonly<Record<string, FilterValue>> | undefined,
    params: unknown[],
  ): string[] {
    const where: string[] = [];
    for (const [field, value] of Object.entries(filter ?? {})) {
      const column = this.#column(kind, config, field);
      const condition = normalizeFilterValue(field, value);
      switch (condition.op) {
        case "eq":
          params.push(condition.value);
          where.push(`${column} = $${params.length}`);
          break;
        case "in":
          // `= ANY('{}')` is false: an empty set matches nothing, which is
          // the contract (and what the fake's `[].includes` yields).
          params.push([...condition.values]);
          where.push(`${column} = ANY($${params.length}::text[])`);
          break;
        case "range":
          for (const bound of condition.bounds) {
            params.push(bound.value);
            const sqlCmp =
              bound.cmp === "gte" ? ">=" : bound.cmp === "gt" ? ">" : bound.cmp === "lte" ? "<=" : "<";
            where.push(`${column} ${sqlCmp} $${params.length}`);
          }
          break;
        case "absent":
          // Absent from the stored proto3 JSON ⇒ the generated column is
          // NULL (rows where the field is set never match, including "").
          where.push(`${column} IS NULL`);
          break;
      }
    }
    return where;
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
