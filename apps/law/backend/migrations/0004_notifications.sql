-- Notification storage (see the storage registry in src/storage.ts, which
-- must mirror this exactly).
--
-- dedup_key is the natural key and THE dedup owner (scope contract): the
-- unique constraint is what makes "notify at most once per event" hold
-- even under concurrent producers — no other sent-state exists anywhere.
--
-- `read` reads the STATUS (T03 D8) and relies on explicit presence in the
-- proto (`optional bool`): proto3 JSON omits implicit-presence false, so
-- without presence tracking unread rows would generate NULL, not 'false'.
CREATE TABLE notifications (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  dedup_key    text GENERATED ALWAYS AS (resource->'spec'->>'dedupKey') STORED,
  recipient_id text GENERATED ALWAYS AS (resource->'spec'->>'recipientId') STORED,
  read         text GENERATED ALWAYS AS (resource->'status'->>'read') STORED,
  -- RFC3339 UTC text: text ordering IS chronological ordering.
  created_at   text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,

  CONSTRAINT notifications_natural_key UNIQUE (dedup_key)
);

-- The list contract: the recipient's own notifications, newest first,
-- optionally unread-only.
CREATE INDEX notifications_recipient_created_idx
  ON notifications (recipient_id, created_at DESC);
