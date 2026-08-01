-- A delivery claim must be distinguishable from every concurrent claim even
-- when two Worker invocations have the same millisecond timestamp. The column
-- is nullable so the previously deployed Worker can continue to write rows
-- while this migration is applied ahead of the new Worker.
ALTER TABLE email_notifications
  ADD COLUMN delivery_claim_token TEXT
  CHECK (delivery_claim_token IS NULL OR length(delivery_claim_token) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX email_notifications_delivery_claim_idx
  ON email_notifications(delivery_claim_token)
  WHERE delivery_claim_token IS NOT NULL;
