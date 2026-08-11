/**
 * The list-card pattern (T03 kit): a bordered surface of rows, each row
 * one Link that reads as a flat line of facts — primary fact first
 * (font-medium), meta after (muted), chips last. Every list screen and
 * every Home section renders through these two; density and hover live
 * here exactly once.
 */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function ListCard(props: { children: ReactNode; "aria-label"?: string }) {
  return (
    <ul aria-label={props["aria-label"]} className="rounded-card border border-line bg-surface">
      {props.children}
    </ul>
  );
}

/** A linked row. When `to` is omitted the row is a plain line (roster
 * entries, read-only listings) with the same layout and density. */
export function ListRow(props: { to?: string; children: ReactNode }) {
  const layout = "flex min-h-9 flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5";
  return (
    <li className="border-b border-line last:border-b-0">
      {props.to ? (
        <Link to={props.to} className={`${layout} hover:bg-brand-surface`}>
          {props.children}
        </Link>
      ) : (
        <div className={layout}>{props.children}</div>
      )}
    </li>
  );
}

/** The row's primary fact: what the eye scans the list by. */
export function RowTitle(props: { children: ReactNode; grow?: boolean }) {
  return (
    <span className={`font-medium${props.grow ? " flex-1 basis-48" : ""}`}>{props.children}</span>
  );
}

/** Supporting facts on a row — quiet, one visual level down. */
export function RowMeta(props: { children: ReactNode; faint?: boolean; grow?: boolean }) {
  return (
    <span
      className={`text-xs ${props.faint ? "text-ink-faint" : "text-ink-muted"}${
        props.grow ? " flex-1 basis-48" : ""
      }`}
    >
      {props.children}
    </span>
  );
}
