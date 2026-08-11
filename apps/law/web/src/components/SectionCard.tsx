/**
 * A titled card section (T03 kit — promoted from Home, where the pattern
 * proved itself): the container for a group of facts or rows inside a
 * screen. tone="warn" is the nag treatment — an amber border that says
 * "this section is why you're here" without shouting.
 */

import type { ReactNode } from "react";

export function SectionCard(props: { title: string; tone?: "warn"; children: ReactNode }) {
  return (
    <section
      aria-label={props.title}
      className={`rounded-card border bg-surface p-4 ${
        props.tone === "warn" ? "border-warn" : "border-line"
      }`}
    >
      <h2 className="mb-2 text-sm font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

/** The card used by forms and detail bodies — same surface, no title
 * row, padding for reading rather than scanning. */
export function CardSurface(props: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-line bg-surface p-4 ${props.className ?? ""}`}>
      {props.children}
    </div>
  );
}
