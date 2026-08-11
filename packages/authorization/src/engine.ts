/**
 * The authorization engine — the narrow surface apps consult and the
 * reconciler maintains. Four verbs: check one relationship, list the
 * objects a user holds a relation to, write/delete tuples, read every
 * tuple back. Deliberately NOT a policy interface: the commons answers
 * relationship questions; deciding which question an operation asks is
 * each app's policy module (DD-A5 — the readable matrix stays in the
 * app; a generic operation→relation mapping is the recorded extraction
 * seam for vertical #2, not built speculatively).
 */

import type { OpenFgaClient } from "@openfga/sdk";
import { type TupleKey } from "./tuples.js";

export interface AuthorizationEngine {
  /** True when `user` holds `relation` on `object` under the model. */
  check(tuple: TupleKey): Promise<boolean>;
  /**
   * Every object of `type` the user holds `relation` to, as full
   * `type:id` references. Callers strip ids with `idOf`. Subject to the
   * server's ListObjects result cap — callers with an "everything"
   * answer available (e.g. an unscoped role) must short-circuit before
   * asking, not enumerate.
   */
  listObjects(user: string, relation: string, type: string): Promise<readonly string[]>;
  /**
   * Apply tuple changes, idempotently: writing a tuple that already
   * exists and deleting one that does not are both successes — the
   * caller declares desired facts, not a transaction script. Any other
   * per-tuple failure throws.
   */
  write(changes: { writes?: readonly TupleKey[]; deletes?: readonly TupleKey[] }): Promise<void>;
  /** Every tuple in the store — the reconciler's "actual" set. */
  readAll(): Promise<readonly TupleKey[]>;
}

/**
 * The server reports both "write of an existing tuple" and "delete of a
 * missing tuple" as validation failures; the message text is the only
 * discriminator the API offers (the error code covers genuinely invalid
 * input too). The stigmer-cloud Java writer classifies the same way.
 */
function isAlreadySettled(message: string): boolean {
  return /already exists|does not exist/i.test(message);
}

interface PerTupleResult {
  readonly tuple_key: { user: string; relation: string; object: string };
  readonly status: string;
  readonly err?: unknown;
}

function failureMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createOpenFgaEngine(client: OpenFgaClient): AuthorizationEngine {
  function assertSettled(results: readonly PerTupleResult[] | undefined, action: string): void {
    for (const result of results ?? []) {
      if (result.status === "CLIENT_WRITE_STATUS_SUCCESS" || result.err === undefined) continue;
      const message = failureMessage(result.err);
      if (isAlreadySettled(message)) continue;
      throw new Error(
        `authorization tuple ${action} failed ` +
          `(${result.tuple_key.user} ${result.tuple_key.relation} ${result.tuple_key.object}): ${message}`,
      );
    }
  }

  return {
    async check(tuple) {
      const response = await client.check({
        user: tuple.user,
        relation: tuple.relation,
        object: tuple.object,
      });
      return response.allowed === true;
    },

    async listObjects(user, relation, type) {
      const response = await client.listObjects({ user, relation, type });
      return response.objects;
    },

    async write({ writes = [], deletes = [] }) {
      if (writes.length === 0 && deletes.length === 0) return;
      // Non-transactional so one already-settled tuple cannot roll back
      // the rest of a batch; idempotency is classified per tuple.
      const response = await client.write(
        {
          writes: writes.map((t) => ({ user: t.user, relation: t.relation, object: t.object })),
          deletes: deletes.map((t) => ({ user: t.user, relation: t.relation, object: t.object })),
        },
        { transaction: { disable: true } },
      );
      assertSettled(response.writes as PerTupleResult[] | undefined, "write");
      assertSettled(response.deletes as PerTupleResult[] | undefined, "delete");
    },

    async readAll() {
      const tuples: TupleKey[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.read({}, { continuationToken });
        for (const item of page.tuples ?? []) {
          const key = item.key;
          if (key?.user && key.relation && key.object) {
            tuples.push({ user: key.user, relation: key.relation, object: key.object });
          }
        }
        continuationToken = page.continuation_token || undefined;
      } while (continuationToken);
      return tuples;
    },
  };
}
