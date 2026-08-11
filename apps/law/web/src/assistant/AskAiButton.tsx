/**
 * The shell's Ask AI affordance + the panel's lazy host. Both are
 * SDK-free (main-bundle safe): the button renders only when the
 * deployment HAS an assistant (config read — enabled:false or a failed
 * read means no affordance, the honest open-source posture), and the
 * host fetches the heavy assistant chunk only on the FIRST open — never
 * at shell mount. After that it stays mounted so a closed-and-reopened
 * panel resumes the conversation it was on.
 */

import { lazy, Suspense, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "../components/Button.js";
import { useAssistant } from "./assistant-context.js";
import { useAssistantConfig } from "./queries.js";

const AssistantPanel = lazy(() => import("./AssistantPanel.js"));

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

export function AssistantHost() {
  const { open } = useAssistant();
  const [everOpened, setEverOpened] = useState(false);
  if (open && !everOpened) setEverOpened(true);
  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <AssistantPanel />
    </Suspense>
  );
}
