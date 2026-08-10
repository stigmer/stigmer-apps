-- Notifications: system-written, recipient-scoped. The dedup_key unique
-- constraint is the ONLY sent-state in the app — it is what makes event
-- handlers idempotent and the reminder sweep multi-replica safe.
CREATE TABLE notifications (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  dedup_key    text GENERATED ALWAYS AS (resource->'spec'->>'dedupKey') STORED,
  recipient_id text GENERATED ALWAYS AS (resource->'spec'->>'recipientId') STORED,
  read         text GENERATED ALWAYS AS (resource->'status'->>'read') STORED,
  created_at   text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  CONSTRAINT notifications_natural_key UNIQUE (dedup_key)
);

CREATE INDEX notifications_recipient_created_idx ON notifications (recipient_id, created_at);
