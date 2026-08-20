/**
 * The ONE citation-identity form block (DD-012 D2), shared by every
 * surface that captures or corrects a shelf entry's identity: the
 * Library front door, the case citing flow's upload arm, the
 * Documents tab's promote form, and the shelf's edit-in-place. One
 * markup means the screens cannot drift apart (the disconnect the
 * owner caught: the citing flow's upload arm had grown a thinner form
 * than the front door's).
 *
 * Optionality is stated ON the labels: the case name is REQUIRED in
 * the web — a shelf entry named after a PDF helps nobody (the
 * PromoteForm rule, now everywhere) — while court, year, and citation
 * say "(optional)" so nobody stalls on facts they don't have.
 * (WhatsApp filings may still arrive title-less; the server's
 * file-name fallback and the mutable entry cover that door.)
 *
 * Layout: margin-less InlineInput columns inside one wrapping
 * items-end row, so a trailing action (the front door's file button)
 * bottom-aligns with the input boxes — Input's built-in mb-4 was
 * exactly the misalignment the owner saw.
 */

import type { ReactNode } from "react";
import { InlineInput, Label } from "../../components/Field.js";

/** The identity as typed (year stays text until submit — an input's
 * truth is its text; the caller parses on send). */
export interface CitationIdentityDraft {
  readonly title: string;
  readonly court: string;
  readonly year: string;
  readonly citation: string;
}

export const EMPTY_IDENTITY: CitationIdentityDraft = {
  title: "",
  court: "",
  year: "",
  citation: "",
};

export function CitationIdentityFields(props: {
  /** Prefixes the field ids so two forms can coexist on one page. */
  idPrefix: string;
  value: CitationIdentityDraft;
  onChange: (next: CitationIdentityDraft) => void;
  /** Trailing flex items (e.g. the front door's file button),
   * bottom-aligned with the inputs. */
  children?: ReactNode;
}) {
  const { idPrefix, value, onChange } = props;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <Label htmlFor={`${idPrefix}-title`}>Case name (as the firm cites it)</Label>
        <InlineInput
          id={`${idPrefix}-title`}
          required
          maxLength={300}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="Arnesh Kumar vs State of Bihar"
          className="w-full"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <Label htmlFor={`${idPrefix}-court`}>Court (optional)</Label>
        <InlineInput
          id={`${idPrefix}-court`}
          maxLength={200}
          value={value.court}
          onChange={(e) => onChange({ ...value, court: e.target.value })}
          className="w-full"
        />
      </div>
      <div className="w-24">
        <Label htmlFor={`${idPrefix}-year`}>Year (optional)</Label>
        <InlineInput
          id={`${idPrefix}-year`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          value={value.year}
          onChange={(e) => onChange({ ...value, year: e.target.value })}
          className="w-full"
        />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <Label htmlFor={`${idPrefix}-citation`}>Citation (optional)</Label>
        <InlineInput
          id={`${idPrefix}-citation`}
          maxLength={200}
          value={value.citation}
          onChange={(e) => onChange({ ...value, citation: e.target.value })}
          placeholder="AIR 2014 SC 2756"
          className="w-full"
        />
      </div>
      {props.children}
    </div>
  );
}
