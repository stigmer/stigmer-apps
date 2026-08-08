-- CaseNote storage (see the storage registry in src/storage.ts, which
-- must mirror this exactly). Append-only resource: no natural key, no
-- update path — rows are only ever inserted.
CREATE TABLE case_notes (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  -- RFC3339 UTC text: text ordering IS chronological ordering.
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The list contract: a case's notes, newest first.
CREATE INDEX case_notes_case_created_idx ON case_notes (case_id, created_at DESC);
