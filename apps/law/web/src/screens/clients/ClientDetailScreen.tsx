/**
 * One client and all their matters (FR-CLIENT-002) — the cross-case view
 * the register exists for. The matter list is the server's summary list
 * scoped by client, so a non-member lawyer sees exactly the list lines
 * the matrix allows and nothing more.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Pagination } from "../../components/Pagination.js";
import { ClientKind } from "../../gen/stigmer/law/client/v1/client_pb.js";
import { clientKindLabel } from "../../lib/format.js";
import { CaseSummaryRow } from "../cases/CaseListScreen.js";
import { useCaseList } from "../cases/queries.js";
import { ClientForm } from "./ClientForm.js";
import { useClient, useUpdateClient } from "./queries.js";

export function ClientDetailScreen() {
  const { id = "" } = useParams();
  const client = useClient(id);
  const updateClient = useUpdateClient();
  const [page, setPage] = useState(0);
  const matters = useCaseList({ clientId: id }, page);
  const [editing, setEditing] = useState(false);

  if (client.isPending) return <Loading label="Loading the client…" />;
  if (client.isError) {
    return <ErrorState error={client.error} onRetry={() => void client.refetch()} />;
  }
  const spec = client.data.spec;
  if (!spec) return <EmptyState title="This client has no details" />;

  if (editing) {
    return (
      <section aria-label={`Edit ${spec.displayName}`}>
        <h1 className="mb-4 text-xl font-semibold">Edit {spec.displayName}</h1>
        <ClientForm
          initial={spec}
          submitLabel="Save changes"
          pending={updateClient.isPending}
          onSubmit={async (nextSpec) => {
            await updateClient.mutateAsync({ existing: client.data, spec: nextSpec });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section aria-label={spec.displayName}>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{spec.displayName}</h1>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="h-11 rounded-card px-3 text-sm text-brand hover:bg-brand-surface"
        >
          Edit
        </button>
      </div>

      <div className="mb-4 rounded-card border border-line bg-surface p-4 text-sm">
        <p className="text-ink-muted">
          {clientKindLabel(spec.clientKind ?? ClientKind.UNSPECIFIED)}
          {spec.phones.length > 0 && ` · ${spec.phones.join(", ")}`}
          {spec.email && ` · ${spec.email}`}
        </p>
        {spec.address && <p className="mt-1 text-ink-muted">{spec.address}</p>}
        {spec.notes && <p className="mt-1 whitespace-pre-wrap">{spec.notes}</p>}
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Matters</h2>
        <Link
          to="/cases/new"
          className="flex h-11 items-center rounded-card bg-brand px-4 font-medium text-on-brand hover:bg-brand-strong"
        >
          New case
        </Link>
      </div>
      {matters.isPending && <Loading label="Loading matters…" />}
      {matters.isError && (
        <ErrorState error={matters.error} onRetry={() => void matters.refetch()} />
      )}
      {matters.isSuccess && matters.data.items.length === 0 && (
        <EmptyState title="No matters for this client yet" />
      )}
      {matters.isSuccess && matters.data.items.length > 0 && (
        <>
          <ul className="rounded-card border border-line bg-surface">
            {matters.data.items.map((summary) => (
              <CaseSummaryRow key={summary.id} summary={summary} />
            ))}
          </ul>
          <Pagination
            page={page}
            totalCount={Number(matters.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
