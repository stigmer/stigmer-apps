-- Task storage (see the storage registry in src/storage.ts, which must
-- mirror this exactly). No natural key: tasks have no user-provided
-- unique identity (record model).
CREATE TABLE tasks (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  case_id     text GENERATED ALWAYS AS (resource->'spec'->>'caseId') STORED,
  assignee_id text GENERATED ALWAYS AS (resource->'spec'->>'assigneeId') STORED,
  -- ISO date (YYYY-MM-DD); text ordering IS chronological ordering.
  -- NULL when the task has no due date.
  due_date    text GENERATED ALWAYS AS (resource->'spec'->>'dueDate') STORED
);

-- The list contract (due_date asc, dateless last) under its two filters:
-- "My Tasks" (assignee) and the case detail view (case).
CREATE INDEX tasks_assignee_due_idx ON tasks (assignee_id, due_date ASC NULLS LAST);
CREATE INDEX tasks_case_due_idx ON tasks (case_id, due_date ASC NULLS LAST);
