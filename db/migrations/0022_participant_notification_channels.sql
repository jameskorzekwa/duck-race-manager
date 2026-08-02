-- Generalize the durable email outbox without making the previously deployed
-- Worker unable to read or write it. Omitted channels remain EMAIL and a null
-- lifecycle key is reserved for that Worker's legacy inserts.
ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

ALTER TABLE email_notifications
  ADD COLUMN lifecycle_key TEXT
  CHECK (lifecycle_key IS NULL OR length(lifecycle_key) BETWEEN 1 AND 255);

ALTER TABLE email_notifications
  ADD COLUMN result_revision INTEGER
  CHECK (result_revision IS NULL OR result_revision > 0);

DROP INDEX email_notifications_logical_message_idx;

-- The fallback expression preserves the old logical-message uniqueness rule
-- for inserts made by a rolled-back Worker. New work supplies an immutable key
-- for the precise lifecycle occurrence and is unique independently by channel.
CREATE UNIQUE INDEX email_notifications_channel_lifecycle_idx
  ON email_notifications(
    event_id,
    registration_id,
    channel,
    COALESCE(
      lifecycle_key,
      'LEGACY:' || COALESCE(heat_id, '') || ':' || notification_type
    )
  );

CREATE INDEX email_notifications_channel_status_idx
  ON email_notifications(channel, status, created_at);

-- Suppression is destination-scoped rather than event-scoped so an email
-- unsubscribe or carrier STOP survives event deletion. Only a one-way digest of
-- the canonical destination is retained; raw addresses and numbers stay in the
-- participant record that already owns them.
CREATE TABLE notification_suppressions (
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hash TEXT NOT NULL CHECK (
    length(destination_hash) = 64
    AND destination_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'EMAIL_UNSUBSCRIBE',
      'SES_SUPPRESSED',
      'SMS_STOP',
      'PROVIDER_SUPPRESSED'
    )
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel, destination_hash)
);

-- The capability is random and only its digest is stored. This table has no
-- event or registration foreign key deliberately: a message's unsubscribe link
-- remains safe and useful after the race dataset is deleted.
CREATE TABLE notification_unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  destination_hash TEXT NOT NULL CHECK (
    length(destination_hash) = 64
    AND destination_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX notification_unsubscribe_destination_idx
  ON notification_unsubscribe_tokens(destination_hash, expires_at);
