-- Extend the existing durable email outbox to carry either independently
-- consented participant channel. Defaults keep the previously deployed Worker
-- able to insert its original email-only rows while this migration deploys
-- first.
ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

ALTER TABLE email_notifications
  ADD COLUMN lifecycle_key TEXT NOT NULL DEFAULT ''
  CHECK (length(lifecycle_key) <= 300);

ALTER TABLE email_notifications
  ADD COLUMN publication_failure_count INTEGER NOT NULL DEFAULT 0
  CHECK (publication_failure_count BETWEEN 0 AND 20);

ALTER TABLE email_notifications
  ADD COLUMN last_published_at TEXT;

-- The digest pins an unsubscribe capability to the address that actually
-- received that message. A later contact edit must not let possession of an old
-- email suppress the participant's new address.
ALTER TABLE email_notifications
  ADD COLUMN delivery_contact_hash TEXT
  CHECK (
    delivery_contact_hash IS NULL
    OR (length(delivery_contact_hash) = 64 AND delivery_contact_hash NOT GLOB '*[^0-9a-f]*')
  );

-- The former key predated channels and treated the nullable heat as the whole
-- occurrence identity. A stable lifecycle key now distinguishes registration,
-- assignment, reminder, result revision, and final-assignment occurrences. The
-- heat fallback preserves the previous Worker's uniqueness contract during the
-- migration-first deployment window, when that Worker writes an empty key.
DROP INDEX email_notifications_logical_message_idx;
CREATE UNIQUE INDEX email_notifications_logical_message_idx
  ON email_notifications(
    event_id,
    registration_id,
    channel,
    notification_type,
    COALESCE(NULLIF(lifecycle_key, ''), COALESCE(heat_id, ''))
  );

CREATE INDEX email_notifications_dispatch_idx
  ON email_notifications(status, retry_after, last_published_at, created_at);

-- Compliance suppression survives deletion of the race that first produced it.
-- Only a SHA-256 digest of the normalized destination is retained; neither this
-- table nor operational APIs need the address or phone number itself.
CREATE TABLE participant_notification_suppressions (
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  contact_hash TEXT NOT NULL CHECK (
    length(contact_hash) = 64 AND contact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source TEXT NOT NULL CHECK (
    source IN ('EMAIL_UNSUBSCRIBE', 'SMS_STOP', 'PROVIDER_SUPPRESSION', 'STAFF')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel, contact_hash)
);
