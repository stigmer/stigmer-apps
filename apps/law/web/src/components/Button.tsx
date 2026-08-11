/**
 * The app's one button vocabulary (T03 kit). Four intents, one compact
 * size (h-8 — the console's density; still above the WCAG 2.5.8 24px
 * target minimum):
 *
 *   - "primary": the screen's main affirmative act (submit, New case).
 *   - "ghost":   quiet actions and cancels — counsel blue, no fill.
 *   - "outline": neutral administrative acts (reset access, reactivate).
 *   - "danger":  destructive or removing acts — red, no fill until hover.
 *
 * ButtonLink is the same vocabulary for router links that act as
 * buttons ("New task" → /tasks/new); visual sameness is deliberate, the
 * element stays semantically a link.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

export type ButtonVariant = "primary" | "ghost" | "outline" | "danger";

const BASE = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-card px-3 text-sm font-medium";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-strong disabled:opacity-60",
  ghost: "text-brand hover:bg-brand-surface disabled:text-ink-faint disabled:hover:bg-transparent",
  outline: "border border-line hover:bg-brand-surface disabled:opacity-60",
  danger: "text-danger hover:bg-danger-surface",
};

export function buttonClass(variant: ButtonVariant = "ghost"): string {
  return `${BASE} ${VARIANT[variant]}`;
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant },
) {
  const { variant = "ghost", className: _ignored, type, ...rest } = props;
  // The default type is "button": a stray un-typed button inside a form
  // must never submit it by accident. Submits say type="submit".
  return <button type={type ?? "button"} className={buttonClass(variant)} {...rest} />;
}

export function ButtonLink(props: LinkProps & { variant?: ButtonVariant; children: ReactNode }) {
  const { variant = "ghost", className: _ignored, ...rest } = props;
  return <Link className={buttonClass(variant)} {...rest} />;
}
