/**
 * The context rail's fact vocabulary (DD-005): one card of label/value
 * rows. Values are nodes, not strings, on purpose — a fact may be a
 * link, a badge, or a live control (the status select), and the planned
 * per-field inline editing (DD-005's named follow-up) will change only
 * what screens pass in, never this component.
 *
 * The optional footer anchors the panel's actions (Edit) to the facts
 * they act on — the exact adjacency the old full-width header row broke.
 */

import type { ReactNode } from "react";

export function MetaPanel(props: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <dl className="flex flex-col gap-3">{props.children}</dl>
      {props.footer && <div className="mt-4 border-t border-line pt-3">{props.footer}</div>}
    </div>
  );
}

export function MetaItem(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{props.label}</dt>
      <dd className="mt-0.5">{props.children}</dd>
    </div>
  );
}
