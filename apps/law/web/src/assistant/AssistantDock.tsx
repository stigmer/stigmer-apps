/**
 * The Ask AI dock — the panel's SDK-free chrome, in the main bundle.
 *
 * On a desktop the dock is a flex sibling of the content column with two
 * states: EXPANDED (a resizable docked panel the content reflows around
 * — never an overlay hiding the very record the lawyer is asking about)
 * or COLLAPSED (a slim right-edge strip whose chevron reopens it — the
 * entry point is visible on every screen). Below lg there is no room to
 * dock: the panel becomes a full-height sheet with a backdrop, and the
 * collapsed form renders nothing (the sidebar entry reopens it).
 *
 * Docked-vs-sheet is a LIVE split with DOM consequences, not just CSS:
 * the sheet is a dialog (backdrop, Escape closes); the docked panel is a
 * plain aside landmark — part of the page, where Escape must keep its
 * meaning inside the SDK's menus and composer. Hence useMediaQuery.
 *
 * Only the CHROME lives here. The conversation body — everything that
 * touches the platform SDK — is the lazily-loaded AssistantConversation,
 * fetched on the first expand and then kept mounted (hidden, not
 * unmounted, while collapsed) so reopening resumes the conversation,
 * scroll position and minted token included.
 */

import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ChevronsLeft, ChevronsRight, Sparkles, SquarePen, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loading } from "../components/async.js";
import { useMediaQuery } from "../lib/use-media-query.js";
import {
  ASSISTANT_MAX_WIDTH,
  ASSISTANT_MIN_WIDTH,
  useAssistant,
} from "./assistant-context.js";
import { useAssistantConfig } from "./queries.js";

const AssistantConversation = lazy(() => import("./AssistantConversation.js"));

const DESKTOP = "(min-width: 1024px)";
const KEYBOARD_RESIZE_STEP = 16;

export function AssistantDock() {
  const config = useAssistantConfig();
  const { expanded, view, width, setWidth, openAssistant, closeAssistant, showNewConversation } =
    useAssistant();
  const desktop = useMediaQuery(DESKTOP);
  const queryClient = useQueryClient();

  // The heavy chunk loads on the FIRST expand — never at shell mount —
  // and stays mounted (hidden) afterwards so collapse/expand resumes.
  const [everExpanded, setEverExpanded] = useState(false);
  if (expanded && !everExpanded) setEverExpanded(true);

  // Collapsing hands focus to the strip's chevron; expanding hands it to
  // the panel (the composer takes it from there). Only on TRANSITIONS —
  // mount must never steal focus from the screen the user is reading.
  const panelRef = useRef<HTMLElement>(null);
  const stripButtonRef = useRef<HTMLButtonElement>(null);
  const previousExpanded = useRef(expanded);
  /** One drag in flight at most: where it started, at what width. */
  const dragFrom = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    if (previousExpanded.current === expanded) return;
    previousExpanded.current = expanded;
    if (expanded) panelRef.current?.focus();
    else stripButtonRef.current?.focus();
  }, [expanded]);

  // No assistant configured (the open-source posture) — no dock at all.
  if (!config.data?.enabled) return null;

  function startNewConversation() {
    showNewConversation();
    // A finished conversation should appear in "recent" immediately.
    void queryClient.invalidateQueries({ queryKey: ["assistant"] });
  }

  /** The sheet is a dialog; only there may Escape mean "close". */
  function onSheetKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") closeAssistant();
  }

  return (
    <>
      {desktop && !expanded && (
        <div className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-line bg-surface py-2">
          <button
            ref={stripButtonRef}
            type="button"
            onClick={() => openAssistant()}
            aria-label="Open Ask AI"
            aria-expanded={false}
            title="Ask AI"
            className="flex size-7 items-center justify-center rounded-card text-ink-muted hover:bg-brand-surface hover:text-brand"
          >
            <ChevronsLeft className="size-4" aria-hidden="true" />
          </button>
          <Sparkles className="size-4 text-brand" aria-hidden="true" />
        </div>
      )}

      {/* Below lg the sheet overlays the content; the backdrop is the
          tap-anywhere way back out (the sidebar's own pattern). */}
      {!desktop && expanded && (
        <div
          aria-hidden="true"
          onClick={closeAssistant}
          className="fixed inset-0 z-40 bg-ink/20"
        />
      )}

      {/* Nothing enters the DOM before the first expand. From then on,
          collapsed = hidden, not unmounted: the conversation (and its
          minted token) survives, so expanding again resumes in place.
          The hidden ATTRIBUTE carries the semantics (and what jsdom
          tests observe); the class is the belt in real browsers. */}
      {everExpanded && (
        <aside
          ref={panelRef}
          tabIndex={-1}
          role={desktop ? undefined : "dialog"}
          aria-label="Ask AI"
          hidden={!expanded}
          style={desktop && expanded ? { width } : undefined}
          onKeyDown={desktop ? undefined : onSheetKeyDown}
          className={
            expanded
              ? "law-assistant relative flex shrink-0 flex-col border-l border-line bg-surface outline-none " +
                "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:w-full max-lg:max-w-xl max-lg:shadow-lg"
              : "hidden"
          }
        >
          {desktop && expanded && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the Ask AI panel"
              aria-valuenow={width}
              aria-valuemin={ASSISTANT_MIN_WIDTH}
              aria-valuemax={ASSISTANT_MAX_WIDTH}
              tabIndex={0}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                dragFrom.current = { startX: e.clientX, startWidth: width };
              }}
              onPointerMove={(e) => {
                if (!dragFrom.current) return;
                // The handle is the panel's LEFT edge: dragging left widens.
                setWidth(dragFrom.current.startWidth + (dragFrom.current.startX - e.clientX));
              }}
              onPointerUp={() => {
                dragFrom.current = null;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  setWidth(width + KEYBOARD_RESIZE_STEP);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  setWidth(width - KEYBOARD_RESIZE_STEP);
                }
              }}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none hover:bg-brand/20 focus-visible:bg-brand/20"
            />
          )}

          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
            {view.kind === "conversation" && (
              <button
                type="button"
                onClick={startNewConversation}
                aria-label="Back to conversations"
                className="flex size-8 items-center justify-center rounded-card text-ink-muted hover:text-ink"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </button>
            )}
            <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">Ask AI</h2>
            {view.kind === "conversation" && (
              <button
                type="button"
                onClick={startNewConversation}
                aria-label="New conversation"
                title="New conversation"
                className="flex size-8 items-center justify-center rounded-card text-ink-muted hover:text-ink"
              >
                <SquarePen className="size-4" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={closeAssistant}
              aria-label={desktop ? "Collapse Ask AI" : "Close Ask AI"}
              aria-expanded={desktop ? true : undefined}
              className="flex size-8 items-center justify-center rounded-card text-ink-muted hover:text-ink"
            >
              {desktop ? (
                <ChevronsRight className="size-4" aria-hidden="true" />
              ) : (
                <X className="size-4" aria-hidden="true" />
              )}
            </button>
          </header>

          <div className="min-h-0 flex-1">
            <Suspense fallback={<Loading label="Opening Ask AI…" />}>
              <AssistantConversation />
            </Suspense>
          </div>
        </aside>
      )}
    </>
  );
}
