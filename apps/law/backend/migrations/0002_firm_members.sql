-- FirmMembers: the identity profile (one per User — user_id is the
-- natural key) and the authorization matrix's first fact. The policy
-- module resolves every caller through user_id, so that lookup is the
-- hottest read in the app — it rides the unique index.
CREATE TABLE firm_members (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  user_id    text GENERATED ALWAYS AS (resource->'spec'->>'userId') STORED,
  role       text GENERATED ALWAYS AS (resource->'spec'->>'role') STORED,
  active     text GENERATED ALWAYS AS (resource->'spec'->>'active') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  CONSTRAINT firm_members_natural_key UNIQUE (user_id)
);
