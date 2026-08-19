/**
 * Money data access (FR-AUTHZ-004: partner-only by policy; the screens
 * that mount these hooks are themselves role-gated). Amounts are integer
 * paise as bigint end to end — nothing here converts to float. The
 * ledger is append-only; balances come from ListOutstanding, never a
 * client-side sum.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type FeeArrangement,
  FeeArrangementSchema,
  type FeeArrangementSpec,
  FeeArrangementSpecSchema,
} from "../../gen/stigmer/law/feearrangement/v1/feearrangement_pb.js";
import {
  LedgerEntrySchema,
  type LedgerEntrySpec,
} from "../../gen/stigmer/law/ledgerentry/v1/ledgerentry_pb.js";

/**
 * A case's fee arrangement — at most one exists; "none yet" is a normal
 * answer (the form starts blank), so NotFound resolves to null instead of
 * surfacing as an error. null, never undefined: TanStack Query rejects a
 * query that resolves undefined ("<key> data is undefined"), so undefined
 * would turn the normal answer back into an error state.
 */
export function useFeeArrangement(caseId: string) {
  const { feeArrangements } = useApiClients();
  return useQuery({
    queryKey: ["money", "fee", caseId],
    queryFn: async (): Promise<FeeArrangement | null> => {
      try {
        return await feeArrangements.get({ caseId });
      } catch (err) {
        if (ConnectError.from(err).code === Code.NotFound) return null;
        throw err;
      }
    },
  });
}

/** Create-or-replace: the form submits the complete desired spec. */
export function useSaveFeeArrangement() {
  const { feeArrangements } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly existing?: FeeArrangement | null;
      readonly spec: FeeArrangementSpec;
    }) =>
      input.existing
        ? feeArrangements.update(
            create(FeeArrangementSchema, { metadata: input.existing.metadata, spec: input.spec }),
          )
        : feeArrangements.create(create(FeeArrangementSchema, { spec: input.spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["money"] }),
  });
}

export function useLedgerEntries(caseId: string, page: number) {
  const { ledgerEntries } = useApiClients();
  return useQuery({
    queryKey: ["money", "ledger", caseId, page],
    queryFn: () =>
      ledgerEntries.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export function useRecordLedgerEntry() {
  const { ledgerEntries } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: LedgerEntrySpec) =>
      ledgerEntries.create(create(LedgerEntrySchema, { spec })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["money"] }),
  });
}

export function useOutstanding(clientId: string, page: number) {
  const { ledgerEntries } = useApiClients();
  return useQuery({
    queryKey: ["money", "outstanding", clientId, page],
    queryFn: () =>
      ledgerEntries.listOutstanding({
        clientId,
        pageSize: PAGE_SIZE,
        pageOffset: page * PAGE_SIZE,
      }),
  });
}

export { FeeArrangementSpecSchema };
