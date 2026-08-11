/**
 * The panel's home: start a conversation, or pick up a recent one.
 *
 * The composer is the app's own (kit-styled, lawyer-plain) rather than
 * the SDK's launcher organism, for two deliberate reasons:
 *
 * 1. The bootstrap must pin what the SDK's launcher would let a person
 *    change: `harness: "cursor"` (WhatsApp's engine — same tools, same
 *    model tier, same billing; the platform default is a DIFFERENT
 *    engine) and the org-visible AgentInstance whose environment refs
 *    deliver the MCP secret. Neither is a lawyer decision.
 * 2. The contextual entries ("Ask about this matter") seed prefill text
 *    and standing session context — knobs the launcher does not expose.
 *
 * Everything AFTER the first message rides the SDK's SessionViewer.
 */

import { useState, type FormEvent } from "react";
import { ArrowUp, MessageSquareText } from "lucide-react";
import { useCreateAgentExecution, useSessionList } from "@stigmer/react";
import { Button } from "../components/Button.js";
import type { GetAssistantConfigResponse } from "../gen/stigmer/law/assistant/v1/assistant_pb.js";
import type { AssistantSeed } from "./assistant-context.js";
import { CreditNotice } from "./CreditNotice.js";
import type { Stigmer } from "@stigmer/sdk";

export function NewConversationView(props: {
  stigmer: Stigmer;
  config: GetAssistantConfigResponse;
  seed: AssistantSeed | undefined;
  onConversationStarted(sessionId: string): void;
}) {
  const { create, isCreating, error } = useCreateAgentExecution();
  const [draft, setDraft] = useState(props.seed?.prefill ?? "");
  const recent = useSessionList({ pageSize: 10 });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || isCreating) return;
    const result = await create({
      org: props.config.org,
      message,
      sessionSpec: {
        agentInstanceId: props.config.agentInstanceId,
        // The engine pin (see the module doc). A session's engine is
        // immutable after its first turn, so HERE is the only chance.
        harness: "cursor",
        ...(props.seed?.context ? { sessionContext: props.seed.context } : {}),
      },
    });
    props.onConversationStarted(result.sessionId);
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <CreditNotice
        stigmer={props.stigmer}
        org={props.config.org}
        consoleUrl={props.config.consoleUrl}
      />

      <form onSubmit={(e) => void onSubmit(e)} aria-label="Ask the assistant">
        <label htmlFor="assistant-draft" className="mb-1.5 block text-sm font-medium">
          What do you need?
        </label>
        <div className="rounded-card border border-line bg-surface focus-within:border-brand">
          <textarea
            id="assistant-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={3}
            autoFocus
            placeholder="e.g. What's on my board today? or What happened last on CS/2026/041?"
            className="block w-full resize-none bg-transparent p-3 text-sm outline-none placeholder:text-ink-faint"
          />
          <div className="flex justify-end p-2 pt-0">
            <Button type="submit" variant="primary" disabled={!draft.trim() || isCreating}>
              {isCreating ? "Starting…" : "Ask"}
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            The assistant couldn't start this conversation. Try again — if it keeps
            failing, tell your administrator. ({error.message})
          </p>
        )}
      </form>

      {recent.sessions.length > 0 && (
        <section aria-label="Recent conversations">
          <h3 className="mb-1.5 text-sm font-medium text-ink-muted">Recent conversations</h3>
          <ul className="flex flex-col">
            {recent.sessions.map((session) => {
              const id = session.metadata?.id;
              if (!id) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => props.onConversationStarted(id)}
                    className="flex w-full items-center gap-2 rounded-card px-2 py-1.5 text-left text-sm hover:bg-brand-surface"
                  >
                    <MessageSquareText
                      className="size-4 shrink-0 text-ink-faint"
                      aria-hidden="true"
                    />
                    <span className="truncate">
                      {session.spec?.subject || "Conversation"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
