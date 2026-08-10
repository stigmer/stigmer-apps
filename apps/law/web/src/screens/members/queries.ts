/**
 * The firm roster (FirmMemberService.List) — the app's ONE person
 * directory. Every person reference in the law resources is a FirmMember
 * id, and the envelope's audit fields carry User ids that FirmMember
 * profiles map back to names; both lookups live here. The roster is a
 * small bounded set the pickers need in full, so this is the sanctioned
 * multiple-page fetch (the same justification the old user directory
 * carried).
 */

import { useQuery } from "@tanstack/react-query";
import { useApiClients } from "../../api/clients.js";
import type { FirmMember } from "../../gen/stigmer/law/firmmember/v1/firmmember_pb.js";

const ROSTER_PAGE_SIZE = 100; // the contract's page cap

export interface FirmRoster {
  /** Active members, in the server's order: seniority, then name. */
  readonly members: readonly FirmMember[];
  /** Display name for a FirmMember id; the id itself when unknown. */
  nameOf(memberId: string): string;
  /** Display name for a User id (envelope audit fields); the id when unknown. */
  nameOfUser(userId: string): string;
}

function buildRoster(members: readonly FirmMember[]): FirmRoster {
  const byId = new Map(members.map((m) => [m.metadata?.id ?? "", m]));
  const byUserId = new Map(members.map((m) => [m.spec?.userId ?? "", m]));
  const nameOfMember = (member: FirmMember | undefined, fallback: string) =>
    member?.status?.userName || member?.status?.userEmail || fallback;
  return {
    members,
    nameOf(memberId) {
      return nameOfMember(byId.get(memberId), memberId);
    },
    nameOfUser(userId) {
      return nameOfMember(byUserId.get(userId), userId);
    },
  };
}

export function useFirmRoster() {
  const { firmMembers } = useApiClients();
  return useQuery({
    queryKey: ["members", "roster"],
    // People change rarely; pickers should not refetch on every mount.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<FirmRoster> => {
      const all: FirmMember[] = [];
      for (let offset = 0; ; offset += ROSTER_PAGE_SIZE) {
        const page = await firmMembers.list({
          pageSize: ROSTER_PAGE_SIZE,
          pageOffset: offset,
        });
        all.push(...page.items);
        if (all.length >= Number(page.totalCount) || page.items.length === 0) {
          break;
        }
      }
      return buildRoster(all);
    },
  });
}
