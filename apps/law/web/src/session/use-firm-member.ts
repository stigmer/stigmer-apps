/**
 * The caller's firm profile, resolved once beside the session: every
 * signed-in person maps to exactly one FirmMember (the policy's own
 * lookup, by user id), and the ROLE on that profile is what decides
 * which surfaces the shell offers — money and history for partners,
 * nothing extra for everyone else. The server stays the authority; this
 * hook only lets the UI hide what would be refused anyway.
 */

import { useQuery } from "@tanstack/react-query";
import { useApiClients } from "../api/clients.js";
import {
  FirmRole,
  type FirmMember,
} from "../gen/stigmer/law/firmmember/v1/firmmember_pb.js";
import { useCurrentUser } from "./use-session.js";

/** Partner-level roles — the money/history visibility line (FR-AUTHZ-004). */
export function isPartnerRole(role: FirmRole | undefined): boolean {
  return role === FirmRole.MANAGING_PARTNER || role === FirmRole.PARTNER;
}

export function useFirmMember() {
  const user = useCurrentUser();
  const userId = user.metadata?.id ?? "";
  const { firmMembers } = useApiClients();
  return useQuery({
    queryKey: ["members", "me", userId],
    // The caller's own role changes rarely; a sign-out/in refreshes it.
    staleTime: 5 * 60 * 1000,
    queryFn: (): Promise<FirmMember> => firmMembers.get({ userId }),
  });
}

/** The caller's role, once loaded — undefined while resolving. */
export function useMyRole(): FirmRole | undefined {
  return useFirmMember().data?.spec?.role;
}
