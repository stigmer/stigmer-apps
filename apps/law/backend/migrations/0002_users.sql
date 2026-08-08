-- User storage (see the storage registry in src/storage.ts, which must
-- mirror this exactly) plus the app-owned credentials table.
--
-- The email generated column reads the stored spec, which the pipeline
-- normalizes to lowercase before persist — so the unique constraint and
-- the natural-key lookup agree by construction, and 'NK@Firm.com' can
-- never coexist with 'nk@firm.com' (T03 D7).
CREATE TABLE users (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  email text GENERATED ALWAYS AS (resource->'spec'->>'email') STORED,

  CONSTRAINT users_natural_key UNIQUE (email)
);
-- The unique index above also serves the list contract (email ascending).

-- Credentials are deliberately NOT part of the User resource (T03 D7): no
-- resource row carries a hash, so no resource read path can leak one.
-- Written only by the operator-only SetPassword operation; read by T04's
-- login. Rows die with their user (no user delete exists in MVP, but the
-- constraint states the ownership).
CREATE TABLE user_credentials (
  user_id       text PRIMARY KEY REFERENCES users (id),
  password_hash text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
