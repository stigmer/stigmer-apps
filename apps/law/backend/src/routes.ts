import type { ConnectRouter } from "@connectrpc/connect";
import type pg from "pg";
import { PingService } from "./gen/lawfirm/ping/v1/ping_pb.js";

export interface RouteDeps {
  readonly pool: pg.Pool;
}

/**
 * Registers every Connect service this backend serves. Dependencies are
 * explicit arguments (never module state) so tests can build routes against
 * their own pool.
 */
export function buildRoutes(deps: RouteDeps): (router: ConnectRouter) => void {
  return (router) => {
    // THROWAWAY (Stage A toolchain proof) — replaced by real resource
    // services when Case lands.
    router.service(PingService, {
      async ping(req) {
        // A data-modifying CTE is not visible to the outer SELECT's
        // snapshot, so count(*) sees only pre-insert rows; +1 accounts for
        // the row this statement inserts. One statement, no race window.
        const result = await deps.pool.query<{ total: string }>(
          `WITH inserted AS (INSERT INTO pings (label) VALUES ($1))
           SELECT count(*) + 1 AS total FROM pings`,
          [req.label],
        );
        return {
          label: req.label,
          // int64 fields are bigint in protobuf-es; count(*) arrives as a
          // string from pg because it exceeds JS number range in general.
          totalPings: BigInt(result.rows[0]?.total ?? "1"),
        };
      },
    });
  };
}
