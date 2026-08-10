/**
 * The client spec form — one component for create and edit (full-spec
 * replacement, so every field appears). Phones are contact details for
 * humans to dial, deliberately free-form — the strict E.164 binding is
 * the STAFF WhatsApp identity on User, never a client field.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import {
  ClientKind,
  type ClientSpec,
} from "../../gen/stigmer/law/client/v1/client_pb.js";
import { clientKindLabel } from "../../lib/format.js";
import { ClientSpecSchema } from "./queries.js";

const field = "mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3";
const label = "mb-1 block text-sm font-medium";

export function ClientForm(props: {
  initial?: ClientSpec;
  submitLabel: string;
  pending: boolean;
  onSubmit: (spec: ClientSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(props.initial?.displayName ?? "");
  const [kind, setKind] = useState<ClientKind>(
    props.initial?.clientKind ?? ClientKind.INDIVIDUAL,
  );
  const [phones, setPhones] = useState((props.initial?.phones ?? []).join(", "));
  const [email, setEmail] = useState(props.initial?.email ?? "");
  const [address, setAddress] = useState(props.initial?.address ?? "");
  const [notes, setNotes] = useState(props.initial?.notes ?? "");
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await props.onSubmit(
        create(ClientSpecSchema, {
          displayName: displayName.trim(),
          clientKind: kind,
          phones: phones
            .split(",")
            .map((phone) => phone.trim())
            .filter(Boolean),
          email: email.trim(),
          address: address.trim(),
          notes: notes.trim(),
        }),
      );
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Client details"
      className="rounded-card border border-line bg-surface p-6"
    >
      <label htmlFor="client-name" className={label}>
        Name
      </label>
      <input
        id="client-name"
        required
        maxLength={200}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Person or company, as the firm knows them"
        className={field}
      />

      <label htmlFor="client-kind" className={label}>
        Kind
      </label>
      <select
        id="client-kind"
        value={kind}
        onChange={(e) => setKind(Number(e.target.value) as ClientKind)}
        className={field}
      >
        <option value={ClientKind.INDIVIDUAL}>{clientKindLabel(ClientKind.INDIVIDUAL)}</option>
        <option value={ClientKind.ORGANIZATION}>
          {clientKindLabel(ClientKind.ORGANIZATION)}
        </option>
      </select>

      <label htmlFor="client-phones" className={label}>
        Phones <span className="font-normal text-ink-muted">(comma-separated — one client, many numbers)</span>
      </label>
      <input
        id="client-phones"
        value={phones}
        onChange={(e) => setPhones(e.target.value)}
        className={field}
      />

      <label htmlFor="client-email" className={label}>
        Email <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input
        id="client-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={field}
      />

      <label htmlFor="client-address" className={label}>
        Address <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <input
        id="client-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        className={field}
      />

      <label htmlFor="client-notes" className={label}>
        Notes <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <textarea
        id="client-notes"
        rows={2}
        maxLength={5000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="mb-4 block w-full rounded-card border border-line bg-surface px-3 py-2"
      />

      {error && (
        <p role="alert" className="mb-4 rounded-card bg-danger-surface px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={props.pending}
          className="h-11 rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong disabled:opacity-60"
        >
          {props.pending ? "Saving…" : props.submitLabel}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-11 rounded-card px-4 text-brand hover:bg-brand-surface"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
