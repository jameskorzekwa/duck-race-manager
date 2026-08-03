-- Generalize the existing durable email outbox without replacing it. Every
-- addition has a default or is nullable so the previously deployed Worker can
-- continue to read and write its HEAT_ASSIGNED/HEAT_UPCOMING email rows while
-- this migration is live ahead of the new Worker.
ALTER TABLE events
  ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (sms_notifications_enabled IN (0, 1));

ALTER TABLE heats
  ADD COLUMN notification_run_sequence INTEGER NOT NULL DEFAULT 1
  CHECK (notification_run_sequence > 0);

ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

ALTER TABLE email_notifications
  ADD COLUMN lifecycle_key TEXT
  CHECK (lifecycle_key IS NULL OR length(lifecycle_key) BETWEEN 1 AND 240);

ALTER TABLE email_notifications
  ADD COLUMN heat_run_sequence INTEGER
  CHECK (heat_run_sequence IS NULL OR heat_run_sequence > 0);

ALTER TABLE email_notifications
  ADD COLUMN result_revision INTEGER
  CHECK (result_revision IS NULL OR result_revision > 0);

-- Legacy logical messages retain exactly their former identity. New Worker
-- rows always name a lifecycle key, but nullable compatibility keeps an old
-- Worker insert valid during the deployment interval.
UPDATE email_notifications
   SET lifecycle_key = notification_type || ':' || COALESCE(heat_id, '')
 WHERE lifecycle_key IS NULL;

DROP INDEX email_notifications_logical_message_idx;

CREATE UNIQUE INDEX email_notifications_channel_lifecycle_idx
  ON email_notifications(event_id, registration_id, channel, lifecycle_key)
  WHERE lifecycle_key IS NOT NULL;

-- A previously deployed Worker can still insert rows without lifecycle_key
-- during the migration/deploy interval. Preserve its former logical uniqueness
-- instead of allowing duplicate legacy email work until the new Worker lands.
CREATE UNIQUE INDEX email_notifications_legacy_logical_message_idx
  ON email_notifications(event_id, registration_id, notification_type, COALESCE(heat_id, ''))
  WHERE lifecycle_key IS NULL;

-- The partial indexes above cannot compare a rolled-back Worker's null key
-- with a row backfilled by this migration. Close that staggered-deployment gap
-- explicitly so the old insert shape cannot duplicate an existing message.
CREATE TRIGGER email_notifications_legacy_cross_generation_unique
BEFORE INSERT ON email_notifications
WHEN NEW.lifecycle_key IS NULL
  AND EXISTS (
    SELECT 1
      FROM email_notifications existing
     WHERE existing.event_id = NEW.event_id
       AND existing.registration_id = NEW.registration_id
       AND existing.channel = NEW.channel
       AND existing.notification_type = NEW.notification_type
       AND COALESCE(existing.heat_id, '') = COALESCE(NEW.heat_id, '')
  )
BEGIN
  -- Match the old Worker's ON CONFLICT behavior: suppress the duplicate row
  -- without aborting the domain batch that also committed the lifecycle fact.
  SELECT RAISE(IGNORE);
END;

CREATE INDEX email_notifications_due_idx
  ON email_notifications(status, scheduled_at, retry_after, created_at);

-- Destination identifiers are keyed HMAC-SHA-256 digests computed by the
-- Worker. Raw email addresses and phone numbers never enter suppression state.
CREATE TABLE participant_notification_suppressions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hmac TEXT NOT NULL CHECK (
    length(destination_hmac) = 64
    AND destination_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  source TEXT NOT NULL CHECK (source IN ('EMAIL_UNSUBSCRIBE', 'PROVIDER_STOP', 'STAFF')),
  created_at TEXT NOT NULL,
  UNIQUE (channel, destination_hmac)
);

CREATE INDEX participant_notification_suppressions_created_idx
  ON participant_notification_suppressions(created_at);
