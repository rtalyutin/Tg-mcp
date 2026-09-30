-- Additive hosting support; no changes to outreach/dashboard or exported domain tables.
CREATE TABLE host_keys (
  name text PRIMARY KEY CHECK (name = 'execution_signing'),
  secret text NOT NULL CHECK (length(secret) >= 43)
);
CREATE TABLE host_blobs (
  key text PRIMARY KEY,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
