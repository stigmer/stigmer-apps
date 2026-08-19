/**
 * Deadline data access. Overdue is a SERVER fact (computed in the firm's
 * timezone); state moves ONLY through UpdateStatus. Deadlines render on
 * the home pulse and inside a case, so mutations invalidate both the
 * ["deadlines"] views and the case prefix (open_deadline_count is a
 * derived case fact).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";
import {
  type Deadline,
  DeadlineSchema,
  type DeadlineSpec,
  DeadlineSpecSchema,
  type DeadlineState,
} from "../../gen/stigmer/law/deadline/v1/deadline_pb.js";

function invalidateDeadlineViews(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["deadlines"] });
  void queryClient.invalidateQueries({ queryKey: ["cases"] });
}

/** The pulse's "my open deadlines through <date>" — overdue included. */
export function useMyOpenDeadlines(dueTo: string) {
  const { deadlines } = useApiClients();
  return useQuery({
    queryKey: ["deadlines", "mine", dueTo],
    queryFn: () => deadlines.list({ mine: true, openOnly: true, dueTo, pageSize: 100 }),
  });
}

/** The day's story (FR-HEAR-007): deadlines entered on this firm
 * calendar day, newest first. */
export function useDeadlinesEnteredOn(day: string) {
  const { deadlines } = useApiClients();
  return useQuery({
    queryKey: ["deadlines", "enteredOn", day],
    queryFn: () => deadlines.list({ enteredOn: day, pageSize: 20 }),
  });
}

export function useCaseDeadlines(caseId: string, page: number) {
  const { deadlines } = useApiClients();
  return useQuery({
    queryKey: ["deadlines", "byCase", caseId, page],
    queryFn: () =>
      deadlines.list({ caseId, pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export function useCreateDeadline() {
  const { deadlines } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (spec: DeadlineSpec) => deadlines.create(create(DeadlineSchema, { spec })),
    onSuccess: () => invalidateDeadlineViews(queryClient),
  });
}

/** Full-spec replacement (D10): callers submit the COMPLETE desired spec. */
export function useUpdateDeadline() {
  const { deadlines } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly existing: Deadline; readonly spec: DeadlineSpec }) =>
      deadlines.update(
        create(DeadlineSchema, { metadata: input.existing.metadata, spec: input.spec }),
      ),
    onSuccess: () => invalidateDeadlineViews(queryClient),
  });
}

/** State's ONLY write path: open → met/missed/withdrawn (and back). */
export function useUpdateDeadlineState() {
  const { deadlines } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly id: string; readonly state: DeadlineState }) =>
      deadlines.updateStatus({ id: input.id, state: input.state }),
    onSuccess: () => invalidateDeadlineViews(queryClient),
  });
}

export { DeadlineSpecSchema };
