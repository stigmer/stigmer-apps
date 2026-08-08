-- THROWAWAY (Stage A toolchain proof, paired with lawfirm.ping.v1): deleted
-- when the first real resource (Case) lands.
CREATE TABLE pings (
  id         bigserial PRIMARY KEY,
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
