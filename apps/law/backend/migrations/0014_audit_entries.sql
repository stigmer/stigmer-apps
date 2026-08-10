-- AuditEntries: the append-only change history (FR-AUDIT-001),
-- system-written off resource events. The dedup_key unique constraint
-- (subject kind:id:version) makes duplicate event delivery harmless —
-- one entry per resource version, by construction.
CREATE TABLE audit_entries (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  dedup_key  text GENERATED ALWAYS AS (resource->'spec'->>'dedupKey') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  CONSTRAINT audit_entries_natural_key UNIQUE (dedup_key)
);

-- History is read per case, newest first, by partners.
CREATE INDEX audit_entries_case_created_idx ON audit_entries (case_id, created_at DESC);
