/**
 * One client and all their matters (FR-CLIENT-002) on the DD-005 detail
 * frame: the matter list — the cross-case view the register exists for
 * — in the reading column, the client's contact facts in the context
 * rail. The matter list is the server's summary list scoped by client,
 * so a non-member lawyer sees exactly the list lines the matrix allows
 * and nothing more.
 *
 * Edit mode replaces the whole detail frame with the focused form
 * (DD-005's uniform rule).
 */

import { useState } from "react";
import { useParams } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { Button, ButtonLink } from "../../components/Button.js";
import { DetailLayout } from "../../components/DetailLayout.js";
import { ListCard } from "../../components/ListCard.js";
import { MetaItem, MetaPanel } from "../../components/MetaPanel.js";
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
        <h1 className="mb-4 text-lg font-semibold">Edit {spec.displayName}</h1>
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
      <h1 className="mb-4 text-lg font-semibold">{spec.displayName}</h1>

      <DetailLayout
        railLabel="Client facts"
        rail={
          <MetaPanel footer={<Button onClick={() => setEditing(true)}>Edit</Button>}>
            <MetaItem label="Kind">
              {clientKindLabel(spec.clientKind ?? ClientKind.UNSPECIFIED)}
            </MetaItem>
            {spec.phones.length > 0 && (
              <MetaItem label="Phone">{spec.phones.join(", ")}</MetaItem>
            )}
            {spec.email && <MetaItem label="Email">{spec.email}</MetaItem>}
            {spec.address && <MetaItem label="Address">{spec.address}</MetaItem>}
            {spec.notes && (
              <MetaItem label="Notes">
                <span className="whitespace-pre-wrap">{spec.notes}</span>
              </MetaItem>
            )}
          </MetaPanel>
        }
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Matters</h2>
          <ButtonLink to="/cases/new" variant="primary">
            New case
          </ButtonLink>
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
            <ListCard>
              {matters.data.items.map((summary) => (
                <CaseSummaryRow key={summary.id} summary={summary} />
              ))}
            </ListCard>
            <Pagination
              page={page}
              totalCount={Number(matters.data.totalCount)}
              onPage={setPage}
            />
          </>
        )}
      </DetailLayout>
    </section>
  );
}
