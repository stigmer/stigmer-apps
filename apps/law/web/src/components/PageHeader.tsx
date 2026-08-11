/**
 * Every screen's opening line (T03 kit): the h1 and the screen's primary
 * action(s) on one row. Keeping the h1 here keeps the page hierarchy
 * honest — one h1 per screen, always the same weight.
 */

import type { ReactNode } from "react";

export function PageHeader(props: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-lg font-semibold">{props.title}</h1>
      {props.children && <div className="flex items-center gap-2">{props.children}</div>}
    </div>
  );
}
