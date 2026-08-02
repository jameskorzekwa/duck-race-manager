-- Channel-neutral participant notification outbox. The existing email tables
-- remain intact so a previously deployed Worker can drain its email queue while
-- this additive migration is live. New SMS work is never visible to that
-- Worker and is published through a separate queue binding.
CREATE TABLE participant_notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'REGISTRATION_CONFIRMED',
    'ROUND_ONE_ASSIGNED',
    'FINAL_ASSIGNED',
    'HEAT_UPCOMING',
    'ROUND_RESULT',
    'FINAL_RESULT'
  )),
  lifecycle_key TEXT NOT NULL CHECK (length(lifecycle_key) BETWEEN 1 AND 200),
  heat_id TEXT,
  duck_assignment_id TEXT,
  result_revision INTEGER CHECK (result_revision IS NULL OR result_revision > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'QUEUED', 'SENDING', 'RETRY_PENDING', 'SENT',
    'SUPPRESSED', 'CANCELLED', 'FAILED'
  )),
  template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version > 0),
  created_by_command_id TEXT NOT NULL,
  scheduled_at TEXT,
  queued_at TEXT,
  sending_started_at TEXT,
  delivery_claim_token TEXT
    CHECK (delivery_claim_token IS NULL OR length(delivery_claim_token) BETWEEN 1 AND 128),
  sent_at TEXT,
  terminal_at TEXT,
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  retry_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id),
  UNIQUE (event_id, registration_id, channel, notification_type, lifecycle_key),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, heat_id)
    REFERENCES heats(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (duck_assignment_id)
    REFERENCES duck_assignments(id) ON DELETE SET NULL,
  FOREIGN KEY (event_id, created_by_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('SENT', 'SUPPRESSED', 'CANCELLED', 'FAILED'))
    = (terminal_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX participant_notifications_delivery_claim_idx
  ON participant_notifications(delivery_claim_token)
  WHERE delivery_claim_token IS NOT NULL;
CREATE INDEX participant_notifications_dispatch_idx
  ON participant_notifications(status, retry_after, queued_at, created_at);
CREATE INDEX participant_notifications_event_status_idx
  ON participant_notifications(event_id, status, created_at);

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
  provider_message_id TEXT
    CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 256),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, notification_id)
    REFERENCES participant_notifications(event_id, id) ON DELETE CASCADE,
  UNIQUE (notification_id, attempt_number, stage)
);

CREATE INDEX participant_notification_attempts_notification_idx
  ON participant_notification_attempts(notification_id, stage, attempt_number DESC);

-- Participant-initiated unsubscribe state is deliberately channel-specific.
-- It carries no contact value or provider payload and is consulted again after
-- a delivery claim, immediately before the provider adapter is called.
CREATE TABLE participant_notification_suppressions (
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  source TEXT NOT NULL CHECK (source IN (
    'EMAIL_UNSUBSCRIBE', 'PROVIDER_SUPPRESSION', 'SMS_STOP', 'SUPPORT'
  )),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, registration_id, channel),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE CASCADE
);
