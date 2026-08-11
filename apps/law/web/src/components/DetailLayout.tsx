/**
 * The detail-page frame (DD-005): the story of one thing beside the
 * facts about it — primary content (description, conversation, tabs) in
 * a reading column, a context rail on the right holding what the reader
 * must not lose while scrolling (status, dates, people, actions). List
 * screens deliberately do NOT use this: a rail with nothing real to say
 * is dead space with a border around it.
 *
 * The two-column split is a CONTAINER query, not a viewport one: the
 * shell's content wrapper is the @container, so the layout answers to
 * the width the content actually has — including when the docked Ask AI
 * panel takes its share. The owner's rule (DD-007 amendment): opening
 * the panel must NOT reflow the page into a different design — both
 * columns simply get narrower and the text wraps. So the rail FLEXES
 * (13–20rem) and the columns stack only under 36rem of content width,
 * where two columns physically stop being legible — in practice only
 * the small-screen sheet case, which overlays instead of squeezing.
 *
 * The column rule lives in app.css as `.law-detail-columns`, NOT as
 * Tailwind's grid-cols utilities: the SDK's lazily-loaded stylesheet
 * re-declares those utility names unscoped and would flip this exact
 * base+variant pair the moment Ask AI first opens (see app.css).
 *
 * The rail is an <aside> landmark so assistive tech can jump between
 * the story and the facts. When the columns do stack, rail follows
 * main — the facts are one swipe away, never lost.
 */

import type { ReactNode } from "react";

export function DetailLayout(props: { children: ReactNode; rail: ReactNode; railLabel: string }) {
  return (
    <div className="law-detail-columns grid items-start gap-4">
      <div className="min-w-0">{props.children}</div>
      <aside aria-label={props.railLabel} className="flex min-w-0 flex-col gap-4">
        {props.rail}
      </aside>
    </div>
  );
}
