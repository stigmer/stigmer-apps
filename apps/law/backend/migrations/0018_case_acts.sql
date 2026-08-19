-- CaseActs: the matter's statutory frame — one row per Act with its
-- sections (FR-ACT-001). Manual entry by contract; the system stores
-- facts and never computes a legal consequence (the FR-DEAD-003
-- boundary extended). act is a generated column because the frame
-- lists sorted by act name — a hundred acts read as a register.
CREATE TABLE case_acts (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  act        text GENERATED ALWAYS AS (resource->'spec'->>'act') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The frame view: one case's acts, sorted by act name.
CREATE INDEX case_acts_case_act_idx ON case_acts (case_id, act);
