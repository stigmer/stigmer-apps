/**
 * The Ask AI slide-over — the app's ONLY surface that touches the agent
 * platform from the browser, and its first lazily-loaded chunk: the
 * platform SDK (and this file's stylesheet imports) must never weigh
 * the case list. Default export for React.lazy.
 *
 * The conversation itself is the SDK's SessionViewer with the GUEST
 * audience — chosen deliberately over "endUser": guest is the pure-chat
 * presentation (no model picker, no engine picker, no workspaces — no
 * engineering vocabulary in front of a lawyer), and the SDK documents
 * it as covering org members chatting through an embedding product,
 * not only anonymous visitors. Authorization is untouched either way:
 * the audience is presentation; the token and the firm's policy module
 * decide what actually runs.
 *
 * The platform token rides a mint-on-use source: nothing is minted (and
 * nobody is JIT-provisioned platform-side) until this panel is opened.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, SquarePen, X } from "lucide-react";
import { Stigmer } from "@stigmer/sdk";
import { SessionViewer, StigmerProvider } from "@stigmer/react";
import "@stigmer/react/styles.css";
import "./assistant.css";
import { useApiClients, type ApiClients } from "../api/clients.js";
import type { GetAssistantConfigResponse } from "../gen/stigmer/law/assistant/v1/assistant_pb.js";
import { useAssistant } from "./assistant-context.js";
import { NewConversationView } from "./NewConversationView.js";
import { useAssistantConfig } from "./queries.js";
import { createTokenSource } from "./token-source.js";

type PanelView = { kind: "new" } | { kind: "conversation"; sessionId: string };

function createAssistantStigmer(
  config: GetAssistantConfigResponse,
  clients: ApiClients,
): Stigmer {
  const tokens = createTokenSource(() => clients.assistant.mintToken({}));
  return new Stigmer({
    baseUrl: config.apiBaseUrl,
    getAccessToken: () => tokens.get(),
    // A platform 401 means the cached token went bad before its clock
    // did — drop it; the next request mints fresh through the backend.
    onUnauthenticated: () => tokens.invalidate(),
  });
}

export default function AssistantPanel() {
  const { open, seed, seedKey, closeAssistant } = useAssistant();
  const clients = useApiClients();
  const queryClient = useQueryClient();
  const config = useAssistantConfig().data;

  const stigmer = useMemo(
    () => (config?.enabled ? createAssistantStigmer(config, clients) : undefined),
    [config, clients],
  );

  const [view, setView] = useState<PanelView>({ kind: "new" });
  // A seeded open re-homes the panel on a fresh composer carrying the
  // seed; the key remount is what re-applies an identical prefill.
  const [consumedSeedKey, setConsumedSeedKey] = useState(seedKey);
  if (seedKey !== consumedSeedKey) {
    setConsumedSeedKey(seedKey);
    setView({ kind: "new" });
  }

  // The shell only offers the button when the assistant exists; the
  // config (and therefore the client) is settled before anyone can open
  // the panel, so this renders nothing only while closed.
  if (!open || !config?.enabled || !stigmer) return null;

  function startNewConversation() {
    setView({ kind: "new" });
    // A finished conversation should appear in "recent" immediately.
    void queryClient.invalidateQueries({ queryKey: ["assistant"] });
  }

  return (
    <>
      {/* Below lg the panel overlays the content; the backdrop is the
          tap-anywhere way back out (the sidebar's own pattern). */}
      <div
        aria-hidden="true"
        onClick={closeAssistant}
        className="fixed inset-0 z-40 bg-ink/20 lg:hidden"
      />
      <aside
        role="dialog"
        aria-label="Ask AI"
        className="law-assistant fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-lg"
        onKeyDown={(e) => {
          if (e.key === "Escape") closeAssistant();
        }}
      >
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
            aria-label="Close Ask AI"
            className="flex size-8 items-center justify-center rounded-card text-ink-muted hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1">
          <StigmerProvider client={stigmer}>
            {view.kind === "new" ? (
              <NewConversationView
                key={consumedSeedKey}
                stigmer={stigmer}
                config={config}
                seed={seed}
                onConversationStarted={(sessionId) =>
                  setView({ kind: "conversation", sessionId })
                }
              />
            ) : (
              <SessionViewer
                sessionId={view.sessionId}
                org={config.org}
                audience="guest"
                className="h-full"
              />
            )}
          </StigmerProvider>
        </div>
      </aside>
    </>
  );
}
