-- Snapshot the starting checkpoint so source coverage can be tied to this run.
ALTER TABLE dashboard.run_source
  ADD COLUMN checkpoint_version_start bigint CHECK (checkpoint_version_start IS NULL OR checkpoint_version_start >= 0),
  ADD COLUMN cursor_start jsonb;
