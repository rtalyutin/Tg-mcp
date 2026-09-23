CREATE SCHEMA dashboard;

-- One source instance is one account/device/store. Both kinds remain mandatory.
CREATE TABLE dashboard.source (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('chatgpt', 'codex')),
  external_scope text NOT NULL CHECK (length(external_scope) > 0),
  UNIQUE (kind, external_scope)
);
CREATE TABLE dashboard.source_checkpoint (
  source_id uuid PRIMARY KEY REFERENCES dashboard.source(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  cursor jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dashboard.collection_run (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','partial','failed','completed')),
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE TABLE dashboard.run_source (
  run_id uuid NOT NULL REFERENCES dashboard.collection_run(id),
  source_id uuid NOT NULL REFERENCES dashboard.source(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','partial','failed','completed')),
  coverage text NOT NULL DEFAULT 'unknown'
    CHECK (coverage IN ('unknown','partial','verified_complete')),
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  error_code text,
  PRIMARY KEY (run_id, source_id),
  CHECK (status <> 'completed' OR coverage = 'verified_complete')
);
CREATE TABLE dashboard.ingest_batch (
  source_id uuid NOT NULL REFERENCES dashboard.source(id),
  batch_key text NOT NULL CHECK (length(batch_key) > 0),
  run_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  base_version bigint NOT NULL CHECK (base_version >= 0),
  committed_version bigint NOT NULL,
  cursor_after jsonb,
  event_count integer NOT NULL CHECK (event_count >= 0),
  inserted_count integer NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, batch_key),
  FOREIGN KEY (run_id, source_id) REFERENCES dashboard.run_source(run_id, source_id),
  CHECK (committed_version = base_version + 1),
  CHECK (inserted_count <= event_count)
);
-- Immutable source revisions. A revised message is a new revision, not a rewrite.
CREATE TABLE dashboard.source_event (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES dashboard.source(id),
  native_id text NOT NULL CHECK (length(native_id) > 0),
  revision text NOT NULL CHECK (length(revision) > 0),
  thread_id text NOT NULL CHECK (length(thread_id) > 0),
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  UNIQUE (source_id, native_id, revision),
  UNIQUE (source_id, id)
);
CREATE TABLE dashboard.batch_event (
  source_id uuid NOT NULL,
  batch_key text NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (source_id, batch_key, event_id),
  FOREIGN KEY (source_id, batch_key) REFERENCES dashboard.ingest_batch(source_id, batch_key),
  FOREIGN KEY (source_id, event_id) REFERENCES dashboard.source_event(source_id, id)
);
CREATE TABLE dashboard.run_attempt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL,
  source_id uuid NOT NULL,
  batch_key text,
  outcome text NOT NULL CHECK (outcome IN ('committed','replayed','rejected')),
  error_code text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, source_id) REFERENCES dashboard.run_source(run_id, source_id)
);

CREATE TABLE dashboard.folder (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES dashboard.source(id),
  native_id text NOT NULL,
  title text NOT NULL,
  UNIQUE (source_id, native_id)
);
CREATE TABLE dashboard.project (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  state_value text, -- No state vocabulary or automatic transition has been chosen.
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE dashboard.project_folder (
  project_id uuid NOT NULL REFERENCES dashboard.project(id),
  folder_id uuid NOT NULL REFERENCES dashboard.folder(id),
  PRIMARY KEY (project_id, folder_id)
);
CREATE TABLE dashboard.task (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  expected_result text,
  state_value text,
  progress_percent numeric(5,2) CHECK (progress_percent >= 0 AND progress_percent <= 100),
  progress_method text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((progress_percent IS NULL) = (progress_method IS NULL))
);
CREATE TABLE dashboard.task_project (
  task_id uuid NOT NULL REFERENCES dashboard.task(id),
  project_id uuid NOT NULL REFERENCES dashboard.project(id),
  PRIMARY KEY (task_id, project_id)
);
CREATE INDEX task_project_by_project ON dashboard.task_project(project_id, task_id);
CREATE TABLE dashboard.task_relation (
  from_task_id uuid NOT NULL REFERENCES dashboard.task(id),
  to_task_id uuid NOT NULL REFERENCES dashboard.task(id),
  relation_type text NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id, relation_type),
  CHECK (from_task_id <> to_task_id)
);
-- Separate owner-only preferences; no ingest code writes these tables.
CREATE TABLE dashboard.project_visibility (
  project_id uuid PRIMARY KEY REFERENCES dashboard.project(id),
  hidden boolean NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dashboard.folder_visibility (
  folder_id uuid PRIMARY KEY REFERENCES dashboard.folder(id),
  hidden boolean NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Extracted claims are not canonical state. Resolution policy is intentionally absent.
CREATE TABLE dashboard.change_proposal (
  id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL REFERENCES dashboard.source_event(id),
  extractor_version text NOT NULL,
  proposal_key text NOT NULL,
  proposed_change jsonb NOT NULL CHECK (jsonb_typeof(proposed_change) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, extractor_version, proposal_key)
);
CREATE TABLE dashboard.entity_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid REFERENCES dashboard.project(id),
  task_id uuid REFERENCES dashboard.task(id),
  proposal_id uuid REFERENCES dashboard.change_proposal(id),
  actor text NOT NULL,
  resolution_rule text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(project_id, task_id) = 1)
);
CREATE INDEX events_by_thread ON dashboard.source_event(source_id, thread_id, observed_at);
CREATE INDEX history_by_task ON dashboard.entity_history(task_id, id);

CREATE FUNCTION dashboard.reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'APPEND_ONLY' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER immutable_source_event BEFORE UPDATE OR DELETE ON dashboard.source_event
FOR EACH ROW EXECUTE FUNCTION dashboard.reject_history_mutation();
CREATE TRIGGER immutable_entity_history BEFORE UPDATE OR DELETE ON dashboard.entity_history
FOR EACH ROW EXECUTE FUNCTION dashboard.reject_history_mutation();
