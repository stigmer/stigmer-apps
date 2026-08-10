-- Hearings: the append-only appearance cycle — the case diary
-- (DD-001's center of gravity). outcome_kind NULL means scheduled;
-- the date+outcome pair drives the today/tomorrow checklists and the
-- unrecorded-outcome nag.
CREATE TABLE hearings (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id      text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  date         text GENERATED ALWAYS AS (resource->'spec'->>'date') STORED,
  outcome_kind text GENERATED ALWAYS AS (resource->'status'->>'outcomeKind') STORED,
  created_at   text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The diary (case + date) and the day board (date across cases).
CREATE INDEX hearings_case_date_idx ON hearings (case_id, date);
CREATE INDEX hearings_date_idx ON hearings (date);
