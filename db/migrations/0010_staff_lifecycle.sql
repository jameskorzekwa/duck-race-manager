ALTER TABLE staff_profiles ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1
  CHECK (is_active IN (0, 1));

CREATE INDEX staff_profiles_active_admin_idx
  ON staff_profiles(is_active, is_system_admin);

CREATE TABLE staff_lifecycle_commands (
  id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (command_type IN (
    'CHANGE_STAFF_ROLE',
    'DEACTIVATE_STAFF',
    'REACTIVATE_STAFF'
  )),
  target_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  requested_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  requested_role TEXT CHECK (requested_role IN ('ADMIN', 'STAFF')),
  result_is_system_admin INTEGER NOT NULL CHECK (result_is_system_admin IN (0, 1)),
  result_is_active INTEGER NOT NULL CHECK (result_is_active IN (0, 1)),
  requested_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (command_type = 'CHANGE_STAFF_ROLE' AND requested_role IS NOT NULL)
    OR (command_type != 'CHANGE_STAFF_ROLE' AND requested_role IS NULL)
  )
);

CREATE INDEX staff_lifecycle_commands_target_idx
  ON staff_lifecycle_commands(target_staff_profile_id, created_at);

CREATE TABLE staff_lifecycle_audit_events (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES staff_lifecycle_commands(id) ON DELETE RESTRICT,
  actor_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  target_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'STAFF_ROLE_CHANGED',
    'STAFF_DEACTIVATED',
    'STAFF_REACTIVATED'
  )),
  occurred_at TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX staff_lifecycle_audit_events_target_idx
  ON staff_lifecycle_audit_events(target_staff_profile_id, occurred_at);

CREATE TRIGGER staff_profiles_keep_active_admin_on_update
BEFORE UPDATE OF is_active, is_system_admin ON staff_profiles
WHEN OLD.is_active = 1
  AND OLD.is_system_admin = 1
  AND (NEW.is_active = 0 OR NEW.is_system_admin = 0)
  AND NOT EXISTS (
    SELECT 1
      FROM staff_profiles
     WHERE id != OLD.id AND is_active = 1 AND is_system_admin = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'at least one active system administrator is required');
END;

CREATE TRIGGER staff_profiles_keep_active_admin_on_delete
BEFORE DELETE ON staff_profiles
WHEN OLD.is_active = 1
  AND OLD.is_system_admin = 1
  AND NOT EXISTS (
    SELECT 1
      FROM staff_profiles
     WHERE id != OLD.id AND is_active = 1 AND is_system_admin = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'at least one active system administrator is required');
END;
