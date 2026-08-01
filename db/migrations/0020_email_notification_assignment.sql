-- Bind every new race reminder to the duck assignment that originated it.
-- The column stays nullable so the previously deployed Worker, which does not
-- name it, remains compatible while migrations deploy ahead of Worker code.
-- Null legacy rows are deliberately not backfilled from the current assignment:
-- after a replacement, that would incorrectly bless a different duck.
ALTER TABLE email_notifications
  ADD COLUMN duck_assignment_id TEXT
  REFERENCES duck_assignments(id) ON DELETE SET NULL;

CREATE INDEX email_notifications_assignment_idx
  ON email_notifications(duck_assignment_id)
  WHERE duck_assignment_id IS NOT NULL;
