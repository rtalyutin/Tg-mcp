-- Private, immutable daily baselines and deltas for the owner Dashboard task.
CREATE TABLE dashboard.daily_result (
  report_date date PRIMARY KEY,
  baseline_date date,
  baseline_digest text CHECK (baseline_digest IS NULL OR baseline_digest ~ '^[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  result_payload jsonb NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  group_memberships jsonb NOT NULL CHECK (jsonb_typeof(group_memberships) = 'object'),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  dialog_cutoff_at timestamptz NOT NULL,
  dialog_scan jsonb NOT NULL CHECK (jsonb_typeof(dialog_scan) = 'object'),
  coverage text NOT NULL CHECK (coverage IN ('partial', 'full')),
  state text NOT NULL CHECK (state IN ('prepared', 'applied', 'baseline_only')),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (baseline_date IS NULL OR baseline_date < report_date),
  CHECK ((state = 'applied' AND applied_at IS NOT NULL)
      OR (state <> 'applied' AND applied_at IS NULL)),
  CHECK (state <> 'baseline_only' OR jsonb_array_length(changes) = 0)
);

-- Permit exactly one recovery transition: prepared -> applied. Once published,
-- a daily result can only be superseded by an explicit future correction flow.
CREATE FUNCTION dashboard.guard_daily_result_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('applied', 'baseline_only') THEN
    RAISE EXCEPTION 'DAILY_RESULT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.report_date, NEW.baseline_date, NEW.baseline_digest,
         NEW.result_digest, NEW.result_payload, NEW.group_memberships,
         NEW.changes, NEW.dialog_cutoff_at, NEW.dialog_scan, NEW.coverage,
         NEW.prepared_at)
     IS DISTINCT FROM
     ROW(OLD.report_date, OLD.baseline_date, OLD.baseline_digest,
         OLD.result_digest, OLD.result_payload, OLD.group_memberships,
         OLD.changes, OLD.dialog_cutoff_at, OLD.dialog_scan, OLD.coverage,
         OLD.prepared_at)
     OR NEW.state NOT IN ('prepared', 'applied') THEN
    RAISE EXCEPTION 'DAILY_RESULT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER daily_result_immutable
BEFORE UPDATE ON dashboard.daily_result
FOR EACH ROW EXECUTE FUNCTION dashboard.guard_daily_result_update();

REVOKE ALL ON dashboard.daily_result FROM PUBLIC;
REVOKE ALL ON FUNCTION dashboard.guard_daily_result_update() FROM PUBLIC;
