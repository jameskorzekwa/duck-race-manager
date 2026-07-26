CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(slug)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  event_date TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'DRAFT',
      'REGISTRATION_OPEN',
      'REGISTRATION_CLOSED',
      'ROUND_ONE',
      'FINAL',
      'COMPLETED',
      'RETURN_PROCESSING',
      'ARCHIVED'
    )
  ),
  registration_opens_at TEXT,
  registration_closes_at TEXT,
  email_required INTEGER NOT NULL DEFAULT 0 CHECK (email_required IN (0, 1)),
  heat_assignment_mode TEXT NOT NULL DEFAULT 'POST_CLOSE_BALANCED' CHECK (
    heat_assignment_mode IN ('IMMEDIATE_FIXED', 'POST_CLOSE_BALANCED')
  ),
  round_one_heat_capacity INTEGER NOT NULL DEFAULT 10 CHECK (round_one_heat_capacity > 0),
  final_heat_capacity INTEGER NOT NULL DEFAULT 50 CHECK (final_heat_capacity > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    registration_opens_at IS NULL
    OR registration_closes_at IS NULL
    OR registration_opens_at < registration_closes_at
  )
);

CREATE INDEX events_status_date_idx ON events(status, event_date);

CREATE TABLE registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 80),
  last_name TEXT NOT NULL CHECK (length(trim(last_name)) BETWEEN 1 AND 80),
  email TEXT COLLATE NOCASE CHECK (email IS NULL OR length(email) <= 254),
  phone TEXT CHECK (phone IS NULL OR length(phone) <= 32),
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (
    status IN ('SUBMITTED', 'ACTIVE', 'WITHDRAWN', 'DISQUALIFIED')
  ),
  lookup_code TEXT NOT NULL COLLATE NOCASE,
  private_token_hash TEXT NOT NULL UNIQUE,
  email_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (
    email_notifications_enabled IN (0, 1)
  ),
  created_via TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (created_via IN ('PUBLIC', 'STAFF')),
  submitted_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id),
  UNIQUE (event_id, lookup_code),
  CHECK (email IS NOT NULL OR email_notifications_enabled = 0)
);

CREATE INDEX registrations_event_status_idx ON registrations(event_id, status, submitted_at);
CREATE INDEX registrations_event_name_idx ON registrations(event_id, last_name, first_name);

CREATE TABLE race_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  registration_id TEXT NOT NULL UNIQUE,
  duck_keep_preference TEXT NOT NULL DEFAULT 'UNDECIDED' CHECK (
    duck_keep_preference IN ('KEEP', 'RETURN', 'UNDECIDED')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, registration_id)
    REFERENCES registrations(event_id, id) ON DELETE RESTRICT
);

CREATE INDEX race_entries_event_idx ON race_entries(event_id);

CREATE TABLE ducks (
  id TEXT PRIMARY KEY,
  visible_number INTEGER NOT NULL UNIQUE CHECK (visible_number > 0),
  inventory_status TEXT NOT NULL DEFAULT 'NEW' CHECK (
    inventory_status IN (
      'NEW',
      'AVAILABLE',
      'RESERVED_FOR_EVENT',
      'IN_USE',
      'QUARANTINED',
      'DAMAGED',
      'MISSING',
      'UNACCOUNTED_FOR',
      'KEPT',
      'RETIRED'
    )
  ),
  inventory_status_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE duck_tags (
  id TEXT PRIMARY KEY,
  duck_id TEXT NOT NULL REFERENCES ducks(id) ON DELETE RESTRICT,
  token TEXT NOT NULL COLLATE BINARY UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'WRITTEN', 'VERIFIED', 'ACTIVE', 'RETIRED')),
  supersedes_tag_id TEXT REFERENCES duck_tags(id) ON DELETE RESTRICT,
  written_at TEXT,
  verified_at TEXT,
  activated_at TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (supersedes_tag_id IS NULL OR supersedes_tag_id != id)
);

CREATE UNIQUE INDEX duck_tags_one_active_per_duck_idx
  ON duck_tags(duck_id) WHERE status = 'ACTIVE';

CREATE TABLE race_commands (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  command_type TEXT NOT NULL,
  result_id TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX race_commands_event_idx ON race_commands(event_id, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  command_id TEXT REFERENCES race_commands(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('PUBLIC', 'STAFF', 'SYSTEM')),
  occurred_at TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX audit_events_subject_idx ON audit_events(subject_type, subject_id, occurred_at);
CREATE INDEX audit_events_event_idx ON audit_events(event_id, occurred_at);
