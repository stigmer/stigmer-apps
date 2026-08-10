-- FeeArrangements: half of the partner-gated money aggregate (session-4
-- correction — money is NOT on the case row, so case reads never need
-- redaction). One arrangement per case: case_id is the natural key.
CREATE TABLE fee_arrangements (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  CONSTRAINT fee_arrangements_natural_key UNIQUE (case_id)
);
