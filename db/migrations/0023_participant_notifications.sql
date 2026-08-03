-- Participant notifications share one durable outbox while retaining the
-- email_* table names used by the previously deployed Worker. New columns have
-- defaults (or are nullable), so that Worker can keep writing email reminders
-- while this migration is applied before the new Worker.
ALTER TABLE events
  ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (sms_notifications_enabled IN (0, 1));

ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

ALTER TABLE email_notifications
  ADD COLUMN lifecycle_key TEXT
  CHECK (lifecycle_key IS NULL OR length(lifecycle_key) BETWEEN 1 AND 160);

ALTER TABLE email_notifications
  ADD COLUMN result_place INTEGER
  CHECK (result_place IS NULL OR result_place > 0);

ALTER TABLE email_notifications
  ADD COLUMN result_revision INTEGER
  CHECK (result_revision IS NULL OR result_revision > 0);

ALTER TABLE email_notifications
  ADD COLUMN advanced_to_final INTEGER
  CHECK (advanced_to_final IS NULL OR advanced_to_final IN (0, 1));

-- Secret-keyed HMAC only. Raw destinations and enumerable plain hashes never
-- belong in D1. It is filled from the current destination immediately before a
-- send and is also the recipient binding for email unsubscribe capabilities.
ALTER TABLE email_notifications
  ADD COLUMN destination_hash TEXT
  CHECK (destination_hash IS NULL OR length(destination_hash) = 64);

-- A reset is a new running of the same physical heat. Upcoming-reminder keys use
-- this sequence, not an arbitrary command id, so retries/corrections cannot
-- create duplicates while a genuine rerun can produce one new reminder.
ALTER TABLE heats
  ADD COLUMN run_sequence INTEGER NOT NULL DEFAULT 1
  CHECK (run_sequence > 0);

DROP INDEX email_notifications_logical_message_idx;
CREATE UNIQUE INDEX email_notifications_logical_message_idx
  ON email_notifications(
    event_id,
    registration_id,
    channel,
    notification_type,
    COALESCE(heat_id, ''),
    COALESCE(lifecycle_key, '')
  );

CREATE INDEX email_notifications_channel_status_idx
  ON email_notifications(event_id, channel, status, created_at);

CREATE TABLE notification_suppressions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hash TEXT NOT NULL CHECK (length(destination_hash) = 64),
  source TEXT NOT NULL CHECK (source IN ('EMAIL_UNSUBSCRIBE', 'PROVIDER', 'STAFF')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE CASCADE,
  UNIQUE (channel, destination_hash)
);

CREATE INDEX notification_suppressions_event_idx
  ON notification_suppressions(event_id, channel, created_at);
