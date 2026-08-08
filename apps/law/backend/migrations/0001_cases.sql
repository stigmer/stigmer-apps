-- Case storage (the per-resource storage artifact; see the storage
-- registry in src/storage.ts, which must mirror this exactly).
--
-- Shape: two authored columns (id, resource) + STORED generated columns
-- reading proto3 JSON (camelCase keys) for every queryable/unique field.
-- The natural-key constraint is named cases_natural_key so the store
-- adapter maps violations to ALREADY_EXISTS — the database owns
-- uniqueness; the pipeline's pre-check only makes the error friendlier
-- (FR-CASE-001 AC7).
CREATE TABLE cases (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  -- Court-issued case number: the natural key, unique across the firm.
  case_number text GENERATED ALWAYS AS (resource->'spec'->>'caseNumber') STORED,

  -- ISO date (YYYY-MM-DD); text ordering IS chronological ordering for
  -- ISO dates. NULL when no hearing is scheduled.
  next_hearing_date text GENERATED ALWAYS AS (resource->'spec'->>'nextHearingDate') STORED,

  CONSTRAINT cases_natural_key UNIQUE (case_number)
);

-- The list contract's query pattern (FR-CASE-002: order by hearing date,
-- dateless last): an ordering index on the generated column.
CREATE INDEX cases_next_hearing_date_idx ON cases (next_hearing_date ASC NULLS LAST);
