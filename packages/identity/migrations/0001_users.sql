-- Identity storage: the User resource plus the two auth tables that are
-- deliberately NOT resource state.
--
-- Consumed as the "identity" migration source (DD-005 D8): apps declare
-- this package's migrations before their own, so app tables may reference
-- users(id). The kind config in @stigmer/identity/postgres must mirror
-- this file exactly (the integration tests run against it, so a mismatch
-- cannot survive its first test run).

-- The email generated column reads the stored spec, which the pipeline
-- normalizes to lowercase before persist — so the unique constraint and
-- the natural-key lookup agree by construction, and 'NK@Firm.com' can
-- never coexist with 'nk@firm.com'.
CREATE TABLE users (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,

  email text GENERATED ALWAYS AS (resource->'spec'->>'email') STORED,

  CONSTRAINT users_natural_key UNIQUE (email)
);
-- The unique index above also serves the list contract (email ascending).

-- Credentials are deliberately NOT part of the User resource (T03 D7 of
-- the first consumer, now the commons rule): no resource row carries a
-- hash, so no resource read path can leak one. Written only by the
-- operator-only SetPassword operation; read by Login. Rows die with
-- their user (no user delete exists yet, but the constraint states the
-- ownership).
CREATE TABLE user_credentials (
  user_id       text PRIMARY KEY REFERENCES users (id),
  password_hash text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh sessions (DD-005 D6): hashes only — the raw token exists
-- nowhere at rest. consumed_at implements one-time-use: a consumed hash
-- arriving again is theft evidence, and the store's reuse response
-- (revoke the user's every session) depends on consumed rows STAYING
-- until expiry — do not "clean up" consumed rows early; the purge in the
-- adapter removes only expired ones.
CREATE TABLE refresh_tokens (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- revokeAllForUser and the reuse response delete by user.
CREATE INDEX refresh_tokens_user_id ON refresh_tokens (user_id);
