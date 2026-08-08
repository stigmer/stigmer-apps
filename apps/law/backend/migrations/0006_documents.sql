-- Document storage (see the storage registry in src/storage.ts, which
-- must mirror this exactly). Rows are metadata ONLY — bytes live in the
-- private object bucket under spec.objectKey, uploaded before the row is
-- created (T03 D6). No natural key: the same filename may be uploaded to
-- a case any number of times.
CREATE TABLE documents (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  -- RFC3339 UTC text: text ordering IS chronological ordering.
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- Serves both the per-case list (newest first) and the grouped
-- document_count derivation on Case (countBy case_id).
CREATE INDEX documents_case_created_idx ON documents (case_id, created_at DESC);
