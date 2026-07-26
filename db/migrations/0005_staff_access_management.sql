ALTER TABLE staff_profiles ADD COLUMN created_by_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;

CREATE TABLE staff_access_commands (
  id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (command_type IN ('ADD_STAFF')),
  target_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  requested_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX staff_access_commands_target_idx
  ON staff_access_commands(target_staff_profile_id, created_at);

CREATE TABLE staff_access_audit_events (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES staff_access_commands(id) ON DELETE RESTRICT,
  actor_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  target_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('STAFF_ACCESS_GRANTED')),
  occurred_at TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX staff_access_audit_events_target_idx
  ON staff_access_audit_events(target_staff_profile_id, occurred_at);
