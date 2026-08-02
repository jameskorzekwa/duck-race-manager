-- Durable, channel-neutral participant notification outbox.
--
-- This is additive so the previously deployed Worker can keep using the
-- email_notifications outbox while migrations are ahead of Worker code. Round
-- One pairing keeps its compatible legacy assignment email while the
-- channel-neutral table owns SMS, stable reminders, and all new templates. No table
-- stores a contact value or rendered message.
ALTER TABLE heats
  ADD COLUMN notification_run_sequence INTEGER NOT NULL DEFAULT 1
  CHECK (notification_run_sequence > 0);

CREATE TABLE participant_notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  heat_id TEXT,
  heat_entry_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'REGISTRATION_CONFIRMATION',
    'ROUND_ONE_ASSIGNED',
    'FINAL_ASSIGNED',
    'HEAT_UPCOMING',
    'ROUND_RESULT',
    'FINAL_RESULT'
  )),
  lifecycle_key TEXT NOT NULL CHECK (length(lifecycle_key) BETWEEN 1 AND 512),
  run_sequence INTEGER CHECK (run_sequence IS NULL OR run_sequence > 0),
  result_revision INTEGER CHECK (result_revision IS NULL OR result_revision > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'QUEUED', 'SENDING', 'RETRY_PENDING',
    'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED'
  )),
  template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version = 1),
  publication_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (publication_failure_count >= 0),
  retry_after TEXT,
  queued_at TEXT,
  sending_started_at TEXT,
  sent_at TEXT,
  terminal_at TEXT,
  delivery_claim_token TEXT UNIQUE,
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id),
  UNIQUE (event_id, registration_id, channel, notification_type, lifecycle_key),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, heat_id)
    REFERENCES heats(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (heat_entry_id)
    REFERENCES heat_entries(id) ON DELETE SET NULL,
  CHECK (
    (status IN ('SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED'))
    = (terminal_at IS NOT NULL)
  )
);

CREATE INDEX participant_notifications_due_idx
  ON participant_notifications(status, retry_after, updated_at, created_at);
CREATE INDEX participant_notifications_event_idx
  ON participant_notifications(event_id, status, channel, created_at);

CREATE TABLE participant_notification_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  stage TEXT NOT NULL CHECK (stage IN ('QUEUE', 'DELIVERY')),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'SENDING', 'SENT', 'TEMPORARY_FAILURE', 'PERMANENT_FAILURE'
  )),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 256),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, notification_id)
    REFERENCES participant_notifications(event_id, id) ON DELETE CASCADE,
  UNIQUE (notification_id, attempt_number, stage)
);

CREATE INDEX participant_notification_attempts_notification_idx
  ON participant_notification_attempts(notification_id, stage, attempt_number DESC);

-- destination_hash is HMAC-SHA-256 with a dedicated Worker secret.  Raw email
-- addresses and phone numbers never enter this table.
CREATE TABLE participant_notification_suppressions (
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hash TEXT NOT NULL CHECK (
    length(destination_hash) = 64 AND destination_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reason TEXT NOT NULL CHECK (reason IN ('EMAIL_UNSUBSCRIBE', 'SMS_STOP', 'ADMINISTRATIVE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (channel, destination_hash)
);

-- Registration confirmation is part of the registration INSERT transaction.
CREATE TRIGGER participant_notification_registration_email
AFTER INSERT ON registrations
WHEN NEW.email_notifications_enabled = 1 AND NEW.email IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key)
  VALUES (lower(hex(randomblob(16))), NEW.event_id, NEW.id, 'EMAIL',
          'REGISTRATION_CONFIRMATION', NEW.id);
END;

CREATE TRIGGER participant_notification_registration_sms
AFTER INSERT ON registrations
WHEN NEW.sms_notifications_enabled = 1 AND NEW.phone IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key)
  VALUES (lower(hex(randomblob(16))), NEW.event_id, NEW.id, 'SMS',
          'REGISTRATION_CONFIRMATION', NEW.id);
END;

-- The legacy Worker already writes the first round-one assignment email.  This
-- trigger adds the independent SMS row without duplicating that email.
CREATE TRIGGER participant_notification_round_one_assignment_sms
AFTER INSERT ON heat_entries
WHEN NEW.round = 'ROUND_ONE'
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'EMAIL', 'ROUND_ONE_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND NEW.assignment_source <> 'PAIRING'
     AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL;
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'SMS', 'ROUND_ONE_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL;

  -- A walk-up can be assigned after Round One has begun. If this heat is
  -- already authoritative next, assignment is also the moment this participant
  -- becomes eligible for the current run's reminder.
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key, run_sequence)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         channel.value, 'HEAT_UPCOMING',
         NEW.heat_id || ':' || h.notification_run_sequence, h.notification_run_sequence
    FROM race_entries re
    JOIN registrations r ON r.id = re.registration_id
    JOIN heats h ON h.id = NEW.heat_id
    JOIN events e ON e.id = h.event_id
    JOIN (SELECT 'EMAIL' AS value UNION ALL SELECT 'SMS') channel
   WHERE re.id = NEW.race_entry_id AND e.status = 'ROUND_ONE'
     AND h.notification_run_sequence > 0
     AND h.id = (SELECT next.id FROM heats next
       WHERE next.event_id = NEW.event_id AND next.round = 'ROUND_ONE'
         AND next.status NOT IN ('FINALIZED', 'CANCELLED')
       ORDER BY next.heat_number LIMIT 1)
     AND r.status = 'ACTIVE'
     AND ((channel.value = 'EMAIL' AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL)
       OR (channel.value = 'SMS' AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL));
