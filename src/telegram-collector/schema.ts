/** Additive, isolated collector schema; existing outreach/workspace tables are untouched. */
export const telegramCollectorMigrationSql = `
CREATE TABLE telegram_collector.state (
  bot_id text PRIMARY KEY,
  owner_id text NOT NULL,
  next_offset bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_update_at timestamptz,
  last_response_at timestamptz,
  last_poll_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$')
);
CREATE TABLE telegram_collector.connections (
  bot_id text NOT NULL REFERENCES telegram_collector.state(bot_id),
  connection_id text NOT NULL,
  owner_id text NOT NULL,
  is_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (bot_id, connection_id)
);
CREATE TABLE telegram_collector.updates (
  bot_id text NOT NULL REFERENCES telegram_collector.state(bot_id),
  update_id bigint NOT NULL,
  update_fingerprint text NOT NULL CHECK (update_fingerprint ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (bot_id, update_id, update_fingerprint)
);
CREATE TABLE telegram_collector.polling_gaps (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id text NOT NULL REFERENCES telegram_collector.state(bot_id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL CHECK (ended_at > started_at),
  retention_risk boolean NOT NULL,
  UNIQUE (bot_id, started_at, ended_at)
);
CREATE INDEX telegram_collector_polling_gaps_window ON telegram_collector.polling_gaps(bot_id, started_at, ended_at);
CREATE TABLE telegram_collector.events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  bot_id text NOT NULL REFERENCES telegram_collector.state(bot_id),
  owner_id text NOT NULL,
  update_id bigint NOT NULL,
  update_fingerprint text NOT NULL CHECK (update_fingerprint ~ '^[0-9a-f]{64}$'),
  event_kind text NOT NULL CHECK (event_kind IN ('created', 'edited', 'deleted')),
  connection_id text NOT NULL,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  source_message_id text NOT NULL,
  sender_id text,
  sender_business_bot_id text,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'unknown')),
  text text,
  media_kind text,
  media_file_unique_id text,
  message_at timestamptz,
  edit_at timestamptz,
  event_at timestamptz NOT NULL,
  event_time_basis text NOT NULL CHECK (event_time_basis IN ('message', 'edit', 'observed')),
  received_at timestamptz NOT NULL,
  deletion_content_known boolean NOT NULL DEFAULT false,
  UNIQUE (bot_id, update_id, update_fingerprint, event_kind, message_id)
);
CREATE INDEX telegram_collector_events_owner_seq ON telegram_collector.events(bot_id, owner_id, seq);
CREATE INDEX telegram_collector_events_event_time ON telegram_collector.events(bot_id, owner_id, event_at);
CREATE INDEX telegram_collector_events_received_time ON telegram_collector.events(bot_id, owner_id, received_at);
CREATE TABLE telegram_collector.messages (
  bot_id text NOT NULL REFERENCES telegram_collector.state(bot_id),
  owner_id text NOT NULL,
  connection_id text NOT NULL,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  source_message_id text NOT NULL,
  sender_id text,
  sender_business_bot_id text,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'unknown')),
  text text,
  media_kind text,
  media_file_unique_id text,
  message_at timestamptz,
  edit_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  latest_seq bigint NOT NULL REFERENCES telegram_collector.events(seq),
  PRIMARY KEY (bot_id, connection_id, chat_id, message_id)
);
`;
