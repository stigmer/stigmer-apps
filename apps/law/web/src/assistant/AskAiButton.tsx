/**
 * The Ask AI entry affordances — SDK-free (main-bundle safe), rendered
 * only when the deployment HAS an assistant (config read — enabled:false
 * or a failed read means no affordance, the honest open-source posture).
 * Both simply drive the controller; the dock (AssistantDock) owns the
 * panel chrome and the lazy loading of everything platform-flavored.
 */

import { Sparkles } from "lucide-react";
import { Button } from "../components/Button.js";
import { useAssistant } from "./assistant-context.js";
import { useAssistantConfig } from "./queries.js";

export function AskAiButton() {
  const config = useAssistantConfig();
  const { openAssistant } = useAssistant();
  if (!config.data?.enabled) return null;
  return (
    <button
      type="button"
      onClick={() => openAssistant()}
      className="flex h-8 items-center gap-2 rounded-card px-2 text-sm font-medium text-brand hover:bg-brand-surface"
    >
      <Sparkles className="size-4" aria-hidden="true" />
      Ask AI
    </button>
  );
}

/**
 * The contextual entry on a matter's page: opens the panel with the
 * file number pre-typed (the vocabulary the agent's tools take) and
 * stamps the conversation's standing context with where it began.
 */
export function AskAiAboutCaseButton(props: { fileNumber: string }) {
  const config = useAssistantConfig();
  const { openAssistant } = useAssistant();
  if (!config.data?.enabled || !props.fileNumber) return null;
  return (
    <Button
      onClick={() =>
        openAssistant({
          prefill: `About ${props.fileNumber}: `,
          context: `This conversation was started from the web page of case ${props.fileNumber}.`,
        })
      }
    >
      <Sparkles className="size-4" aria-hidden="true" />
      Ask AI about this matter
    </Button>
  );
}
