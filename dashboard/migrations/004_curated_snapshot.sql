-- A manually reviewed, explicitly partial first slice. This table is separate
-- from collected source revisions and can later be superseded by canonical data.
CREATE TABLE dashboard.curated_snapshot (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now()
);
