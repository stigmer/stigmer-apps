-- The per-resource storage artifact, in the shape every consuming product
-- follows: two authored columns (id, resource), STORED generated columns
-- for each queryable/unique field reading proto3 JSON (camelCase keys),
-- real indexes, and the natural-key constraint named <table>_natural_key
-- (the PostgresResourceStore maps violations of that name to
-- ALREADY_EXISTS).
CREATE TABLE widgets (
  id       text PRIMARY KEY,
  resource jsonb NOT NULL,
  serial_number   text GENERATED ALWAYS AS (resource->'spec'->>'serialNumber') STORED,
  inspection_date text GENERATED ALWAYS AS (resource->'spec'->>'inspectionDate') STORED,
  owner_id        text GENERATED ALWAYS AS (resource->'spec'->>'ownerId') STORED,
  -- Columns may read any proto3-JSON root (T03 D5): a stored-status
  -- boolean (->> renders 'true'/'false' text, the port's comparison
  -- form) and the metadata creation instant (RFC3339 UTC text — text
  -- ordering IS chronological ordering).
  retired    text GENERATED ALWAYS AS (resource->'status'->>'retired') STORED,
  created_at text GENERATED ALWAYS AS (resource->'metadata'->>'createdAt') STORED,
  CONSTRAINT widgets_natural_key UNIQUE (serial_number)
);

CREATE INDEX widgets_inspection_date_idx ON widgets (inspection_date);
CREATE INDEX widgets_owner_id_idx ON widgets (owner_id);
CREATE INDEX widgets_created_at_idx ON widgets (created_at);
