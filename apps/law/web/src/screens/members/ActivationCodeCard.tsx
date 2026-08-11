/**
 * The shown-once activation code (DD-003 D4). The server stores only a
 * hash, so this render IS the code's one appearance — the card says so
 * and makes the hand-over easy (copy button; the code travels to the
 * member in person or over WhatsApp, never through this system).
 */

import { useState } from "react";
import type { IssuedActivation } from "./mutations.js";

export function ActivationCodeCard(props: { issued: IssuedActivation; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const days = Math.round(props.issued.expiresInSeconds / 86_400);

  async function onCopy() {
    await navigator.clipboard.writeText(props.issued.code);
    setCopied(true);
  }

  return (
    <section
      role="status"
      aria-label="Activation code issued"
      className="mb-4 rounded-card border border-line bg-warn-surface p-4"
    >
      <h2 className="mb-1 font-medium">Activation code for {props.issued.email}</h2>
      <p className="mb-2 text-sm text-ink-muted">
        Share it with them directly — in person or on WhatsApp. It works once, expires in{" "}
        {days} day{days === 1 ? "" : "s"}, and will not be shown again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-card border border-line bg-surface px-3 py-2 font-mono text-sm">
          {props.issued.code}
        </code>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="h-11 rounded-card border border-line px-3 text-sm font-medium hover:bg-brand-surface"
        >
          {copied ? "Copied" : "Copy code"}
        </button>
        <button
          type="button"
          onClick={props.onDismiss}
          className="h-11 rounded-card px-3 text-sm text-ink-muted hover:text-ink"
        >
          Done
        </button>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        They set their own password at <span className="font-medium">{window.location.origin}/activate</span>
      </p>
    </section>
  );
}