END;

-- A finalist slot is itself the committed final-assignment event.
CREATE TRIGGER participant_notification_final_assignment
AFTER INSERT ON heat_entries
WHEN NEW.round = 'FINAL'
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'EMAIL', 'FINAL_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL;
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'SMS', 'FINAL_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL;
END;

-- A close/reopen rebalance can assign an existing roster row to a different
-- heat.  That is a new assignment occurrence, keyed by the stable roster row
-- and its new heat rather than by the command that happened to move it.
CREATE TRIGGER participant_notification_reassignment
AFTER UPDATE OF heat_id ON heat_entries
WHEN OLD.heat_id <> NEW.heat_id
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'EMAIL', CASE NEW.round WHEN 'FINAL' THEN 'FINAL_ASSIGNED' ELSE 'ROUND_ONE_ASSIGNED' END,
         NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL;
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'SMS', CASE NEW.round WHEN 'FINAL' THEN 'FINAL_ASSIGNED' ELSE 'ROUND_ONE_ASSIGNED' END,
         NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL;
END;

-- A permitted round-one winner correction replaces the participant occupying a
-- still-loading final slot. The replacement finalist receives their own event;
-- the superseded finalist's pending row fails its delivery-time roster join.
CREATE TRIGGER participant_notification_corrected_final_assignment
AFTER UPDATE OF race_entry_id ON heat_entries
WHEN OLD.race_entry_id <> NEW.race_entry_id AND NEW.round = 'FINAL'
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'EMAIL', 'FINAL_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL;
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, NEW.id,
         'SMS', 'FINAL_ASSIGNED', NEW.id || ':' || NEW.heat_id
    FROM race_entries re JOIN registrations r ON r.id = re.registration_id
   WHERE re.id = NEW.race_entry_id AND r.status = 'ACTIVE'
     AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL;
END;

-- One result event is created for every racer on the heat.  A final result may
-- insert several podium rows, so uniqueness on heat+revision makes the trigger
-- idempotent across every row in that one official result set.
CREATE TRIGGER participant_notification_result
AFTER INSERT ON heat_results
WHEN NEW.status = 'FINALIZED'
BEGIN
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key, result_revision)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, he.id,
         'EMAIL', CASE h.round WHEN 'FINAL' THEN 'FINAL_RESULT' ELSE 'ROUND_RESULT' END,
         NEW.heat_id || ':' || NEW.revision, NEW.revision
    FROM heat_entries he
    JOIN heats h ON h.id = he.heat_id
    JOIN race_entries re ON re.id = he.race_entry_id
    JOIN registrations r ON r.id = re.registration_id
   WHERE he.heat_id = NEW.heat_id AND r.status = 'ACTIVE'
     AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL;
  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key, result_revision)
  SELECT lower(hex(randomblob(16))), NEW.event_id, r.id, NEW.heat_id, he.id,
         'SMS', CASE h.round WHEN 'FINAL' THEN 'FINAL_RESULT' ELSE 'ROUND_RESULT' END,
         NEW.heat_id || ':' || NEW.revision, NEW.revision
    FROM heat_entries he
    JOIN heats h ON h.id = he.heat_id
    JOIN race_entries re ON re.id = he.race_entry_id
    JOIN registrations r ON r.id = re.registration_id
   WHERE he.heat_id = NEW.heat_id AND r.status = 'ACTIVE'
     AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL;
