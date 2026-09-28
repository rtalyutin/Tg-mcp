-- Planning dates are owner edits, independent of daily curated snapshots.
CREATE TABLE dashboard.task_plan (
  task_id text PRIMARY KEY,
  start_date date,
  end_date date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_plan_dates CHECK (
    (start_date IS NULL AND end_date IS NULL) OR
    (start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= end_date)
  )
);
REVOKE ALL ON dashboard.task_plan FROM PUBLIC;
