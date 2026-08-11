/**
 * The detail-page frame (DD-005): the story of one thing beside the
 * facts about it — primary content (description, conversation, tabs) in
 * a reading column, a context rail on the right holding what the reader
 * must not lose while scrolling (status, dates, people, actions). List
 * screens deliberately do NOT use this: a rail with nothing real to say
 * is dead space with a border around it.
 *
 * The two-column split is a CONTAINER query, not a viewport one: the
 * shell's content wrapper is the @container, so the rail sits beside
 * the story whenever the content area itself is wide enough — and wraps
 * below it when a narrow window OR the docked Ask AI panel genuinely
 * squeezes the room. A viewport breakpoint cannot know about the dock.
 * Threshold: at 48rem the reading column keeps ≥ ~27rem beside the
 * 20rem rail — below that, side-by-side helps neither column.
 *
 * The rail is an <aside> landmark so assistive tech can jump between
 * the story and the facts. When the columns stack, rail follows main —
 * the facts are one swipe away, never lost.
 */

import type { ReactNode } from "react";

export function DetailLayout(props: { children: ReactNode; rail: ReactNode; railLabel: string }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">{props.children}</div>
      <aside aria-label={props.railLabel} className="flex min-w-0 flex-col gap-4">
        {props.rail}
      </aside>
    </div>
  );
}