END;

-- Reset creates a new run occurrence.  Corrections and repeated commands do
-- not touch this counter, so they cannot manufacture another reminder.
CREATE TRIGGER participant_notification_heat_reset_sequence
AFTER UPDATE OF status ON heats
WHEN NEW.status = 'LOADING'
 AND OLD.status IN ('READY', 'CALLING', 'RUNNING', 'AWAITING_RESULT')
BEGIN
  UPDATE heats
     SET notification_run_sequence = OLD.notification_run_sequence + 1
   WHERE id = NEW.id;
END;

-- Whenever progression changes, the earliest unfinished heat in that round is
-- authoritative. Both channels use the stable heat+run occurrence key.
CREATE TRIGGER participant_notification_next_heat
AFTER UPDATE OF status ON heats
BEGIN
  -- Do this here as well as in the dedicated invariant trigger so trigger
  -- creation order cannot make the reminder read the previous occurrence.
  UPDATE heats
     SET notification_run_sequence = OLD.notification_run_sequence + 1
   WHERE id = NEW.id AND NEW.status = 'LOADING'
     AND OLD.status IN ('READY', 'CALLING', 'RUNNING', 'AWAITING_RESULT');

  INSERT OR IGNORE INTO participant_notifications
    (id, event_id, registration_id, heat_id, heat_entry_id, channel,
     notification_type, lifecycle_key, run_sequence)
  SELECT lower(hex(randomblob(16))), target.event_id, r.id, target.id, he.id,
         channel.value, 'HEAT_UPCOMING',
         target.id || ':' || target.notification_run_sequence,
         target.notification_run_sequence
    FROM heats target
    JOIN events e ON e.id = target.event_id
    JOIN heat_entries he ON he.heat_id = target.id
    JOIN race_entries re ON re.id = he.race_entry_id
    JOIN registrations r ON r.id = re.registration_id
    JOIN (SELECT 'EMAIL' AS value UNION ALL SELECT 'SMS') channel
   WHERE target.id = (
     SELECT next.id FROM heats next
      WHERE next.event_id = NEW.event_id AND next.round = NEW.round
        AND next.status NOT IN ('FINALIZED', 'CANCELLED')
      ORDER BY next.heat_number LIMIT 1
   )
     AND target.notification_run_sequence > 0
     AND ((target.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
       OR (target.round = 'FINAL' AND e.status = 'FINAL'))
     AND r.status = 'ACTIVE'
     AND ((channel.value = 'EMAIL' AND r.email_notifications_enabled = 1 AND r.email IS NOT NULL)
       OR (channel.value = 'SMS' AND r.sms_notifications_enabled = 1 AND r.phone IS NOT NULL));
END;

-- A previous Worker still tries to create HEAT_UPCOMING in its legacy outbox
-- when CALL_HEAT runs. Once the stable generic occurrence exists, ignore that
-- compatibility write so a migration-first rollout or Worker rollback cannot
-- send the same reminder through both engines.
CREATE TRIGGER participant_notification_ignore_legacy_upcoming
BEFORE INSERT ON email_notifications
WHEN NEW.notification_type = 'HEAT_UPCOMING'
 AND EXISTS (
   SELECT 1 FROM participant_notifications current
    WHERE current.event_id = NEW.event_id
      AND current.registration_id = NEW.registration_id
      AND current.heat_id = NEW.heat_id
      AND current.channel = 'EMAIL'
      AND current.notification_type = 'HEAT_UPCOMING'
 )
BEGIN
  SELECT RAISE(IGNORE);
END;

-- The event status changes before the round-lock UPDATEs in the same batch.
-- Touching each first heat to its existing status invokes the progression
-- trigger only after the authoritative event transition has committed.
CREATE TRIGGER participant_notification_round_start
AFTER UPDATE OF status ON events
WHEN NEW.status IN ('ROUND_ONE', 'FINAL') AND OLD.status <> NEW.status
BEGIN
  UPDATE heats SET status = status
   WHERE id = (
     SELECT id FROM heats
      WHERE event_id = NEW.id
        AND round = CASE NEW.status WHEN 'FINAL' THEN 'FINAL' ELSE 'ROUND_ONE' END
        AND status NOT IN ('FINALIZED', 'CANCELLED')
      ORDER BY heat_number LIMIT 1
   );
END;
