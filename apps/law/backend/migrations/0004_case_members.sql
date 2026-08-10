-- CaseMembers: the membership fact the policy consults on every
-- case-content decision. Membership is a PERIOD: removal flips
-- status.active (no row delete — a legal record keeps attribution),
-- and re-adding someone opens a NEW row. The natural key therefore
-- exists only while a membership is ACTIVE — the key column goes NULL
-- on removal (NULLs never collide under a unique constraint), so a
-- duplicate ACTIVE membership is impossible while history accumulates
-- freely underneath.
CREATE TABLE case_members (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id    text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  member_id  text GENERATED ALWAYS AS (resource->'spec'->>'memberId') STORED,
  active     text GENERATED ALWAYS AS (resource->'status'->>'active') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  member_key text GENERATED ALWAYS AS (
    CASE
      WHEN resource->'status'->>'active' = 'true'
      THEN (resource->'spec'->>'caseId') || ':' || (resource->'spec'->>'memberId')
    END
  ) STORED,
  CONSTRAINT case_members_natural_key UNIQUE (member_key)
);

-- The policy's membership lookup rides the natural-key index; these two
-- serve "a case's member set" and "a member's case set" (the mine
-- predicate and the non-partner list scoping).
CREATE INDEX case_members_case_id_idx ON case_members (case_id);
CREATE INDEX case_members_member_id_idx ON case_members (member_id);
