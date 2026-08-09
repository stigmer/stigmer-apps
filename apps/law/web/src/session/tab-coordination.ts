/**
 * Cross-tab session coordination (T04b D4).
 *
 * Why this exists: refresh tokens are strictly one-time-use with an
 * atomic revoke-ALL-sessions response to reuse
 * (packages/identity/src/refresh-token.ts, DD-005 D6), and the refresh
 * cookie is shared by every tab of the browser. Two tabs refreshing
 * concurrently therefore look exactly like a stolen token being replayed
 * — the second arrival would end every session the user has. The Web
 * Locks API serializes refreshes across same-origin tabs (it exists for
 * precisely this class of problem), and BroadcastChannel shares the
 * outcome so sibling tabs adopt the fresh access token instead of
 * rotating again.
 *
 * The seam is injectable so the session kit's unit tests can simulate
 * multiple tabs deterministically (memoryCoordinationHub below).
 */

export type SessionBroadcast =
  | { readonly type: "token"; readonly accessToken: string; readonly expiresAtMs: number }
  | { readonly type: "signed-out"; readonly notice?: string };

export interface TabCoordination {
  /** Runs fn while holding the origin-wide refresh lock. */
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
  broadcast(message: SessionBroadcast): void;
  subscribe(listener: (message: SessionBroadcast) => void): () => void;
}

const LOCK_NAME = "law-session-refresh";
const CHANNEL_NAME = "law-session";

export function browserTabCoordination(): TabCoordination {
  // Fallbacks keep a museum-piece browser single-tab-correct rather than
  // broken: without locks, refreshes serialize within the tab only.
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const channel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : undefined;
  let inTabChain: Promise<unknown> = Promise.resolve();

  return {
    withRefreshLock(fn) {
      if (locks) {
        return locks.request(LOCK_NAME, fn) as Promise<ReturnType<typeof fn> extends Promise<infer T> ? T : never>;
      }
      const run = inTabChain.then(fn, fn);
      inTabChain = run.catch(() => undefined);
      return run;
    },
    broadcast(message) {
      channel?.postMessage(message);
    },
    subscribe(listener) {
      if (!channel) return () => undefined;
      const handler = (event: MessageEvent) => listener(event.data as SessionBroadcast);
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
  };
}

/**
 * Test double: one hub = one browser; each memoryTabCoordination(hub) = one
 * tab. The lock is a real mutex (queued acquisition), and broadcasts
 * deliver to every OTHER tab on the hub — the BroadcastChannel contract.
 */
export interface MemoryCoordinationHub {
  attach(): TabCoordination;
}

export function memoryCoordinationHub(): MemoryCoordinationHub {
  let lockChain: Promise<unknown> = Promise.resolve();
  const tabs: Array<{ listeners: Set<(m: SessionBroadcast) => void> }> = [];

  return {
    attach() {
      const tab = { listeners: new Set<(m: SessionBroadcast) => void>() };
      tabs.push(tab);
      return {
        withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
          const run = lockChain.then(fn, fn);
          lockChain = run.catch(() => undefined);
          return run;
        },
        broadcast(message) {
          for (const other of tabs) {
            if (other === tab) continue;
            for (const listener of other.listeners) listener(message);
          }
        },
        subscribe(listener) {
          tab.listeners.add(listener);
          return () => tab.listeners.delete(listener);
        },
      };
    },
  };
}
