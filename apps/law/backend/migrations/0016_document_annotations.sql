-- DocumentAnnotations: append-only marks with comments on filed
-- documents (DD-010) — the anchor lives in the resource jsonb (page,
-- kind, normalized rects, quoted text); columns exist only for the
-- named reads: the per-document panel list (document_id, created_at)
-- and the policy's case-content rule (case_id, denormalized from the
-- immutable Document at create time, pipeline-verified).
--
-- Deliberately NO page column: nothing filters or orders by page in
-- SQL (the viewer groups marks client-side), and an int-rendered-as-
-- text column invites the lexicographic ordering trap DocumentPage's
-- resource header documents.
CREATE TABLE document_annotations (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  document_id text GENERATED ALWAYS AS (resource->'spec'->>'documentId') STORED,
  case_id     text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  created_at  text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The panel/overlay list: a document's marks, oldest first.
CREATE INDEX document_annotations_document_created_idx
  ON document_annotations (document_id, created_at ASC);
-- Case-scoped reads (policy/visibility lookups).
CREATE INDEX document_annotations_case_idx ON document_annotations (case_id);
