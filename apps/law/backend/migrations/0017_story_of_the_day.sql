-- The story-of-the-day predicates (FR-HEAR-007): what came back from
-- court today, what went on the board today, what new obligations were
-- entered today. recorded_at is written exactly once by RecordOutcome —
-- the same write that freezes the appearance record — so the column is
-- as immutable as the outcome it timestamps. Hearings completed before
-- the field existed have NULL here and honestly never match a
-- recorded-on query.
ALTER TABLE hearings
  ADD COLUMN recorded_at text GENERATED ALWAYS AS (resource->'status'->>'recordedAt') STORED;

-- Each day-feed query pattern gets its matching index. The unassigned
-- task view (FR-TASK-002) deliberately adds none: it filters on state
-- (tasks_state_due_idx) with an assignee-NULL check on top, and a firm's
-- task table stays small enough that a dedicated partial index would be
-- speculation.
CREATE INDEX hearings_recorded_at_idx ON hearings (recorded_at);
CREATE INDEX hearings_created_at_idx ON hearings (created_at);
CREATE INDEX deadlines_created_at_idx ON deadlines (created_at);
