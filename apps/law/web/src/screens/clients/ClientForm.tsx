/**
 * The client spec form — one component for create and edit (full-spec
 * replacement, so every field appears). Phones are contact details for
 * humans to dial, deliberately free-form — the strict E.164 binding is
 * the STAFF WhatsApp identity on User, never a client field.
 */

import { useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { Button } from "../../components/Button.js";
import { FormCard, FormError, Input, Label, Select, TextArea } from "../../components/Field.js";
import {
  ClientKind,
  type ClientSpec,
} from "../../gen/stigmer/law/client/v1/client_pb.js";
import { clientKindLabel } from "../../lib/format.js";
import { ClientSpecSchema } from "./queries.js";

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
    <FormCard onSubmit={(e) => void onSubmit(e)} aria-label="Client details">
      <Label htmlFor="client-name">Name</Label>
      <Input
        id="client-name"
        required
        maxLength={200}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Person or company, as the firm knows them"
      />

      <Label htmlFor="client-kind">Kind</Label>
      <Select
        id="client-kind"
        value={kind}
        onChange={(e) => setKind(Number(e.target.value) as ClientKind)}
      >
        <option value={ClientKind.INDIVIDUAL}>{clientKindLabel(ClientKind.INDIVIDUAL)}</option>
        <option value={ClientKind.ORGANIZATION}>
          {clientKindLabel(ClientKind.ORGANIZATION)}
        </option>
      </Select>

      <Label htmlFor="client-phones">
        Phones{" "}
        <span className="font-normal text-ink-muted">
          (comma-separated — one client, many numbers)
        </span>
      </Label>
      <Input id="client-phones" value={phones} onChange={(e) => setPhones(e.target.value)} />

      <Label htmlFor="client-email">
        Email <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input
        id="client-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Label htmlFor="client-address">
        Address <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input id="client-address" value={address} onChange={(e) => setAddress(e.target.value)} />

      <Label htmlFor="client-notes">
        Notes <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <TextArea
        id="client-notes"
        rows={2}
        maxLength={5000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <FormError message={error} />

      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={props.pending}>
          {props.pending ? "Saving…" : props.submitLabel}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </FormCard>
  );
}
