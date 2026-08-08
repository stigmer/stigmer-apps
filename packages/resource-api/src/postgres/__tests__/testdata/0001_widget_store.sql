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
  CONSTRAINT widgets_natural_key UNIQUE (serial_number)
);

CREATE INDEX widgets_inspection_date_idx ON widgets (inspection_date);
CREATE INDEX widgets_owner_id_idx ON widgets (owner_id);
