/**
 * The three async states every screen must design, not default (the
 * 003_web_engineer failure-path rule): loading, error-with-a-way-forward,
 * and empty-with-orientation. Screens compose these; none invents its own
 * spinner or bare "something went wrong".
 */

import { ConnectError } from "@connectrpc/connect";
import type { ReactNode } from "react";

export function Loading(props: { label: string }) {
  return (
    <p role="status" aria-busy="true" className="py-8 text-center text-ink-muted">
      {props.label}
    </p>
  );
}

/**
 * Server sentences are the error UX (the uniform error contract names
 * the resource and value); this component adds only the way forward.
 */
export function ErrorState(props: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card bg-danger-surface px-4 py-3 text-sm">
      <p className="text-danger">{ConnectError.from(props.error).rawMessage}</p>
      {props.onRetry && (
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-2 h-11 rounded-card px-3 font-medium text-brand hover:bg-brand-surface"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line px-4 py-8 text-center">
      <p className="font-medium">{props.title}</p>
      {props.children && <div className="mt-1 text-sm text-ink-muted">{props.children}</div>}
    </div>
  );
}
