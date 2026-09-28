-- An initial baseline or a result derived from a partial event feed has no
-- verified all-dialogue cutoff. NULL means exactly that; it must not be filled
-- with the wall-clock time of the run.
ALTER TABLE dashboard.daily_result
  ALTER COLUMN dialog_cutoff_at DROP NOT NULL;

ALTER TABLE dashboard.daily_result
  ADD CONSTRAINT daily_full_requires_dialog_cutoff
  CHECK (coverage = 'partial' OR dialog_cutoff_at IS NOT NULL);
