-- TaskComments: append-only task discussion, carried from the MVP shape.
CREATE TABLE task_comments (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  task_id    text GENERATED ALWAYS AS (resource->'spec'->>'taskId') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

CREATE INDEX task_comments_task_created_idx ON task_comments (task_id, created_at ASC);
