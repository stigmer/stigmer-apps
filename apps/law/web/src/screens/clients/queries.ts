/**
 * Client register data access. Search is the register's front door AND
 * the intake conflict check: one RPC answers matched clients and
 * opposing-party hits together (FR-CLIENT-003) — the screens render both,
 * never re-derive either. Everything client-shaped keys under
 * ["clients"], so one prefix invalidation follows any mutation.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Client,
  ClientSchema,
  type ClientSpec,
  ClientSpecSchema,
} from "../../gen/stigmer/law/client/v1/client_pb.js";

export function useClientList(page: number) {
  const { clients } = useApiClients();
  return useQuery({
    queryKey: ["clients", "list", page],
    queryFn: () => clients.list({ pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

/** Search-as-you-type; disabled until there is something to search. */
export function useClientSearch(query: string) {
  const { clients } = useApiClients();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["clients", "search", trimmed],
    queryFn: () => clients.search({ query: trimmed }),
    enabled: trimmed.length > 0,
  });
}

export function useClient(id: string) {
  const { clients } = useApiClients();
  return useQuery({
    queryKey: ["clients", "byId", id],
    queryFn: () => clients.get({ id }),
  });
}

export function useCreateClient() {
  const { clients } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: ClientSpec) => clients.create(create(ClientSchema, { spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

/** Full-spec replacement (D10): callers submit the COMPLETE desired spec. */
export function useUpdateClient() {
  const { clients } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly existing: Client; readonly spec: ClientSpec }) =>
      clients.update(create(ClientSchema, { metadata: input.existing.metadata, spec: input.spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export { ClientSpecSchema };
