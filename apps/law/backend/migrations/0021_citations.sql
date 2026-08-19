-- Citations: the library shelf entries (DD-012 D2) — one MUTABLE row
-- of identity (title, court, year, citation string) per case-less
-- library judgment. The papers live in documents; the shelf lists
-- THIS table (one kind, one query — the AND-only filter grammar
-- cannot express a "case-less OR flagged" document shelf).
CREATE TABLE citations (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  document_id text GENERATED ALWAYS AS (resource->'spec'->>'documentId') STORED,
  title       text GENERATED ALWAYS AS (resource->'spec'->>'title') STORED,
  citation    text GENERATED ALWAYS AS (resource->'spec'->>'citation') STORED,
  promoted_from_document_id text GENERATED ALWAYS AS (
    resource->'spec'->>'promotedFromDocumentId'
  ) STORED,
  created_at  text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  -- One shelf entry per paper — the natural key the create pipeline
  -- answers ALREADY_EXISTS from (the DocumentPage arrangement).
  CONSTRAINT citations_natural_key UNIQUE (document_id)
);

-- The shelf reads newest first.
CREATE INDEX citations_created_idx ON citations (created_at);
-- One promotion per source paper: the promote operation refuses a
-- second attempt by looking the source up here. Partial-unique rather
-- than app-side check alone — the database owns the invariant.
CREATE UNIQUE INDEX citations_promoted_from_idx
  ON citations (promoted_from_document_id)
  WHERE promoted_from_document_id IS NOT NULL;
