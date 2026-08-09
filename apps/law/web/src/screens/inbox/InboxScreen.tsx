/**
 * The notification inbox (FR-NOTIF-004): newest first, unread visually
 * distinct WITH a word (never color alone — D5), tap = mark read + follow
 * the notification's target (a case or a task — the deep link the
 * producer composed), and mark-all-read. Titles and bodies arrive
 * pre-composed by the producers; the screen renders, never rewrites.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import type { Notification } from "../../gen/stigmer/law/notification/v1/notification_pb.js";
import { formatInstant } from "../../lib/format.js";
import { useInbox, useMarkAllRead, useMarkRead, useUnreadCount } from "./queries.js";

/** The target contract: kind "Case" | "Task" + id → the app's routes. */
function targetPath(notification: Notification): string | undefined {
  const target = notification.spec?.target;
  if (!target?.id) return undefined;
  if (target.kind === "Case") return `/cases/${target.id}`;
  if (target.kind === "Task") return `/tasks/${target.id}`;
  return undefined;
}

export function InboxScreen() {
  const [page, setPage] = useState(0);
  const inbox = useInbox(page);
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const navigate = useNavigate();

  async function onOpen(notification: Notification) {
    const path = targetPath(notification);
    if (!notification.status?.read) {
      // Fire the mark-read and follow the target without waiting on it:
      // a slow write must not delay the navigation the user asked for.
      markRead.mutate(notification.metadata?.id ?? "");
    }
    if (path) navigate(path);
  }

  return (
    <section aria-label="Inbox">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Inbox</h1>
        {(unread.data ?? 0) > 0 && (
          <button
            type="button"
            disabled={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
            className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface disabled:opacity-60"
          >
            {markAllRead.isPending ? "Marking…" : "Mark all as read"}
          </button>
        )}
      </div>

      {inbox.isPending && <Loading label="Loading notifications…" />}
      {inbox.isError && <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />}
      {inbox.isSuccess && inbox.data.items.length === 0 && (
        <EmptyState title="No notifications">
          Task assignments and hearing reminders arrive here.
        </EmptyState>
      )}
      {inbox.isSuccess && inbox.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {inbox.data.items.map((notification) => {
              const isUnread = !notification.status?.read;
              const createdAt = notification.metadata?.createdAt;
              return (
                <li key={notification.metadata?.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void onOpen(notification)}
                    className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-brand-surface"
                  >
                    <span className={isUnread ? "font-semibold" : "text-ink-muted"}>
                      {notification.spec?.title}
                    </span>
                    {isUnread && (
                      <span className="rounded-card bg-brand-surface px-2 py-0.5 text-xs font-medium text-brand">
                        New
                      </span>
                    )}
                    <span className="flex-1 basis-48 text-sm text-ink-muted">
                      {notification.spec?.body}
                    </span>
                    {createdAt && (
                      <span className="text-xs text-ink-faint">
                        {formatInstant(timestampDate(createdAt))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <Pagination page={page} totalCount={Number(inbox.data.totalCount)} onPage={setPage} />
        </>
      )}
    </section>
  );
}
