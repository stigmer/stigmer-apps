-- Task lifecycle state as a queryable column (T05): the named list
-- predicates (open, overdue) filter on state server-side, so it needs a
-- real column and an index — "register the field AND back it with an
-- index, in the same change". Follows the Notification.read precedent
-- for a status-backed generated column.
--
-- The value is the proto3-JSON enum NAME ("TASK_STATE_OPEN", …), which
-- is exactly what both store adapters compare as text. Postgres computes
-- stored generated columns for existing rows at ADD COLUMN time, so no
-- backfill step exists to forget.
ALTER TABLE tasks
  ADD COLUMN state text GENERATED ALWAYS AS (resource->'status'->>'state') STORED;

-- The firm-wide predicates' query pattern: state narrows first
-- (open/overdue), then the fixed list ordering (due_date asc, dateless
-- last) — mirroring the two existing per-assignee/per-case indexes.
CREATE INDEX tasks_state_due_idx ON tasks (state, due_date ASC NULLS LAST);
