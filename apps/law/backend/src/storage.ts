/**
 * The storage registry: one PostgresResourceStore configured with every
 * resource kind's table mapping. Each kind's table, generated columns, and
 * indexes live in its migration file (backend/migrations) — this registry
 * must mirror those migrations exactly, and the integration tests run
 * against the real migrations, so a mismatch cannot survive its first test
 * run. T03 adds the remaining six kinds here.
 */

import type pg from "pg";
import type { ResourceStore } from "@stigmer/resource-api";
import { PostgresResourceStore } from "@stigmer/resource-api/postgres";
import { CaseSchema } from "./gen/stigmer/lawfirm/case/v1/case_pb.js";

export function createResourceStore(pool: pg.Pool): ResourceStore {
  return new PostgresResourceStore(pool, {
    Case: {
      schema: CaseSchema,
      table: "cases",
      naturalKey: { column: "case_number", jsonField: "caseNumber" },
      columns: {
        nextHearingDate: "next_hearing_date",
      },
    },
  });
}
