/**
 * The user directory (T04b D10): the firm's people are a small bounded
 * set that the assignee pickers need in full, so the directory pages
 * through User.list once and is cached — the ONE sanctioned
 * multiple-page fetch, justified because the picker itself needs every
 * user (this is not a list screen dodging server pagination).
 */

import { useQuery } from "@tanstack/react-query";
import { useApiClients } from "../../api/clients.js";
import type { User } from "../../gen/stigmer/identity/user/v1/user_pb.js";

const DIRECTORY_PAGE_SIZE = 100; // the contract's page cap

export interface UserDirectory {
  readonly users: readonly User[];
  /** Display name for a user id; the id itself when unknown (never blank). */
  nameOf(id: string): string;
}

function buildDirectory(users: readonly User[]): UserDirectory {
  const byId = new Map(users.map((u) => [u.metadata?.id ?? "", u]));
  return {
    users,
    nameOf(id) {
      const user = byId.get(id);
      return user?.spec?.name || user?.spec?.email || id;
    },
  };
}

export function useUserDirectory() {
  const { users } = useApiClients();
  return useQuery({
    queryKey: ["users", "directory"],
    // People change rarely; pickers should not refetch on every mount.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<UserDirectory> => {
      const all: User[] = [];
      for (let offset = 0; ; offset += DIRECTORY_PAGE_SIZE) {
        const page = await users.list({ pageSize: DIRECTORY_PAGE_SIZE, pageOffset: offset });
        all.push(...page.items);
        if (all.length >= Number(page.totalCount) || page.items.length === 0) {
          break;
        }
      }
      return buildDirectory(all);
    },
  });
}
