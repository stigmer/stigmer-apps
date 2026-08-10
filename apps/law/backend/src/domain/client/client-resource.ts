/**
 * The Client resource — the relationship anchor (DD-001). Operation
 * matrix: create, update, get, list, search — no delete, no natural key
 * (names collide legitimately).
 *
 * Search is the intake conversation's one box (J4, FR-CLIENT-003): one
 * RPC answers "have we seen this name?" across client names AND
 * opposing-party names — the informal conflict check. It rides the
 * store port's searchText (both halves), so the memory and Postgres
 * answers cannot drift.
 */

import { create } from "@bufbuild/protobuf";
import type {
  AuthorizationPolicy,
  CallerExtractor,
  ResourceEventPublisher,
  ResourceStore,
} from "@stigmer/resource-api";
import {
  createOperation,
  customOperation,
  defineResource,
  getOperation,
  listOperation,
  updateOperation,
} from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  ClientSchema,
  ClientService,
  type Client,
  type GetClientRequest,
  type ListClientsRequest,
  type ListClientsResponse,
  ListClientsResponseSchema,
  OpposingPartyHitSchema,
  type SearchClientsRequest,
  type SearchClientsResponse,
  SearchClientsResponseSchema,
} from "../../gen/stigmer/law/client/v1/client_pb.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

export function clientResource(deps: {
  store: ResourceStore;
  policy: AuthorizationPolicy;
  publisher?: ResourceEventPublisher;
  caller: CallerExtractor;
}) {
  return defineResource({
    definition: {
      kind: "Client",
      apiVersion: "law.stigmer.ai/v1",
      idPrefix: "client",
      schema: ClientSchema,
      store: deps.store,
      policy: deps.policy,
      publisher: deps.publisher,
      caller: deps.caller,
    },
    service: ClientService,
    operations: {
      create: createOperation<Client>(),
      update: updateOperation<Client>(),
      get: getOperation<Client, GetClientRequest>({
        ref: (req) => ({ id: req.id }),
      }),
      list: listOperation<Client, ListClientsRequest, ListClientsResponse>({
        // The register a clerk flips through: alphabetical.
        orderBy: { field: "displayName", direction: "asc", nulls: "last" },
        query: (req) => ({
          pageSize: req.pageSize,
          pageOffset: req.pageOffset,
        }),
        respond: (items, totalCount) =>
          create(ListClientsResponseSchema, { items, totalCount: BigInt(totalCount) }),
      }),
      search: customOperation<Client, SearchClientsRequest, SearchClientsResponse>({
        async handler(ctx) {
          // Scope-level: the register is lawyer-visible (the policy's
          // Client branch); no single resource to load.
          await ctx.authorize();
          const limit = Math.min(
            ctx.input.limit > 0 ? ctx.input.limit : DEFAULT_SEARCH_LIMIT,
            MAX_SEARCH_LIMIT,
          );

          const [clients, casesByParty] = await Promise.all([
            deps.store.searchText("Client", "displayName", ctx.input.query, limit),
            // The other side of the conflict check: opposing-party names
            // rendered from the case's parties array (the registered
            // search expression in the cases migration).
            deps.store.searchText("Case", "opposingPartiesText", ctx.input.query, limit),
          ]);

          // Captions need client names — one bulk lookup, never N+1.
          const cases = casesByParty as readonly Case[];
          const clientIds = [
            ...new Set(cases.map((c) => c.spec?.clientId).filter((id): id is string => !!id)),
          ];
          const caseClients = await deps.store.getByIds("Client", clientIds);

          const needle = ctx.input.query.toLowerCase();
          const hits = cases.map((c) => {
            const matched =
              c.spec?.opposingParties.find((p) => p.name.toLowerCase().includes(needle))
                ?.name ??
              // The rendering matched but no single party name contains
              // the query (e.g. a counsel-name hit): report the first
              // party so the line still reads "A vs B".
              c.spec?.opposingParties[0]?.name ??
              "";
            const clientName =
              (caseClients.get(c.spec?.clientId ?? "") as Client | undefined)?.spec
                ?.displayName ?? "";
            const firstParty = c.spec?.opposingParties[0]?.name ?? "";
            return create(OpposingPartyHitSchema, {
              caseId: c.metadata?.id ?? "",
              fileNumber: c.spec?.fileNumber ?? "",
              matchedPartyName: matched,
              caption: firstParty ? `${clientName} vs ${firstParty}` : clientName,
            });
          });

          return create(SearchClientsResponseSchema, {
            clients: clients as Client[],
            opposingPartyHits: hits,
          });
        },
      }),
    },
  });
}
