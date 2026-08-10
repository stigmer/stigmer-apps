-- CaseNotes: append-only case narrative, carried from the MVP shape.
CREATE TABLE case_notes (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

CREATE INDEX case_notes_case_created_idx ON case_notes (case_id, created_at DESC);
