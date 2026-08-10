/**
 * The other half of the stored-derived next-hearing fact (Gate-1 Q6):
 * hearing writes refresh the case row. The handler performs a system
 * UPDATE of the case with its own current spec — the update pipeline's
 * recompute-next-hearing step (the fact's single writer) does the actual
 * math, so this handler carries no derivation logic to drift.
 *
 * Self-healing by construction: the step recomputes FROM the hearings
 * table, so a lost event leaves a stale value only until the next
 * hearing or case write. The recorded race (save has no version check;
 * a user update can interleave) is bounded the same way — the next
 * write recomputes from source (T04_0 §5 Q6, owner-accepted).
 */

import type { CallerPrincipal, InProcessEventDispatcher } from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import type { ResourceStore } from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import type { Hearing } from "../../gen/stigmer/law/hearing/v1/hearing_pb.js";

export function registerNextHearingRefreshHandler(
  dispatcher: InProcessEventDispatcher,
  store: ResourceStore,
  updateCase: (input: Case, caller: CallerPrincipal) => Promise<Case>,
): void {
  dispatcher.subscribe("Hearing", async (event) => {
    const caseId = (event.resource as Hearing).spec?.caseId;
    if (!caseId) return;
    const theCase = (await store.getById("Case", caseId)) as Case | undefined;
    if (!theCase) return; // reference checks make this unreachable; stay quiet
    // Same spec in, recomputed status out. The system principal is
    // allowed exactly this operation (the policy's named system seam).
    await updateCase(theCase, SYSTEM_PRINCIPAL);
  });
}
