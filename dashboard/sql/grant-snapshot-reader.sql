-- The migration owner creates dashboard_snapshot_reader LOGIN with a secret
-- outside the repository, then runs this file. This role only reads the
-- reviewed partial snapshot; it cannot access source text or canonical data.
BEGIN;
REVOKE ALL ON SCHEMA dashboard FROM PUBLIC;
REVOKE ALL ON dashboard.curated_snapshot FROM PUBLIC;
REVOKE ALL ON dashboard.curated_snapshot FROM dashboard_snapshot_reader;
GRANT USAGE ON SCHEMA dashboard TO dashboard_snapshot_reader;
GRANT SELECT ON dashboard.curated_snapshot TO dashboard_snapshot_reader;
COMMIT;
