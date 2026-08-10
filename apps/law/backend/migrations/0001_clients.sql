-- Clients: the relationship anchor (DD-001). No natural key — client
-- names collide legitimately; duplicate prevention is a UX concern.
--
-- FRESH BASELINE (2026-08-10): this numbering restarts the app source's
-- migration history. The MVP's seven files were retired wholesale inside
-- the free-rebuild window; the deployed database is dropped and reseeded
-- at cutover (owner-authorized), which is what makes replacing applied
-- files legal — the checksum ledger dies with the database.
CREATE TABLE clients (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  display_name text GENERATED ALWAYS AS (resource->'spec'->>'displayName') STORED,
  created_at   text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED
);

-- Alphabetical listing and the conflict-check ILIKE both read this.
-- Deliberately NO trigram index: a firm's client register is hundreds of
-- rows, and a sequential ILIKE scan is sub-millisecond at that scale.
-- pg_trgm (an extension, hence a deploy permission) earns its place when
-- a register outgrows the scan — measured, not assumed.
CREATE INDEX clients_display_name_idx ON clients (display_name);
CREATE INDEX clients_created_at_idx ON clients (created_at);
