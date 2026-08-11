/**
 * The Ask AI conversation body — the app's ONLY surface that touches the
 * agent platform from the browser, and its first lazily-loaded chunk:
 * the platform SDK (and this file's stylesheet imports) must never weigh
 * the case list. Default export for React.lazy; the dock (main-bundle
 * chrome) mounts it on the first expand and keeps it mounted.
 *
 * The conversation renders the SDK's organisms with the END-USER
 * audience — the preset for a product-embedded chat where the agent is
 * configured upstream: the agent stays locked, and the lawyer gets the
 * model picker, Agent/Plan mode, and attachments (owner decision,
 * 2026-08-11, superseding the launch-time guest presentation).
 * Workspaces stay off (`enableGitHub` false, no local folders) — a
 * lawyer has no repository to mount. Authorization is untouched either
 * way: the audience is presentation; the token and the firm's policy
 * module decide what actually runs.
 *
 * The platform token rides a mint-on-use source: nothing is minted (and
 * nobody is JIT-provisioned platform-side) until this chunk loads with
 * the first expand.
 */

import { useMemo } from "react";
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

export default function AssistantConversation() {
  const { view, seed, seedKey, showConversation } = useAssistant();
  const clients = useApiClients();
  const config = useAssistantConfig().data;

  const stigmer = useMemo(
    () => (config?.enabled ? createAssistantStigmer(config, clients) : undefined),
    [config, clients],
  );

  // The dock only exists when the assistant is configured; the config
  // (and therefore the client) is settled before anyone can expand it.
  if (!config?.enabled || !stigmer) return null;

  return (
    <StigmerProvider client={stigmer}>
      {view.kind === "new" ? (
        // Keyed on the seed: a seeded open resets the view in the
        // controller AND remounts the composer here, so an identical
        // prefill still re-applies.
        <NewConversationView
          key={seedKey}
          stigmer={stigmer}
          config={config}
          seed={seed}
          onConversationStarted={showConversation}
        />
      ) : (
        <SessionViewer
          sessionId={view.sessionId}
          org={config.org}
          audience="endUser"
          enableGitHub={false}
          className="h-full"
        />
      )}
    </StigmerProvider>
  );
}
