/**
 * Hearing data access. The dated stream of hearings IS the case diary;
 * the range and unrecorded views feed the home pulse. Hearing writes move
 * the case's derived next_hearing_date, so every mutation invalidates
 * BOTH prefixes — a stale case row lying about its next date is exactly
 * the drift the state discipline forbids.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Hearing,
  HearingSchema,
  type HearingSpec,
  HearingSpecSchema,
  type RecordOutcomeRequestSchema,
} from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";

function invalidateHearingViews(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["hearings"] });
  void queryClient.invalidateQueries({ queryKey: ["cases"] });
}

/** The day board: hearings in [dateFrom, dateTo], both ends inclusive. */
export function useHearingsInRange(dateFrom: string, dateTo: string) {
  const { hearings } = useApiClients();
  return useQuery({
    queryKey: ["hearings", "range", dateFrom, dateTo],
    queryFn: () => hearings.list({ dateFrom, dateTo, pageSize: 100 }),
  });
}

/** The nag list: past hearings still awaiting an outcome (FR-HEAR-005). */
export function useUnrecordedHearings() {
  const { hearings } = useApiClients();
  return useQuery({
    queryKey: ["hearings", "unrecorded"],
    queryFn: () => hearings.list({ unrecordedOnly: true, pageSize: 100 }),
  });
}

/**
 * The diary (FR-HEAR-003): the server orders ascending; the diary reads
 * newest first, so the page reverses client-side — presentation order,
 * not a recomputed fact (the gen contract's own note).
 */
export function useCaseDiary(caseId: string, page: number) {
  const { hearings } = useApiClients();
  return useQuery({
    queryKey: ["hearings", "diary", caseId, page],
    queryFn: async () => {
      const res = await hearings.list({
        caseId,
        pageSize: PAGE_SIZE,
        pageOffset: page * PAGE_SIZE,
      });
      return { items: [...res.items].reverse(), totalCount: res.totalCount };
    },
  });
}

export function useScheduleHearing() {
  const { hearings } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: HearingSpec) => hearings.create(create(HearingSchema, { spec })),
    onSuccess: () => invalidateHearingViews(queryClient),
  });
}

/** Full-spec replacement; the server refuses once an outcome is recorded. */
export function useUpdateHearing() {
  const { hearings } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly existing: Hearing; readonly spec: HearingSpec }) =>
      hearings.update(
        create(HearingSchema, { metadata: input.existing.metadata, spec: input.spec }),
      ),
    onSuccess: () => invalidateHearingViews(queryClient),
  });
}

/**
 * Record what happened (J3). A next date auto-schedules the next hearing
 * in the same operation — the response carries both.
 */
export function useRecordOutcome() {
  const { hearings } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MessageInitShape<typeof RecordOutcomeRequestSchema>) =>
      hearings.recordOutcome(input),
    onSuccess: () => invalidateHearingViews(queryClient),
  });
}

export { HearingSpecSchema };
