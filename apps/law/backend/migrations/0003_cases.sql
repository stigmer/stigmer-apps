-- Cases: the matter (DD-001, restructured from the MVP wholesale).
-- file_number (firm-issued) is the natural key; court_case_number is
-- unique only when present (partial index below — the pipeline's
-- friendly pre-check answers ALREADY_EXISTS, this constraint is the
-- race backstop and surfaces as INTERNAL in the rare concurrent case,
-- a recorded acceptance).
CREATE TABLE cases (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  file_number       text GENERATED ALWAYS AS (resource->'spec'->>'fileNumber') STORED,
  court_case_number text GENERATED ALWAYS AS (resource->'spec'->>'courtCaseNumber') STORED,
  client_id         text GENERATED ALWAYS AS (resource->'spec'->>'clientId') STORED,
  lead_lawyer_id    text GENERATED ALWAYS AS (resource->'spec'->>'leadLawyerId') STORED,
  forum_kind        text GENERATED ALWAYS AS (resource->'spec'->'forum'->>'forumKind') STORED,
  lifecycle         text GENERATED ALWAYS AS (resource->'status'->>'lifecycle') STORED,
  -- The stored-derived next-hearing fact (the app's one documented
  -- DD-A6 exception, Gate-1 Q6): recomputed from Hearings by a single
  -- system writer; the hearing-window and no-next-date list predicates
  -- filter on it, which is the whole reason it is stored.
  next_hearing_date text GENERATED ALWAYS AS (resource->'status'->>'nextHearingDate') STORED,
  -- The opposing-party half of the conflict check (FR-CLIENT-003):
  -- the parties array as JSON text, searched by ILIKE for name
  -- substrings. Container punctuation is not matchable content by the
  -- port contract; names are.
  opposing_parties_text text GENERATED ALWAYS AS ((resource->'spec'->'opposingParties')::text) STORED,
  created_at        text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  CONSTRAINT cases_natural_key UNIQUE (file_number)
);

CREATE UNIQUE INDEX cases_court_case_number_unique
  ON cases (court_case_number) WHERE court_case_number IS NOT NULL;
CREATE INDEX cases_client_id_idx ON cases (client_id);
CREATE INDEX cases_next_hearing_date_idx ON cases (next_hearing_date);
CREATE INDEX cases_lifecycle_idx ON cases (lifecycle);
