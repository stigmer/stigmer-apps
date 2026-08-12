-- DocumentPages: one row per extracted page of a document's text layer
-- (FR-DOC-003), written only by the extraction sweep. The composed
-- natural key (document:page) is what makes re-extraction answer
-- ALREADY_EXISTS — the sweep's idempotency, database-owned. case_id is
-- denormalized from the immutable Document so the visibility filter on
-- content search runs INSIDE the query (the searchText filter seam).
CREATE TABLE document_pages (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  document_id text GENERATED ALWAYS AS (resource->'spec'->>'documentId') STORED,
  case_id     text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  page        text GENERATED ALWAYS AS (resource->'spec'->>'page') STORED,
  text        text GENERATED ALWAYS AS (resource->'spec'->>'text') STORED,
  created_at  text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  page_key    text GENERATED ALWAYS AS (
    (resource->'spec'->>'documentId') || ':' || (resource->'spec'->>'page')
  ) STORED,
  CONSTRAINT document_pages_natural_key UNIQUE (page_key)
);

-- read_document lists a document's pages in page order.
CREATE INDEX document_pages_document_idx ON document_pages (document_id, page);
-- Content search filters by the caller's visible case set before ILIKE.
CREATE INDEX document_pages_case_idx ON document_pages (case_id);
-- Deliberately NO trigram (pg_trgm) index on `text` yet: CREATE
-- EXTENSION needs privileges the managed Postgres may not grant, and a
-- failed migration is a boot outage. At firm scale the case_id index +
-- sequential ILIKE is comfortably inside the 2s envelope; the trigram
-- index is the named fast-follow once the extension probe (DD-008)
-- answers.

-- The sweep's work queue: documents whose extraction state is absent
-- (pre-extraction rows and fresh uploads — the automatic backfill) or
-- 'EXTRACTION_STATE_PENDING'.
ALTER TABLE documents ADD COLUMN extraction text
  GENERATED ALWAYS AS (resource->'status'->>'extraction') STORED;
CREATE INDEX documents_extraction_idx ON documents (extraction);
