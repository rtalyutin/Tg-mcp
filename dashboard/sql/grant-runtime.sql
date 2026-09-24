-- Run as the migration owner after `npm run migrate --workspace=roman-dashboard-backend`.
-- Create the LOGIN role dashboard_runtime separately with a password outside Git.
-- Do not run this script as the HTTP runtime user.
BEGIN;
REVOKE ALL ON SCHEMA dashboard FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA dashboard FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dashboard FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA dashboard FROM dashboard_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dashboard FROM dashboard_runtime;
REVOKE ALL ON dashboard.dashboard_schema_migration FROM dashboard_runtime;

GRANT USAGE ON SCHEMA dashboard TO dashboard_runtime;
GRANT SELECT ON dashboard.dashboard_schema_migration TO dashboard_runtime;
GRANT SELECT ON dashboard.source TO dashboard_runtime;
GRANT SELECT, UPDATE ON dashboard.source_checkpoint TO dashboard_runtime;
GRANT SELECT, INSERT, UPDATE ON dashboard.collection_run, dashboard.run_source,
  dashboard.ingest_batch TO dashboard_runtime;
GRANT SELECT, INSERT ON dashboard.source_event, dashboard.batch_event TO dashboard_runtime;
GRANT INSERT ON dashboard.run_attempt TO dashboard_runtime;
GRANT USAGE ON SEQUENCE dashboard.run_attempt_id_seq TO dashboard_runtime;
COMMIT;
