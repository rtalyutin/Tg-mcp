-- Owner display preferences for the curated graph, independent of daily imports.
-- These IDs belong to the curated snapshot; canonical project_visibility has UUID keys.
CREATE TABLE dashboard.curated_project_visibility (
  project_id text PRIMARY KEY,
  hidden boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curated_project_visibility_id CHECK (length(project_id) BETWEEN 1 AND 512)
);
REVOKE ALL ON dashboard.curated_project_visibility FROM PUBLIC;
