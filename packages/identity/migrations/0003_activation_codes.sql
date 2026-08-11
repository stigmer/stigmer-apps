-- One-time activation codes (project DD-003 D4): the no-email
-- onboarding/reset path. Hashes only, like refresh_tokens — the raw code
-- exists nowhere at rest; it is shown once to the issuing administrator.
--
-- user_id is the PRIMARY KEY: at most one live code per user, so issuing
-- a new code replaces (invalidates) the previous one by construction —
-- an upsert, no cleanup pass needed. Redeeming deletes the row
-- atomically (DELETE ... RETURNING, expiry-checked in the same
-- statement), so a code can never set two passwords.
CREATE TABLE activation_codes (
  user_id    text PRIMARY KEY REFERENCES users (id),
  code_hash  text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
