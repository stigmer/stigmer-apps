/**
 * The Ask AI panel controller — deliberately tiny and SDK-free so it can
 * live in the main bundle: the shell and any screen may drive the panel,
 * but everything that touches the agent platform loads lazily inside the
 * panel's conversation body (the app's first code-split boundary — the
 * platform SDK's dependency set must never weigh the case list).
 *
 * The panel has exactly TWO states on a desktop — expanded (docked) or
 * collapsed (the right-edge strip) — and no hidden third: a conversation
 * can always be found again where it visibly went. On small screens the
 * collapsed form renders nothing (the sheet has no strip); the sidebar
 * entry reopens it.
 *
 * Opening may carry a SEED: prefill text the composer starts with (the
 * contextual "Ask AI about this matter" entry), and standing context the
 * created conversation carries on every turn (the platform's
 * session-context mechanism — personalization, never authorization).
 * A seed replaces the panel's view with a fresh composer; plain opens
 * resume wherever the panel last was. The VIEW (composer vs a specific
 * conversation) lives here rather than in the lazy body, so the dock's
 * main-bundle header can offer back/new-conversation and the panel
 * resumes correctly even before the heavy chunk has ever loaded.
 *
 * The dock's width is the app's first PERSISTED piece of UI state (the
 * owner explicitly asked for an adjustable panel — a preference, unlike
 * the sidebar's session-local open state, which stays session-local).
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface AssistantSeed {
  /** Text the new-conversation composer starts with (user-editable). */
  readonly prefill?: string;
  /** Standing per-conversation context the agent sees on every turn. */
  readonly context?: string;
}

export type AssistantView =
  | { readonly kind: "new" }
  | { readonly kind: "conversation"; readonly sessionId: string };

/** Narrower and the SDK composer's toolbar starts wrapping badly. */
export const ASSISTANT_MIN_WIDTH = 320;
/** Wider and the panel stops being a companion and becomes the page. */
export const ASSISTANT_MAX_WIDTH = 640;
export const ASSISTANT_DEFAULT_WIDTH = 448;

const WIDTH_STORAGE_KEY = "law.assistant.width";

/** The panel may never take more than half the window from the work. */
function clampWidth(px: number): number {
  const halfWindow = Math.floor(window.innerWidth / 2);
  return Math.round(
    Math.min(Math.max(px, ASSISTANT_MIN_WIDTH), Math.max(ASSISTANT_MIN_WIDTH, Math.min(ASSISTANT_MAX_WIDTH, halfWindow))),
  );
}

function readStoredWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampWidth(stored);
  } catch {
    // Storage can be unavailable (private browsing); the default is fine.
  }
  return ASSISTANT_DEFAULT_WIDTH;
}

function storeWidth(px: number): void {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(px));
  } catch {
    // Same boundary: a preference that cannot persist is not an error.
  }
}

interface AssistantPanelState {
  readonly expanded: boolean;
  /** The seed of the most recent seeded open; consumed by the composer. */
  readonly seed?: AssistantSeed;
  /** Bumps on every seeded open, so an identical seed still re-seeds. */
  readonly seedKey: number;
  /** What the panel body shows: the composer, or one conversation. */
  readonly view: AssistantView;
}

interface AssistantPanelController extends AssistantPanelState {
  /** The docked panel's width in px (already clamped). */
  readonly width: number;
  openAssistant(seed?: AssistantSeed): void;
  closeAssistant(): void;
  /** Clamps, applies, and persists — the resize handle's single verb. */
  setWidth(px: number): void;
  showConversation(sessionId: string): void;
  showNewConversation(): void;
}

const AssistantContext = createContext<AssistantPanelController | undefined>(undefined);

export function AssistantProvider(props: { children: ReactNode }) {
  const [state, setState] = useState<AssistantPanelState>({
    expanded: false,
    seedKey: 0,
    view: { kind: "new" },
  });
  const [width, setWidthState] = useState(readStoredWidth);

  const openAssistant = useCallback((seed?: AssistantSeed) => {
    setState((prev) => ({
      expanded: true,
      seed: seed ?? prev.seed,
      seedKey: seed ? prev.seedKey + 1 : prev.seedKey,
      // A seeded open re-homes the panel on a fresh composer carrying
      // the seed; a plain open resumes wherever the panel last was.
      view: seed ? { kind: "new" } : prev.view,
    }));
  }, []);
  const closeAssistant = useCallback(() => {
    setState((prev) => ({ ...prev, expanded: false }));
  }, []);
  const setWidth = useCallback((px: number) => {
    const clamped = clampWidth(px);
    setWidthState(clamped);
    storeWidth(clamped);
  }, []);
  const showConversation = useCallback((sessionId: string) => {
    setState((prev) => ({ ...prev, view: { kind: "conversation", sessionId } }));
  }, []);
  const showNewConversation = useCallback(() => {
    setState((prev) => ({ ...prev, view: { kind: "new" } }));
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      width,
      openAssistant,
      closeAssistant,
      setWidth,
      showConversation,
      showNewConversation,
    }),
    [state, width, openAssistant, closeAssistant, setWidth, showConversation, showNewConversation],
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
