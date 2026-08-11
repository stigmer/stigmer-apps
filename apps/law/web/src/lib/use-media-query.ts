/**
 * A LIVE viewport predicate. The shell reads `window.matchMedia` once at
 * mount — enough for the sidebar, whose desktop/overlay dual mode is
 * pure CSS. The assistant dock cannot do that: its docked-vs-sheet split
 * changes DOM semantics (dialog role, Escape handling, backdrop), which
 * CSS cannot switch, so the component must re-render when the window
 * crosses the breakpoint mid-session.
 */

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
