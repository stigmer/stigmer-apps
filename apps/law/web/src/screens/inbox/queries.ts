/**
 * Notification data access (FR-NOTIF-004). The unread badge is EXACTLY
 * `list(unread_only, page_size: 1).total_count` — the proto's own recipe,
 * derived server-side, never a client-side count over a fetched list. The
 * list is always the caller's own (recipient-scoped server-side, not a
 * client option), newest first.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClients } from "../../api/clients.js";
import { PAGE_SIZE } from "../../lib/contract.js";

export function useInbox(page: number) {
  const { notifications } = useApiClients();
  return useQuery({
    queryKey: ["notifications", "list", page],
    queryFn: () =>
      notifications.list({ pageSize: PAGE_SIZE, pageOffset: page * PAGE_SIZE }),
  });
}

export function useUnreadCount() {
  const { notifications } = useApiClients();
  return useQuery({
    queryKey: ["notifications", "unreadCount"],
    queryFn: async () => {
      const res = await notifications.list({ unreadOnly: true, pageSize: 1 });
      return Number(res.totalCount);
    },
    // The badge is ambient chrome: keep it honest without hammering the
    // server — mutations invalidate it immediately, this covers changes
    // that happen elsewhere (another tab, the WhatsApp surface later).
    refetchInterval: 30_000,
  });
}

export function useMarkRead() {
  const { notifications } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notifications.markRead({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllRead() {
  const { notifications } = useApiClients();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // The RPC is bounded to one page per call ("callers with more
      // unread call again" — the proto contract), so loop to done.
      for (;;) {
        const res = await notifications.markAllRead({});
        if (res.markedCount === 0) break;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
