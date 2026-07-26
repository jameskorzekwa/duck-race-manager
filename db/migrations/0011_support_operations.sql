CREATE TABLE email_notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  heat_id TEXT,
  notification_type TEXT NOT NULL CHECK (length(trim(notification_type)) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN (
      'WAITING_FOR_SYNC',
      'PENDING',
      'QUEUED',
      'SENDING',
      'SENT',
      'RETRY_PENDING',
      'DELIVERED',
      'FAILED',
      'BOUNCED',
      'COMPLAINED',
      'SUPPRESSED',
      'CANCELLED'
    )
  ),
  template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version > 0),
  created_by_command_id TEXT,
  scheduled_at TEXT,
  queued_at TEXT,
  sending_started_at TEXT,
  sent_at TEXT,
  terminal_at TEXT,
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  retry_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, heat_id)
    REFERENCES heats(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, created_by_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED'))
    = (terminal_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX email_notifications_logical_message_idx
  ON email_notifications(event_id, registration_id, COALESCE(heat_id, ''), notification_type);
CREATE INDEX email_notifications_event_status_idx
  ON email_notifications(event_id, status, created_at);

CREATE TABLE email_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  stage TEXT NOT NULL CHECK (stage IN ('QUEUE', 'DELIVERY')),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'QUEUED',
      'SENDING',
      'SENT',
      'DELIVERED',
      'TEMPORARY_FAILURE',
      'PERMANENT_FAILURE',
      'BOUNCED',
      'COMPLAINED'
    )
  ),
  source_command_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  provider_message_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  error_detail TEXT CHECK (error_detail IS NULL OR length(error_detail) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, notification_id)
    REFERENCES email_notifications(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  UNIQUE (notification_id, attempt_number, stage)
);

CREATE UNIQUE INDEX email_attempts_source_command_idx
  ON email_attempts(source_command_id) WHERE source_command_id IS NOT NULL;
CREATE INDEX email_attempts_notification_idx
  ON email_attempts(notification_id, attempt_number DESC, created_at DESC);

CREATE TABLE return_batches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINALIZING', 'FINALIZED')),
  source_command_id TEXT NOT NULL UNIQUE,
  started_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL,
  finalize_command_id TEXT UNIQUE,
  finalized_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id),
  CHECK (
    (status = 'FINALIZED')
    = (finalize_command_id IS NOT NULL AND finalized_by_staff_profile_id IS NOT NULL AND finalized_at IS NOT NULL)
  )
);

CREATE INDEX return_batches_event_status_idx ON return_batches(event_id, status, started_at);

CREATE TABLE return_batch_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  event_duck_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('RETURNED', 'KEPT', 'MISSING', 'DAMAGED', 'QUARANTINED', 'RETIRED', 'UNACCOUNTED_FOR')
  ),
  source_command_id TEXT NOT NULL UNIQUE,
  added_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  added_at TEXT NOT NULL,
  undo_command_id TEXT UNIQUE,
  undone_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, batch_id) REFERENCES return_batches(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, event_duck_id) REFERENCES event_ducks(event_id, id) ON DELETE CASCADE,
  UNIQUE (batch_id, sequence_number),
  CHECK (
    (undo_command_id IS NULL AND undone_by_staff_profile_id IS NULL AND undone_at IS NULL)
    OR (undo_command_id IS NOT NULL AND undone_by_staff_profile_id IS NOT NULL AND undone_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX return_batch_items_active_duck_idx
  ON return_batch_items(event_duck_id) WHERE undone_at IS NULL;
CREATE INDEX return_batch_items_batch_sequence_idx
  ON return_batch_items(batch_id, undone_at, sequence_number DESC);

CREATE TABLE event_purge_claims (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status = 'PURGING'),
  claimed_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL
);

CREATE TRIGGER events_require_purge_claim
BEFORE DELETE ON events
WHEN OLD.status = 'ARCHIVED'
  AND NOT EXISTS (
    SELECT 1 FROM event_purge_claims epc
     WHERE epc.event_id = OLD.id AND epc.status = 'PURGING'
  )
BEGIN
  SELECT RAISE(ABORT, 'archived event requires PURGING claim');
END;

CREATE TRIGGER purging_events_are_read_only
BEFORE UPDATE ON events
WHEN EXISTS (
  SELECT 1 FROM event_purge_claims epc
   WHERE epc.event_id = OLD.id AND epc.status = 'PURGING'
)
BEGIN
  SELECT RAISE(ABORT, 'PURGING event is read-only');
END;
