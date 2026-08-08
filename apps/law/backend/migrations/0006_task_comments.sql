-- TaskComment storage (see the storage registry in src/storage.ts, which
-- must mirror this exactly). Append-only resource: no natural key, no
-- update path — rows are only ever inserted.
CREATE TABLE task_comments (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  task_id    text GENERATED ALWAYS AS (resource->'spec'->>'taskId') STORED,
  -- RFC3339 UTC text: text ordering IS chronological ordering.
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- The list contract: a task's comments, oldest first (conversation order).
CREATE INDEX task_comments_task_created_idx ON task_comments (task_id, created_at ASC);
