-- LedgerEntries: append-only money movements. amount_paise is the
-- sumBy column (int64 renders as JSON text; the adapter casts ::bigint
-- at aggregation — integer paise keep the arithmetic exact); entry_kind
-- is the charge/receipt/expense filter the balance derivation sums by.
CREATE TABLE ledger_entries (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id      text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  entry_kind   text GENERATED ALWAYS AS (resource->'spec'->>'entryKind') STORED,
  amount_paise text GENERATED ALWAYS AS (resource->'spec'->>'amountPaise') STORED,
  date         text GENERATED ALWAYS AS (resource->'spec'->>'date') STORED,
  created_at   text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The per-case ledger reads (case, date desc); the outstanding
-- derivation groups by case with an entry_kind filter.
CREATE INDEX ledger_entries_case_date_idx ON ledger_entries (case_id, date);
CREATE INDEX ledger_entries_case_kind_idx ON ledger_entries (case_id, entry_kind);
