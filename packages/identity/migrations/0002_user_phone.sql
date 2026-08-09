-- Channel-binding lookup for User.phone (T05): the WhatsApp entrance
-- resolves a Meta-verified wa_id to a user by exact phone equality, so
-- the phone needs a real column and an index — the "register the field
-- AND back it with an index, in the same change" rule.
--
-- Exact equality is sufficient BY CONSTRUCTION: the proto validates
-- phone as strict E.164 ("+" followed by digits, no spaces or dashes),
-- and a wa_id is the same digits without the "+" — so the lookup value
-- is always `'+' || wa_id`, and no normalization layer exists to drift.
--
-- Deliberately NOT unique (recorded deferral, T05): making phone a
-- second unique key is a User-contract change (create could then fail on
-- a phone clash), and the adapter maps only the one `<table>_natural_key`
-- constraint to a friendly ALREADY_EXISTS — a second constraint would
-- surface as an opaque internal error. Two users sharing a phone instead
-- resolve as AMBIGUOUS at the channel entrance, which refuses rather
-- than guessing. Revisit if a real firm hits it.
ALTER TABLE users
  ADD COLUMN phone text GENERATED ALWAYS AS (resource->'spec'->>'phone') STORED;

-- Partial: phone is optional, and the lookup only ever asks about a
-- concrete value.
CREATE INDEX users_phone_idx ON users (phone) WHERE phone IS NOT NULL;
