CREATE TABLE workspaces (
 owner_id uuid PRIMARY KEY, title text NOT NULL, timezone text NOT NULL DEFAULT 'Europe/Moscow',
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE projects (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, parent_id uuid, title text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), current_work_item_id uuid,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), FOREIGN KEY(owner_id,parent_id) REFERENCES projects(owner_id,id), CHECK(id IS DISTINCT FROM parent_id)
);
CREATE TABLE work_items (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, project_id uuid NOT NULL,
 title text NOT NULL, goal text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'planned'
 CHECK(status IN ('planned','active','blocked','completed','archived')), previous_status text, accepted_continuation_id uuid,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,project_id,id), FOREIGN KEY(owner_id,project_id) REFERENCES projects(owner_id,id)
);
ALTER TABLE projects ADD FOREIGN KEY(owner_id,id,current_work_item_id) REFERENCES work_items(owner_id,project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE artifacts (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('text','file','external')), current_version_id uuid,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE artifact_versions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, artifact_id uuid NOT NULL, content text, blob_key text,
 content_hash text NOT NULL, external_ref text, observed_revision text, author text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(owner_id,artifact_id,id),
 FOREIGN KEY(owner_id,artifact_id) REFERENCES artifacts(owner_id,id),
 CHECK(num_nonnulls(content,blob_key,external_ref)=1)
);
ALTER TABLE artifacts ADD FOREIGN KEY(owner_id,id,current_version_id) REFERENCES artifact_versions(owner_id,artifact_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE artifact_links (
 owner_id uuid NOT NULL, artifact_id uuid NOT NULL, work_item_id uuid NOT NULL,
 PRIMARY KEY(owner_id,artifact_id,work_item_id), FOREIGN KEY(owner_id,artifact_id) REFERENCES artifacts(owner_id,id), FOREIGN KEY(owner_id,work_item_id) REFERENCES work_items(owner_id,id)
);
CREATE TABLE proposals (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid,
 kind text NOT NULL CHECK(kind IN ('decision','continuation','permission')),
 body jsonb NOT NULL, author text NOT NULL, status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','revoked')),
 accepted_by text, accepted_at timestamptz, revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,project_id) REFERENCES projects(owner_id,id), FOREIGN KEY(owner_id,project_id,work_item_id) REFERENCES work_items(owner_id,project_id,id),
 CHECK(kind <> 'continuation' OR work_item_id IS NOT NULL)
);
ALTER TABLE work_items ADD FOREIGN KEY(owner_id,accepted_continuation_id) REFERENCES proposals(owner_id,id);
CREATE TABLE skills (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, name text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('owned','platform','third_party')), source_ref text NOT NULL,
 current_version_id uuid, revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE skill_versions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, skill_id uuid NOT NULL, version text NOT NULL, manifest jsonb NOT NULL,
 digest text NOT NULL, requirements jsonb NOT NULL DEFAULT '[]', triggers jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(owner_id,skill_id,id), UNIQUE(skill_id,version),
 FOREIGN KEY(owner_id,skill_id) REFERENCES skills(owner_id,id)
);
ALTER TABLE skills ADD FOREIGN KEY(owner_id,id,current_version_id) REFERENCES skill_versions(owner_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE connectors (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, name text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('owned','platform','third_party')), transport text NOT NULL,
 location text NOT NULL CHECK(location IN ('remote','desktop','native')), metadata jsonb NOT NULL DEFAULT '{}',
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE capability_observations (
 owner_id uuid NOT NULL, connector_id uuid NOT NULL, executor_id text NOT NULL, capability text NOT NULL,
 configured boolean NOT NULL, reachable boolean NOT NULL, authenticated boolean NOT NULL, allowed boolean NOT NULL,
 identity_ref text, actions jsonb NOT NULL DEFAULT '[]', observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 reason text, PRIMARY KEY(owner_id,connector_id,executor_id,capability), FOREIGN KEY(owner_id,connector_id) REFERENCES connectors(owner_id,id)
);
CREATE TABLE context_snapshots (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid NOT NULL,
 body jsonb NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 UNIQUE(owner_id,project_id,work_item_id,id), FOREIGN KEY(owner_id,project_id,work_item_id) REFERENCES work_items(owner_id,project_id,id)
);
CREATE TABLE runs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 executor_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('discussion','execution')),
 trigger text NOT NULL, status text NOT NULL DEFAULT 'awaiting_executor' CHECK(status IN ('awaiting_executor','dispatch_unknown','running','waiting_user','blocked','unknown','cancel_requested','succeeded','failed','cancelled')),
 parent_run_id uuid, provider_session_ref text, provider_turn_id text, provider_wait_reason text, dispatch_intent_at timestamptz, cancel_dispatched_at timestamptz, result_ref uuid,
 cancellation_requested_at timestamptz, attempt_id uuid, attempt_executor text, lease_until timestamptz,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,id,attempt_id), FOREIGN KEY(owner_id,parent_run_id) REFERENCES runs(owner_id,id),
 FOREIGN KEY(owner_id,project_id,work_item_id,snapshot_id) REFERENCES context_snapshots(owner_id,project_id,work_item_id,id)
);
CREATE TABLE run_results (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL,
 body jsonb NOT NULL, stale_input boolean NOT NULL, cancelled_run boolean NOT NULL, applied boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), FOREIGN KEY(owner_id,run_id,attempt_id) REFERENCES runs(owner_id,id,attempt_id),
 CHECK(NOT applied OR (NOT stale_input AND NOT cancelled_run))
);
ALTER TABLE runs ADD FOREIGN KEY(owner_id,result_ref) REFERENCES run_results(owner_id,id);
CREATE TABLE provider_inputs (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,run_id uuid NOT NULL,answer text NOT NULL,baseline_turn_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','unknown','reconciled')),
 dispatch_intent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,run_id) REFERENCES runs(owner_id,id)
);
CREATE UNIQUE INDEX pending_provider_input ON provider_inputs(run_id) WHERE status IN ('pending','accepted','unknown');
CREATE TABLE recurring_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, work_item_id uuid NOT NULL,
 instruction text NOT NULL, instruction_revision bigint NOT NULL DEFAULT 1, schedule jsonb NOT NULL, schedule_revision bigint NOT NULL DEFAULT 1,
 timezone text NOT NULL, executor_id text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','blocked','retired')),
 next_planned_at timestamptz, next_skipped_dst boolean NOT NULL DEFAULT false, provider_ref text,
 replacement_ref text, old_pause_status text CHECK(old_pause_status IN ('confirmed','unknown','not_requested')), reference_only boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,work_item_id) REFERENCES work_items(owner_id,id)
);
CREATE TABLE occurrences (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL, schedule_revision bigint NOT NULL, planned_at_utc timestamptz NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('enqueued','skipped_overlap','skipped_downtime','skipped_dst','blocked')), run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,schedule_revision,planned_at_utc),
 FOREIGN KEY(owner_id,job_id) REFERENCES recurring_jobs(owner_id,id), FOREIGN KEY(owner_id,run_id) REFERENCES runs(owner_id,id)
);
CREATE TABLE attention_events (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, project_id uuid NOT NULL, work_item_id uuid,
 source text NOT NULL, source_event_id text NOT NULL, type text NOT NULL CHECK(type IN ('result_ready','decision_required','obstacle','change_detected')),
 reason text NOT NULL, refs jsonb NOT NULL DEFAULT '[]', state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','snoozed','resolved')),
 read_at timestamptz, snoozed_until timestamptz, resolution text, revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(owner_id,source,source_event_id),
 FOREIGN KEY(owner_id,project_id) REFERENCES projects(owner_id,id), FOREIGN KEY(owner_id,project_id,work_item_id) REFERENCES work_items(owner_id,project_id,id),
 CHECK(state <> 'snoozed' OR snoozed_until IS NOT NULL), CHECK(state <> 'resolved' OR resolution IS NOT NULL)
);
CREATE TABLE operation_receipts (
 owner_id uuid NOT NULL REFERENCES workspaces, operation_id uuid NOT NULL, payload_hash text NOT NULL,
 operation_kind text NOT NULL, actor text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,operation_id)
);
CREATE TABLE audit_events (
 id bigserial PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, operation_id uuid, actor text NOT NULL, kind text NOT NULL,
 target_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (
 event_id text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES workspaces, session_id text, event_type text NOT NULL,
 payload_hash text NOT NULL, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_queue ON runs(owner_id,executor_id,status,created_at);
CREATE INDEX runs_session ON runs(provider_session_ref) WHERE provider_session_ref IS NOT NULL;
CREATE INDEX attention_dashboard ON attention_events(owner_id,state,created_at DESC,id);
CREATE INDEX jobs_due ON recurring_jobs(next_planned_at) WHERE status='active';
CREATE INDEX audit_owner_cursor ON audit_events(owner_id,id);
CREATE FUNCTION forbid_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_artifact_version BEFORE UPDATE OR DELETE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION forbid_immutable_change();
CREATE TRIGGER immutable_skill_version BEFORE UPDATE OR DELETE ON skill_versions FOR EACH ROW EXECUTE FUNCTION forbid_immutable_change();
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON context_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_immutable_change();
CREATE TRIGGER immutable_run_result BEFORE UPDATE OR DELETE ON run_results FOR EACH ROW EXECUTE FUNCTION forbid_immutable_change();
CREATE FUNCTION protect_run_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.owner_id,OLD.project_id,OLD.work_item_id,OLD.snapshot_id,OLD.kind,OLD.executor_id) IS DISTINCT FROM ROW(NEW.owner_id,NEW.project_id,NEW.work_item_id,NEW.snapshot_id,NEW.kind,NEW.executor_id) THEN
  RAISE EXCEPTION 'run identity is immutable' USING ERRCODE='55000';
 END IF;
 IF OLD.cancellation_requested_at IS NOT NULL AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at THEN
  RAISE EXCEPTION 'cancellation is irreversible' USING ERRCODE='55000';
 END IF;
 IF NEW.cancellation_requested_at IS NOT NULL AND NEW.status='succeeded' THEN
  RAISE EXCEPTION 'cancelled run cannot succeed' USING ERRCODE='55000';
 END IF;
 IF OLD.status IN ('succeeded','failed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'terminal run is immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_run BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION protect_run_identity();
-- Cross-table pointers are checked at commit. This also permits lossless restore
-- of a complete export with circular current-version/result references.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace AND conrelid IN (SELECT oid FROM pg_class WHERE relname IN ('projects','work_items','artifacts','artifact_versions','artifact_links','proposals','skills','skill_versions','connectors','capability_observations','context_snapshots','runs','run_results','provider_inputs','recurring_jobs','occurrences','attention_events','operation_receipts','audit_events','webhook_events')) LOOP
  EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',r.tbl,r.conname);
 END LOOP;
END $$;
