/**
 * The Ask AI panel controller — deliberately tiny and SDK-free so it can
 * live in the main bundle: the shell and any screen may open the panel,
 * but everything that touches the agent platform loads lazily inside the
 * panel itself (the app's first code-split boundary — the platform SDK's
 * dependency set must never weigh the case list).
 *
 * Opening may carry a SEED: prefill text the composer starts with (the
 * contextual "Ask AI about this matter" entry), and standing context the
 * created conversation carries on every turn (the platform's
 * session-context mechanism — personalization, never authorization).
 * A seed replaces the panel's view with a fresh composer; plain opens
 * resume wherever the panel last was.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface AssistantSeed {
  /** Text the new-conversation composer starts with (user-editable). */
  readonly prefill?: string;
  /** Standing per-conversation context the agent sees on every turn. */
  readonly context?: string;
}

interface AssistantPanelState {
  readonly open: boolean;
  /** The seed of the most recent seeded open; consumed by the panel. */
  readonly seed?: AssistantSeed;
  /** Bumps on every seeded open, so an identical seed still re-seeds. */
  readonly seedKey: number;
}

interface AssistantPanelController extends AssistantPanelState {
  openAssistant(seed?: AssistantSeed): void;
  closeAssistant(): void;
}

const AssistantContext = createContext<AssistantPanelController | undefined>(undefined);

export function AssistantProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<AssistantPanelState>({ open: false, seedKey: 0 });

  const openAssistant = useCallback((seed?: AssistantSeed) => {
    setState((prev) => ({
      open: true,
      seed: seed ?? prev.seed,
      seedKey: seed ? prev.seedKey + 1 : prev.seedKey,
    }));
  }, []);
  const closeAssistant = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const value = useMemo(
    () => ({ ...state, openAssistant, closeAssistant }),
    [state, openAssistant, closeAssistant],
  );
  return <AssistantContext.Provider value={value}>{props.children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantPanelController {
  const controller = useContext(AssistantContext);
  if (!controller) {
    throw new Error("useAssistant must be used within <AssistantProvider> (the app shell mounts it)");
  }
  return controller;
}
