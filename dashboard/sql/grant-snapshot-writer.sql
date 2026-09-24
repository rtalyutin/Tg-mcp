-- Create dashboard_snapshot_writer LOGIN outside Git, then run as migration owner.
-- The permanent MCP writer can update the reviewed snapshot only.
BEGIN;
REVOKE ALL ON dashboard.curated_snapshot FROM dashboard_snapshot_writer;
GRANT USAGE ON SCHEMA dashboard TO dashboard_snapshot_writer;
GRANT SELECT, UPDATE ON dashboard.curated_snapshot TO dashboard_snapshot_writer;
COMMIT;
