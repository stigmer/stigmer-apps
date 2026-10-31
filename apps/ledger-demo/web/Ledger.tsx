/**
 * The signed-in person's customer's books, read from Acme's own server every two seconds, so an
 * adjustment the agent posts shows up here as Acme's data, not as anything the panel draws.
 */
import { useEffect, useRef, useState } from "react";
import { customerBySlug, ledgerCsv } from "../fixtures/books.js";
import { api, formatMoney, formatVariance, type BooksView } from "./api.js";

/** An account is flagged when it is more than this share over or under its budget. */
const FLAG_SHARE = 0.1;

function exportCsv(slug: string): void {
  const customer = customerBySlug(slug);
  if (!customer) return;
  const url = URL.createObjectURL(new Blob([ledgerCsv(customer)], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "ledger.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

export function Ledger() {
  const [view, setView] = useState<BooksView>();
  const seen = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState<string>();

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const next = await api.ledger();
        if (!live) return;
        const newest = next.adjustments.at(-1);
        if (seen.current !== undefined && next.adjustments.length > seen.current && newest) setFresh(newest.id);
        seen.current = next.adjustments.length;
        setView(next);
      } catch {
        // A missed read is retried on the next tick; the page keeps what it last showed.
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!view) return <section className="acme-ledger">Loading the ledger…</section>;

  return (
    <section className="acme-ledger">
      <div className="acme-ledger-head">
        <div>
          <h1>{view.customer.name}</h1>
          <p className="acme-sub">General ledger · {view.customer.quarter}</p>
        </div>
        <button type="button" className="acme-button" onClick={() => exportCsv(view.customer.slug)}>
          Export ledger.csv
        </button>
      </div>

      <h2>Budget against actual</h2>
      <table className="acme-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Budget</th>
            <th className="num">Actual</th>
            <th className="num">Variance</th>
          </tr>
        </thead>
        <tbody>
          {view.accounts.map((a) => {
            const flagged = Math.abs(a.variance) > a.budget * FLAG_SHARE;
            return (
              <tr key={a.account} className={flagged ? "is-flagged" : undefined}>
                <td>{a.account}</td>
                <td className="num">{formatMoney(a.budget)}</td>
                <td className="num">{formatMoney(a.actual)}</td>
                <td className="num">
                  {formatVariance(a.variance)}
                  {flagged && <span className="acme-flag">{a.variance > 0 ? "over" : "under"}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Adjustments</h2>
      {view.adjustments.length === 0 ? (
        <p className="acme-empty">None posted this quarter.</p>
      ) : (
        <ul className="acme-adjustments">
          {view.adjustments.map((a) => (
            <li key={a.id} className={a.id === fresh ? "is-fresh" : undefined}>
              <strong>{formatMoney(a.amount)}</strong> from {a.from} to {a.to}
              <span className="acme-reason">{a.reason}</span>
              <span className="acme-by">
                {a.by} · {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Lines</h2>
      <table className="acme-table acme-lines">
        <thead>
          <tr>
            <th>Date</th>
            <th>Vendor</th>
            <th>Description</th>
            <th>Account</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {view.lines.map((l) => (
            <tr key={`${l.date}-${l.vendor}-${l.amount}`}>
              <td>{l.date}</td>
              <td>{l.vendor}</td>
              <td>{l.description}</td>
              <td>{l.account}</td>
              <td className="num">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
