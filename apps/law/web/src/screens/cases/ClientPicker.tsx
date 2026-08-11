/**
 * Intake's client control (J4): search as you type, pick a match, or
 * create the client inline without leaving the form. The SAME search
 * answers the conflict check (FR-CLIENT-003): opposing-party hits render
 * beside the client matches with their file numbers, so "have we been
 * against this name?" is answered before the matter is opened — never
 * hidden behind another screen.
 */

import { useState, type FormEvent } from "react";
import { ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { ErrorState, Loading } from "../../components/async.js";
import { Button } from "../../components/Button.js";
import { FormError, Input, Label, Select } from "../../components/Field.js";
import {
  ClientKind,
  type Client,
} from "../../gen/stigmer/law/client/v1/client_pb.js";
import { clientKindLabel } from "../../lib/format.js";
import { ClientSpecSchema, useClientSearch, useCreateClient } from "../clients/queries.js";

export function ClientPicker(props: {
  /** The picked client's display name, when the form already has one (edit). */
  pickedName?: string;
  onPick: (client: Client) => void;
}) {
  const [picked, setPicked] = useState(props.pickedName);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const search = useClientSearch(query);

  function pick(client: Client) {
    setPicked(client.spec?.displayName ?? "");
    setQuery("");
    setCreating(false);
    props.onPick(client);
  }

  if (picked !== undefined) {
    return (
      <div className="mb-4">
        <p className="mb-1 text-sm font-medium">Client</p>
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <span className="font-medium">{picked}</span>
          <Button onClick={() => setPicked(undefined)}>Change client</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <Label htmlFor="case-client-search">Client</Label>
      <Input
        id="case-client-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a name to search the register"
        autoComplete="off"
      />

      {search.isFetching && <Loading label="Searching the register…" />}
      {search.isError && (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
      )}

      {search.isSuccess && (
        <div data-testid="client-search-results">
          {search.data.clients.length > 0 && (
            <ul className="mb-2 rounded-card border border-line bg-surface">
              {search.data.clients.map((client) => (
                <li key={client.metadata?.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => pick(client)}
                    className="flex min-h-9 w-full flex-wrap items-center gap-x-3 px-3 py-1.5 text-left hover:bg-brand-surface"
                  >
                    <span className="font-medium">{client.spec?.displayName}</span>
                    <span className="text-xs text-ink-muted">
                      {clientKindLabel(client.spec?.clientKind ?? ClientKind.UNSPECIFIED)}
                    </span>
                    {client.spec?.phones[0] && (
                      <span className="text-xs text-ink-faint">{client.spec.phones[0]}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {search.data.opposingPartyHits.length > 0 && (
            <div
              role="note"
              data-testid="conflict-check"
              className="mb-2 rounded-card bg-warn-surface px-3 py-2 text-sm"
            >
              <p className="font-medium text-warn">
                Conflict check: this name appears on the other side
              </p>
              <ul>
                {search.data.opposingPartyHits.map((hit) => (
                  <li key={`${hit.caseId}-${hit.matchedPartyName}`} className="mt-1">
                    <span className="font-medium">{hit.matchedPartyName}</span> is an opposing
                    party in {hit.fileNumber} ({hit.caption})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {search.data.clients.length === 0 &&
            search.data.opposingPartyHits.length === 0 && (
              <p className="mb-2 text-sm text-ink-muted">
                No one in the register matches "{query.trim()}".
              </p>
            )}
        </div>
      )}

      {creating ? (
        <InlineClientCreate initialName={query.trim()} onCreated={pick} onCancel={() => setCreating(false)} />
      ) : (
        <Button onClick={() => setCreating(true)}>Add a new client</Button>
      )}
    </div>
  );
}

function InlineClientCreate(props: {
  initialName: string;
  onCreated: (client: Client) => void;
  onCancel: () => void;
}) {
  const createClient = useCreateClient();
  const [name, setName] = useState(props.initialName);
  const [kind, setKind] = useState<ClientKind>(ClientKind.INDIVIDUAL);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | undefined>();

  // Not a nested <form>: intake is already a form, and forms don't nest.
  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!name.trim()) {
      setError("Give the client a name first.");
      return;
    }
    try {
      const created = await createClient.mutateAsync(
        create(ClientSpecSchema, {
          displayName: name.trim(),
          clientKind: kind,
          phones: phone.trim() ? [phone.trim()] : [],
        }),
      );
      props.onCreated(created);
    } catch (err) {
      setError(ConnectError.from(err).rawMessage);
    }
  }

  return (
    <div className="rounded-card border border-line bg-paper p-4">
      <p className="mb-3 font-medium">New client</p>
      <Label htmlFor="new-client-name">Name</Label>
      <Input id="new-client-name" value={name} onChange={(e) => setName(e.target.value)} />
      <Label htmlFor="new-client-kind">Person or organisation</Label>
      <Select
        id="new-client-kind"
        value={kind}
        onChange={(e) => setKind(Number(e.target.value) as ClientKind)}
      >
        <option value={ClientKind.INDIVIDUAL}>{clientKindLabel(ClientKind.INDIVIDUAL)}</option>
        <option value={ClientKind.ORGANIZATION}>{clientKindLabel(ClientKind.ORGANIZATION)}</option>
      </Select>
      <Label htmlFor="new-client-phone">
        Phone <span className="font-normal text-ink-muted">(optional)</span>
      </Label>
      <Input id="new-client-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <FormError message={error} />
      <div className="flex gap-3">
        <Button variant="primary" disabled={createClient.isPending} onClick={(e) => void onCreate(e)}>
          {createClient.isPending ? "Adding…" : "Add client"}
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
