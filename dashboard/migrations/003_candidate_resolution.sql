-- One durable identity decision per extracted candidate. The import role has no
-- rights to this table; only the separate owner-side projection worker may use it.
CREATE TABLE dashboard.candidate_resolution (
  proposal_id uuid PRIMARY KEY REFERENCES dashboard.change_proposal(id),
  project_id uuid REFERENCES dashboard.project(id),
  task_id uuid REFERENCES dashboard.task(id),
  action text NOT NULL CHECK (action IN ('created','linked')),
  reason text NOT NULL CHECK (length(reason) > 0),
  resolver_version text NOT NULL CHECK (length(resolver_version) > 0),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(project_id,task_id) = 1)
);
