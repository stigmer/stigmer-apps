/**
 * The client register (FR-CLIENT-001/003): alphabetical list with ONE
 * search box that is also the informal conflict check — matched clients
 * AND matters where the name appears on the OTHER side, in the same
 * answer. Silence would read as "didn't run", so no-hits says so.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { clientKindLabel } from "../../lib/format.js";
import { ClientKind } from "../../gen/stigmer/law/client/v1/client_pb.js";
import { useClientList, useClientSearch } from "./queries.js";

export function ConflictSearchResults(props: { query: string }) {
  const search = useClientSearch(props.query);
  if (props.query.trim().length < 2) {
    return <p className="text-sm text-ink-muted">Type at least two letters to search.</p>;
  }
  if (search.isPending) return <Loading label="Searching…" />;
  if (search.isError) {
    return <ErrorState error={search.error} onRetry={() => void search.refetch()} />;
  }
  const { clients, opposingPartyHits } = search.data;
  return (
    <div className="grid gap-3">
      <section aria-label="Matching clients">
        <h3 className="mb-1 text-sm font-medium text-ink-muted">Our clients</h3>
        {clients.length === 0 ? (
          <p className="text-sm text-ink-muted">No client with this name in the register.</p>
        ) : (
          <ul className="rounded-card border border-line bg-surface">
            {clients.map((client) => (
              <li key={client.metadata?.id} className="border-b border-line last:border-b-0">
                <Link
                  to={`/clients/${client.metadata?.id}`}
                  className="flex min-h-11 items-center px-3 py-2 font-medium hover:bg-brand-surface"
                >
                  {client.spec?.displayName}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Matters where this name is on the other side">
        <h3 className="mb-1 text-sm font-medium text-ink-muted">
          On the OTHER side of our matters
        </h3>
        {opposingPartyHits.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No earlier matter with this name on the other side.
          </p>
        ) : (
          <ul className="rounded-card border border-warn bg-warn-surface">
            {opposingPartyHits.map((hit) => (
              <li
                key={`${hit.caseId}-${hit.matchedPartyName}`}
                className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn px-3 py-2 last:border-b-0"
              >
                <span className="font-medium">{hit.matchedPartyName}</span>
                <span className="text-sm">
                  is opposite us in {hit.fileNumber} ({hit.caption})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ClientListScreen() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const list = useClientList(page);
  const searching = query.trim().length > 0;

  return (
    <section aria-label="Clients">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Clients</h1>
        <Link
          to="/clients/new"
          className="flex h-11 items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
        >
          New client
        </Link>
      </div>

      <label htmlFor="client-search" className="mb-1 block text-sm font-medium">
        Search the register{" "}
        <span className="font-normal text-ink-muted">
          — also checks whether the name is on the other side of any matter
        </span>
      </label>
      <input
        id="client-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="A name — person or company"
        className="mb-4 block h-11 w-full rounded-card border border-line bg-surface px-3"
      />

      {searching ? (
        <ConflictSearchResults query={query} />
      ) : (
        <>
          {list.isPending && <Loading label="Loading clients…" />}
          {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
          {list.isSuccess && list.data.items.length === 0 && (
            <EmptyState title="No clients yet">
              Add the first client — matters are opened against the register.
            </EmptyState>
          )}
          {list.isSuccess && list.data.items.length > 0 && (
            <>
              <ul className="rounded-card border border-line bg-surface">
                {list.data.items.map((client) => (
                  <li key={client.metadata?.id} className="border-b border-line last:border-b-0">
                    <Link
                      to={`/clients/${client.metadata?.id}`}
                      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-brand-surface"
                    >
                      <span className="font-medium">{client.spec?.displayName}</span>
                      <span className="text-sm text-ink-muted">
                        {clientKindLabel(client.spec?.clientKind ?? ClientKind.UNSPECIFIED)}
                      </span>
                      {(client.spec?.phones.length ?? 0) > 0 && (
                        <span className="text-sm text-ink-faint">{client.spec?.phones[0]}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
              <Pagination
                page={page}
                totalCount={Number(list.data.totalCount)}
                onPage={setPage}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
