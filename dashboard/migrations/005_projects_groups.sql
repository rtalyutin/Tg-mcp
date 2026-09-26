-- A project may belong to several groups. Codes stay open so new groups need no
-- code change. For an already-installed snapshot, seed names from its group
-- definitions; initial installs provide assignments with the snapshot itself.
CREATE TABLE dashboard.projects_groups (
  project_id text NOT NULL CHECK (length(btrim(project_id)) BETWEEN 1 AND 512),
  group_code text NOT NULL CHECK (length(btrim(group_code)) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, group_code)
);

CREATE INDEX projects_groups_by_code ON dashboard.projects_groups(group_code, project_id);

DO $$
DECLARE
  snapshot jsonb;
  missing text[];
BEGIN
  SELECT payload INTO snapshot FROM dashboard.curated_snapshot WHERE singleton=1;
  IF snapshot IS NULL THEN RETURN; END IF;

  INSERT INTO dashboard.projects_groups(project_id, group_code)
  SELECT project->>'id', definition->>'title'
  FROM jsonb_array_elements(snapshot->'projects') AS project
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(project->'display_group_ids') = 'array' THEN project->'display_group_ids'
      WHEN jsonb_typeof(project->'display_group_id') = 'string' THEN jsonb_build_array(project->>'display_group_id')
      ELSE '[]'::jsonb
    END
  ) AS membership(group_id)
  CROSS JOIN LATERAL jsonb_array_elements(snapshot->'project_groups') AS definition
  WHERE definition->>'id' = membership.group_id
  ON CONFLICT(project_id, group_code) DO NOTHING;

  SELECT array_agg(project->>'id' ORDER BY project->>'id') INTO missing
  FROM jsonb_array_elements(snapshot->'projects') AS project
  WHERE NOT EXISTS (
    SELECT 1 FROM dashboard.projects_groups assignment
    WHERE assignment.project_id = project->>'id'
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'DASHBOARD_PROJECT_GROUPS_REQUIRED: %', missing USING ERRCODE='23514';
  END IF;
END;
$$;
