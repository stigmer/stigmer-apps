/**
 * Lead materialization (Gate-1 refinement): the lead lawyer is ALSO an
 * active CaseMember, maintained here — so "my cases" and every policy
 * membership check read ONE fact, and "lead OR member" (an OR the
 * closed filter vocabulary deliberately lacks) never needs expressing.
 *
 * Runs on Case created/updated as the system principal through the full
 * create pipeline (DD-A4). Idempotency comes from the membership
 * natural key (active periods only): an existing ACTIVE membership
 * short-circuits; a lapsed one (lead A → B → A with a removal between)
 * simply gets a new period — the invariant "the lead is a member" wins.
 * A duplicate create loses the race to ALREADY_EXISTS and is fine.
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallerPrincipal, InProcessEventDispatcher } from "@stigmer/resource-api";
import { SYSTEM_PRINCIPAL } from "@stigmer/resource-api";
import type { Case } from "../../gen/stigmer/law/case/v1/case_pb.js";
import {
  CaseMemberSchema,
  RoleOnCase,
  type CaseMember,
} from "../../gen/stigmer/law/casemember/v1/casemember_pb.js";
import { membershipKey } from "../casemember/casemember-resource.js";
import type { ResourceStore } from "@stigmer/resource-api";

export function registerLeadMembershipHandler(
  dispatcher: InProcessEventDispatcher,
  store: ResourceStore,
  createMembership: (input: CaseMember, caller: CallerPrincipal) => Promise<CaseMember>,
): void {
  dispatcher.subscribe("Case", async (event) => {
    const theCase = event.resource as Case;
    const caseId = theCase.metadata?.id;
    const leadId = theCase.spec?.leadLawyerId;
    if (!caseId || !leadId) return;

    // Active periods only (the adapters' key semantics): a live
    // membership short-circuits; a lapsed one gets a fresh period below.
    const existing = (await store.getByNaturalKey(
      "CaseMember",
      membershipKey(caseId, leadId),
    )) as CaseMember | undefined;
    if (existing) {
      return;
    }

    try {
      await createMembership(
        create(CaseMemberSchema, {
          spec: { caseId, memberId: leadId, roleOnCase: RoleOnCase.LAWYER },
        }),
        SYSTEM_PRINCIPAL,
      );
    } catch (err) {
      if (ConnectError.from(err).code === Code.AlreadyExists) {
        return; // lost a benign race to another writer — the fact exists
      }
      throw err; // dispatcher contains and logs; the case write stands
    }
  });
}
