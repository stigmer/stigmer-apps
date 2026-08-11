/**
 * The detail-page frame (DD-005): the story of one thing beside the
 * facts about it — primary content (description, conversation, tabs) in
 * a reading column, a context rail on the right holding what the reader
 * must not lose while scrolling (status, dates, people, actions). List
 * screens deliberately do NOT use this: a rail with nothing real to say
 * is dead space with a border around it.
 *
 * The rail is an <aside> landmark so assistive tech can jump between
 * the story and the facts. Below lg the columns stack, rail after main
 * — the facts are one swipe away, never lost.
 */

import type { ReactNode } from "react";

export function DetailLayout(props: { children: ReactNode; rail: ReactNode; railLabel: string }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">{props.children}</div>
      <aside aria-label={props.railLabel} className="flex min-w-0 flex-col gap-4">
        {props.rail}
      </aside>
    </div>
  );
}
