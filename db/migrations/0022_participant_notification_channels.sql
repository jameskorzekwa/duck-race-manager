-- Extend the existing durable outbox to independent participant channels. The
-- table names stay unchanged so the previously deployed Worker can continue to
-- insert and process email rows while this migration is applied first. SMS
-- storage types are prefixed so that same old Worker rejects them as unsupported
-- after a rollback instead of rendering them through its email-only path.
ALTER TABLE email_notifications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL'
  CHECK (channel IN ('EMAIL', 'SMS'));

CREATE TRIGGER email_notifications_channel_type_insert
BEFORE INSERT ON email_notifications
WHEN (NEW.channel = 'EMAIL' AND NEW.notification_type GLOB 'SMS_*')
  OR (NEW.channel = 'SMS' AND NEW.notification_type NOT GLOB 'SMS_*')
BEGIN
  SELECT RAISE(ABORT, 'notification channel/type mismatch');
END;

CREATE TRIGGER email_notifications_channel_type_update
BEFORE UPDATE OF channel, notification_type ON email_notifications
WHEN (NEW.channel = 'EMAIL' AND NEW.notification_type GLOB 'SMS_*')
  OR (NEW.channel = 'SMS' AND NEW.notification_type NOT GLOB 'SMS_*')
BEGIN
  SELECT RAISE(ABORT, 'notification channel/type mismatch');
END;

-- The old index described exactly the email default. Adding the channel keeps
-- that old-Worker uniqueness contract while allowing one independently claimed
-- SMS row for the same participant lifecycle event.
DROP INDEX email_notifications_logical_message_idx;
CREATE UNIQUE INDEX email_notifications_logical_message_idx
  ON email_notifications(
    event_id,
    registration_id,
    channel,
    COALESCE(heat_id, ''),
    notification_type
  );

CREATE INDEX email_notifications_channel_status_idx
  ON email_notifications(event_id, channel, status, created_at);
