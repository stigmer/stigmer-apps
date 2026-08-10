-- Deadlines: lawyer-entered, relentlessly surfaced (DD-001). state and
-- due_date drive the escalation sweep's window queries and the overdue
-- filter; owner_id drives "my deadlines" and notification recipients.
CREATE TABLE deadlines (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id  text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  due_date text GENERATED ALWAYS AS (resource->'spec'->>'dueDate') STORED,
  owner_id text GENERATED ALWAYS AS (resource->'spec'->>'ownerId') STORED,
  state    text GENERATED ALWAYS AS (resource->'status'->>'state') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The sweep and the home views query open deadlines by due date; the
-- case view and open_deadline_count group by case.
CREATE INDEX deadlines_state_due_idx ON deadlines (state, due_date);
CREATE INDEX deadlines_case_id_idx ON deadlines (case_id);
CREATE INDEX deadlines_owner_due_idx ON deadlines (owner_id, due_date);
