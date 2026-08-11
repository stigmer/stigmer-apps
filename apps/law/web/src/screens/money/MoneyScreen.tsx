/**
 * The money glance (journey J5, FR-MONEY-003): outstanding per matter —
 * charges plus billed expenses minus receipts, the server's exact
 * arithmetic — optionally narrowed to one client. The route renders
 * only for partners (the shell's nav already hides it); the server
 * refuses everyone else regardless, and that refusal renders verbatim
 * if someone deep-links here.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../../components/async.js";
import { InlineSelect } from "../../components/Field.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Pagination } from "../../components/Pagination.js";
import { formatPaise } from "../../lib/format.js";
import { useClientList } from "../clients/queries.js";
import { useOutstanding } from "./queries.js";

export function MoneyScreen() {
  const [clientId, setClientId] = useState("");
  const [page, setPage] = useState(0);
  const outstanding = useOutstanding(clientId, page);
  // The register fills the client filter; one page covers a firm.
  const clients = useClientList(0);

  const clientName = (id: string) =>
    clients.data?.items.find((c) => c.metadata?.id === id)?.spec?.displayName ?? "";

  return (
    <section aria-label="Money">
      <PageHeader title="Money" />

      <div className="mb-3 text-sm">
        <label htmlFor="money-client" className="mr-2 text-ink-muted">
          Client
        </label>
        <InlineSelect
          id="money-client"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All clients</option>
          {clients.data?.items.map((client) => (
            <option key={client.metadata?.id} value={client.metadata?.id}>
              {client.spec?.displayName}
            </option>
          ))}
        </InlineSelect>
      </div>

      {outstanding.isPending && <Loading label="Adding up the ledgers…" />}
      {outstanding.isError && (
        <ErrorState error={outstanding.error} onRetry={() => void outstanding.refetch()} />
      )}
      {outstanding.isSuccess && outstanding.data.items.length === 0 && (
        <EmptyState title={clientId ? `No matters for ${clientName(clientId)}` : "No matters on the books"} />
      )}
      {outstanding.isSuccess && outstanding.data.items.length > 0 && (
        <>
          <table className="w-full rounded-card border border-line bg-surface text-sm">
            <caption className="sr-only">
              Outstanding per matter: charged, received, and the balance
            </caption>
            <thead>
              <tr className="border-b border-line text-left text-ink-muted">
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Matter
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Charged
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Received
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  Outstanding
                </th>
              </tr>
            </thead>
            <tbody>
              {outstanding.data.items.map((line) => (
                <tr key={line.caseId} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-1.5">
                    <Link to={`/cases/${line.caseId}`} className="font-medium text-brand hover:underline">
                      {line.fileNumber}
                    </Link>
                    {!clientId && (
                      <span className="ml-2 text-ink-muted">{clientName(line.clientId)}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {formatPaise(line.chargesPaise + line.expensesPaise)}
                  </td>
                  <td className="px-3 py-1.5 text-right">{formatPaise(line.receiptsPaise)}</td>
                  <td
                    className={`px-3 py-1.5 text-right font-medium ${
                      line.outstandingPaise > 0n ? "text-warn" : "text-ok"
                    }`}
                  >
                    {formatPaise(line.outstandingPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-muted">
            Ledgers and the fee arrangement live on each matter's Money tab.
          </p>
          <Pagination
            page={page}
            totalCount={Number(outstanding.data.totalCount)}
            onPage={setPage}
          />
        </>
      )}
    </section>
  );
}
