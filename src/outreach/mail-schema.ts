/** Migration 6 is additive: existing registry and Telegram tables remain intact. */
export const mailMigrationSql = `
CREATE TABLE outreach_mail_proposals (
 id uuid PRIMARY KEY, opportunity_id uuid NOT NULL REFERENCES outreach_opportunities(id),
 current_version integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'draft'
 CHECK (state IN ('draft','awaiting_approval','approved')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outreach_mail_one_open_proposal ON outreach_mail_proposals(opportunity_id);
CREATE TABLE outreach_mail_versions (
 proposal_id uuid NOT NULL REFERENCES outreach_mail_proposals(id), version integer NOT NULL CHECK(version > 0),
 from_email text NOT NULL, reply_to text NOT NULL, to_email text NOT NULL,
 subject text NOT NULL, body text NOT NULL, content_hash text NOT NULL,
 basis text NOT NULL CHECK (basis = 'self_test'), author_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(proposal_id,version)
);
CREATE TABLE outreach_mail_approvals (
 id uuid PRIMARY KEY, proposal_id uuid NOT NULL, version integer NOT NULL,
 content_hash text NOT NULL, actor_id text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 FOREIGN KEY(proposal_id,version) REFERENCES outreach_mail_versions(proposal_id,version),
 UNIQUE(proposal_id,version)
);
CREATE TABLE outreach_mail_jobs (
 id uuid PRIMARY KEY, proposal_id uuid NOT NULL, version integer NOT NULL, approval_id uuid NOT NULL REFERENCES outreach_mail_approvals(id),
 status text NOT NULL CHECK(status IN ('queued','sending','paused','cancelled','sent','failed','unknown')),
 message_id text NOT NULL UNIQUE, attempt_id uuid, owner_instance_id uuid,
 attempt_started_at timestamptz, finished_at timestamptz, window_day text, smtp_code integer,
 failure_code text, resolution text CHECK(resolution IS NULL OR resolution='closed_without_retry'),
 resolution_note text, resolved_by text, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(proposal_id,version) REFERENCES outreach_mail_versions(proposal_id,version),
 UNIQUE(proposal_id,version)
);
CREATE INDEX outreach_mail_pending_jobs ON outreach_mail_jobs(created_at,id) WHERE status IN ('queued','sending','unknown');
CREATE TABLE outreach_mail_attempts (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES outreach_mail_jobs(id), owner_instance_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('sending','sent','failed','unknown')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, smtp_code integer, failure_code text
);
CREATE TABLE outreach_mail_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), paused boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO outreach_mail_settings(singleton) VALUES(true);
CREATE TABLE outreach_mail_suppressions (
 email_key text PRIMARY KEY, reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_mail_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, proposal_id uuid NOT NULL REFERENCES outreach_mail_proposals(id),
 job_id uuid REFERENCES outreach_mail_jobs(id), actor_id text NOT NULL, action text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_mail_operations (
 id uuid PRIMARY KEY, request_id text NOT NULL UNIQUE, command text NOT NULL,
 payload_hash text NOT NULL, actor_id text NOT NULL, status text NOT NULL CHECK(status IN ('succeeded','failed')),
 result jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Migration 7 adds only replies which can be tied to an existing outbound job. */
export const mailRepliesMigrationSql = `
CREATE TABLE outreach_mail_replies (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES outreach_mail_jobs(id),
 uid_validity text NOT NULL CHECK(uid_validity ~ '^[0-9]{1,20}$'),
 imap_uid bigint NOT NULL CHECK(imap_uid > 0 AND imap_uid <= 4294967295),
 received_message_id text,
 from_email text NOT NULL, to_email text NOT NULL,
 subject text NOT NULL, body text NOT NULL, truncated boolean NOT NULL DEFAULT false,
 received_at timestamptz NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(uid_validity,imap_uid), UNIQUE(received_message_id)
);
CREATE INDEX outreach_mail_replies_by_job ON outreach_mail_replies(job_id,received_at,id);
`;
