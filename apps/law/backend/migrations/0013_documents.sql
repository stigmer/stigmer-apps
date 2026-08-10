-- Documents: immutable bytes in the object store, this row is the
-- record. category gains the firm-wide judgment view (FR-DOC-002);
-- hearing_id ties an order to the listing it was pronounced at.
CREATE TABLE documents (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  category   text GENERATED ALWAYS AS (resource->'spec'->>'category') STORED,
  hearing_id text GENERATED ALWAYS AS (resource->'spec'->>'hearingId') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

CREATE INDEX documents_case_created_idx ON documents (case_id, created_at DESC);
-- The judgment-collection view lists one category across cases.
CREATE INDEX documents_category_created_idx ON documents (category, created_at DESC);
