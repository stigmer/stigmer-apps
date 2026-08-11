/**
 * Form vocabulary (T03 kit): Label + Input/Select/TextArea render every
 * control the same compact way, and FormError renders a form's inline
 * failure exactly once (server sentences verbatim — the uniform error
 * contract; the component adds only the role and the tone).
 *
 * These forward all native props: screens keep ids, autoComplete,
 * required, placeholders — the kit owns only the look.
 */

import type {
  FormHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const CONTROL = "block h-8 w-full rounded-card border border-line bg-surface px-2.5 text-sm";

/** The card every form sits on — one reading-width surface. */
export function FormCard(props: FormHTMLAttributes<HTMLFormElement>) {
  const { className: _ignored, ...rest } = props;
  return <form className="max-w-2xl rounded-card border border-line bg-surface p-4" {...rest} />;
}

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>) {
  const { className: _ignored, ...rest } = props;
  return <label className="mb-1 block text-sm font-medium" {...rest} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className: _ignored, ...rest } = props;
  return <input className={`mb-4 ${CONTROL}`} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className: _ignored, ...rest } = props;
  return <select className={`mb-4 ${CONTROL}`} {...rest} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className: _ignored, ...rest } = props;
  return <textarea className="mb-4 block w-full rounded-card border border-line bg-surface px-2.5 py-1.5 text-sm" {...rest} />;
}

/** Bare (margin-less) controls for inline compositions — filter bars,
 * rows that lay controls out themselves. Their className is APPENDED for
 * layout (flex-1, widths); the look itself stays here. */
export function InlineInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return (
    <input
      className={`h-8 rounded-card border border-line bg-surface px-2.5 text-sm ${className ?? ""}`}
      {...rest}
    />
  );
}

export function InlineSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return (
    <select
      className={`h-8 rounded-card border border-line bg-surface px-2 text-sm ${className ?? ""}`}
      {...rest}
    />
  );
}

/** Renders nothing until there is a message — screens call it
 * unconditionally and let the state decide. */
export function FormError(props: { message: string | undefined }) {
  if (!props.message) return null;
  return (
    <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
      {props.message}
    </p>
  );
}
