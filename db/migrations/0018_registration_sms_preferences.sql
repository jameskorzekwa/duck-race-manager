-- Participant SMS consent is independent from email consent and starts opted
-- out for every existing and newly-created registration.
--
-- This is backward compatible with the previously deployed Worker: all of its
-- registration inserts name their columns, so the default supplies the new
-- value. The contact requirement mirrors the existing email-consent invariant.
ALTER TABLE registrations
  ADD COLUMN sms_notifications_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (
    sms_notifications_enabled IN (0, 1)
    AND (phone IS NOT NULL OR sms_notifications_enabled = 0)
  );
