-- Tasks: carried from the MVP shape (case_id, assignee, due date,
-- stored state) on the new baseline numbering. assignee_id now holds a
-- FirmMember id — all person references in law resources are FirmMember
-- ids on the rebuilt contract.
CREATE TABLE tasks (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  case_id     text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  assignee_id text GENERATED ALWAYS AS (resource->'spec'->>'assigneeId') STORED,
  due_date    text GENERATED ALWAYS AS (resource->'spec'->>'dueDate') STORED,
  state       text GENERATED ALWAYS AS (resource->'status'->>'state') STORED,
  created_at  text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

CREATE INDEX tasks_assignee_due_idx ON tasks (assignee_id, due_date);
CREATE INDEX tasks_case_due_idx ON tasks (case_id, due_date);
CREATE INDEX tasks_state_due_idx ON tasks (state, due_date);
