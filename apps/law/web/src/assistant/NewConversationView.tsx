/**
 * The panel's home: start a conversation, or pick up a recent one.
 *
 * The composer is the SDK's SessionComposer — the same organism the
 * follow-up turns use — configured to the firm's presentation: the
 * model picker, Agent/Plan mode, and attachments face the lawyer
 * (owner decision, 2026-08-11); the engine and agent do NOT. Two pins
 * happen at submit, in the bootstrap this view owns:
 *
 * 1. `harness: "cursor"` (WhatsApp's engine — same tools, same model
 *    tier, same billing; the platform default is a DIFFERENT engine,
 *    currently broken in production — stigmer/stigmer#437). A session's
 *    engine is immutable after its first turn, so HERE is the only
 *    chance; `showHarnessSelector` stays false because engines are not
 *    a lawyer decision.
 * 2. The org-visible AgentInstance whose environment refs deliver the
 *    MCP secret (`sessionSpec.agentInstanceId`) — the agent is bound at
 *    creation, so the composer needs no agent picker at all.
 *
 * The contextual entries ("Ask about this matter") seed prefill text
 * (through the composer's imperative handle — the view is remounted per
 * seed) and standing session context — knobs the SDK's launcher
 * organism does not expose, which is why this view exists instead of
 * NewSessionViewer.
 *
 * Everything AFTER the first message rides the SDK's SessionViewer.
 */

import { useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import {
  SessionComposer,
  useCreateAgentExecution,
  useSessionList,
  type InteractionModeOption,
  type SessionComposerHandle,
  type SessionComposerSubmitContext,
} from "@stigmer/react";
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
  const composerRef = useRef<SessionComposerHandle>(null);
  const [interactionMode, setInteractionMode] = useState<InteractionModeOption>("agent");
  const [attachmentProblem, setAttachmentProblem] = useState<string | undefined>();
  const recent = useSessionList({ pageSize: 10 });

  // The seed's prefill, applied once: this view is keyed on the seed
  // (seedKey), so mount IS the seeded moment.
  const prefill = props.seed?.prefill;
  useEffect(() => {
    if (prefill) composerRef.current?.setMessage(prefill);
  }, [prefill]);

  async function onSubmit(
    message: string,
    modelName?: string,
    context?: SessionComposerSubmitContext,
  ) {
    if (isCreating) return;
    const result = await create({
      org: props.config.org,
      message,
      // What the lawyer chose in the composer, verbatim: an untouched
      // model stays undefined (platform default for the pinned engine).
      modelName,
      attachments: context?.attachments,
      interactionMode: context?.interactionMode,
      sessionSpec: {
        agentInstanceId: props.config.agentInstanceId,
        // The engine pin (see the module doc). A session's engine is
        // immutable after its first turn, so HERE is the only chance.
        harness: "cursor",
        // EVERY web conversation says so — the agent's instructions
        // condition their answer shape on this note's presence (its
        // WhatsApp twin is the platform's sender-identity block), so
        // the signal must be positive on both surfaces, never inferred
        // from absence. Contextual entries append where they began.
        sessionContext: ["This conversation is from the firm's web app.", props.seed?.context]
          .filter(Boolean)
          .join(" "),
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

      <section aria-label="Start a conversation">
        <p className="mb-1.5 text-sm font-medium">What do you need?</p>
        <SessionComposer
          ref={composerRef}
          onSubmit={(message, modelName, context) => void onSubmit(message, modelName, context)}
          isSubmitting={isCreating}
          org={props.config.org}
          harness="cursor"
          showHarnessSelector={false}
          showModelSelector
          interactionMode={interactionMode}
          onInteractionModeChange={setInteractionMode}
          showInteractionModePicker
          enableAttachments
          enableFileReferences={false}
          onAttachmentValidationError={setAttachmentProblem}
          autoFocus
          initialRows={3}
          placeholder="e.g. What's on my board today? or What happened last on CS/2026/041?"
          ariaLabel="Ask the assistant"
        />
        {attachmentProblem && (
          <p role="alert" className="mt-2 text-sm text-danger">
            That file can't be attached. {attachmentProblem}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            The assistant couldn't start this conversation. Try again — if it keeps
            failing, tell your administrator. ({error.message})
          </p>
        )}
      </section>

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
