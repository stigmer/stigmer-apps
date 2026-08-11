/**
 * Status chips (T03 kit). Tone carries meaning the same way everywhere:
 * brand = live/active states, warn = needs attention (overdue task,
 * disposed matter), danger = hard alarm (missed deadline), neutral =
 * closed/inert. Color never carries meaning alone (D5): the chip's text
 * says the state in words.
 */

import type { ReactNode } from "react";

export type BadgeTone = "brand" | "warn" | "danger" | "neutral";

const TONE: Record<BadgeTone, string> = {
  brand: "bg-brand-surface font-medium text-brand",
  warn: "bg-warn-surface font-medium text-warn",
  danger: "bg-danger-surface font-medium text-danger",
  neutral: "text-ink-faint",
};

export function Badge(props: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`rounded-card px-2 py-0.5 text-xs ${TONE[props.tone ?? "brand"]}`}>
      {props.children}
    </span>
  );
}
