-- CitationUses: the firm's reliance trail on its judgment library
-- (FR-CIT-001) — append-only links (judgment document, using case,
-- proposition). The library's papers live in documents (category
-- JUDGMENT); this table holds the firm's experience with them.
CREATE TABLE citation_uses (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id     text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  document_id text GENERATED ALWAYS AS (resource->'spec'->>'documentId') STORED,
  created_at  text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- Both list directions ("this matter's citations" / "everywhere this
-- judgment was used"), each read newest first.
CREATE INDEX citation_uses_case_created_idx ON citation_uses (case_id, created_at);
CREATE INDEX citation_uses_document_created_idx ON citation_uses (document_id, created_at);
