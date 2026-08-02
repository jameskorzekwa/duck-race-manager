-- Generalize the existing durable email outbox without making the Worker that
-- is live during migration deployment incompatible. Its inserts omit every new
-- column, so EMAIL remains the default and legacy lifecycle keys stay nullable.
ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

ALTER TABLE email_notifications
  ADD COLUMN lifecycle_key TEXT
  CHECK (lifecycle_key IS NULL OR length(lifecycle_key) BETWEEN 1 AND 240);

ALTER TABLE email_notifications
  ADD COLUMN heat_run_sequence INTEGER
  CHECK (heat_run_sequence IS NULL OR heat_run_sequence >= 0);

ALTER TABLE email_notifications
  ADD COLUMN result_revision INTEGER
  CHECK (result_revision IS NULL OR result_revision > 0);

ALTER TABLE email_notifications
  ADD COLUMN unsubscribe_token TEXT
  CHECK (unsubscribe_token IS NULL OR length(unsubscribe_token) BETWEEN 32 AND 128);

ALTER TABLE email_notifications
  ADD COLUMN destination_hmac TEXT
  CHECK (
    destination_hmac IS NULL OR (
      length(destination_hmac) = 64
      AND destination_hmac NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE email_notifications
  ADD COLUMN destination_hmac_key_version INTEGER
  CHECK (destination_hmac_key_version IS NULL OR destination_hmac_key_version > 0);

-- A reset is a new authoritative occasion on which a heat can become next.
-- Keeping the sequence on the heat lets delayed work distinguish that occasion
-- from an older run even though reset deliberately clears started_at.
ALTER TABLE heats
  ADD COLUMN run_sequence INTEGER NOT NULL DEFAULT 0 CHECK (run_sequence >= 0);

DROP INDEX email_notifications_logical_message_idx;
CREATE UNIQUE INDEX participant_notifications_lifecycle_idx
  ON email_notifications(event_id, registration_id, channel, lifecycle_key)
  WHERE lifecycle_key IS NOT NULL;
CREATE UNIQUE INDEX participant_notifications_legacy_email_idx
  ON email_notifications(event_id, registration_id, COALESCE(heat_id, ''), notification_type)
  WHERE lifecycle_key IS NULL;
CREATE UNIQUE INDEX participant_notifications_unsubscribe_idx
  ON email_notifications(unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;
CREATE INDEX participant_notifications_dispatch_idx
  ON email_notifications(status, retry_after, updated_at, created_at);

-- Suppression is destination-scoped rather than race-scoped. It intentionally
-- has no event foreign key, so an email unsubscribe or carrier-managed SMS STOP
-- remains effective after the race dataset is deleted. destination_hmac is a
-- versioned HMAC-SHA-256 made with a Worker secret; raw destinations and
-- enumerable unkeyed digests are never stored here.
CREATE TABLE participant_notification_suppressions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  destination_hmac TEXT NOT NULL CHECK (
    length(destination_hmac) = 64
    AND destination_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('EMAIL_UNSUBSCRIBE', 'PROVIDER_SUPPRESSION', 'SMS_STOP')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (channel, key_version, destination_hmac)
);

CREATE INDEX participant_notification_suppressions_created_idx
  ON participant_notification_suppressions(created_at);

-- Do not let event cleanup race an external provider call after the consumer has
-- claimed it. A queued opaque ID is harmless after deletion, but SENDING means
-- the provider outcome is not yet recorded and deletion must be retried.
CREATE TRIGGER participant_notification_delete_while_sending
BEFORE DELETE ON email_notifications
WHEN OLD.status = 'SENDING'
BEGIN
  SELECT RAISE(ABORT, 'participant notification delivery is in progress');
END;

-- The previous Worker treats every PENDING/RETRY_PENDING row as email. New SMS
-- work uses WAITING_FOR_SYNC instead, and this guard makes an old support retry
-- fail closed rather than moving an SMS row into the old email dispatcher.
CREATE TRIGGER sms_notification_reject_legacy_email_states
BEFORE UPDATE OF status ON email_notifications
WHEN OLD.channel = 'SMS' AND NEW.status IN ('PENDING', 'RETRY_PENDING')
BEGIN
  SELECT RAISE(ABORT, 'SMS notification requires the channel-aware Worker');
END;

CREATE TRIGGER sms_notification_insert_reject_legacy_email_states
BEFORE INSERT ON email_notifications
WHEN NEW.channel = 'SMS' AND NEW.status IN ('PENDING', 'RETRY_PENDING')
BEGIN
  SELECT RAISE(ABORT, 'SMS notification requires the channel-aware Worker');
END;

CREATE TRIGGER participant_notification_destination_hmac_insert_pair
BEFORE INSERT ON email_notifications
WHEN (NEW.destination_hmac IS NULL) != (NEW.destination_hmac_key_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'destination HMAC and key version must be stored together');
END;

CREATE TRIGGER participant_notification_destination_hmac_update_pair
BEFORE UPDATE OF destination_hmac, destination_hmac_key_version ON email_notifications
WHEN (NEW.destination_hmac IS NULL) != (NEW.destination_hmac_key_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'destination HMAC and key version must be stored together');
END;
