ALTER TABLE staff_profiles ADD COLUMN role_revision INTEGER NOT NULL DEFAULT 0
  CHECK (role_revision >= 0);

ALTER TABLE staff_access_commands ADD COLUMN requested_account_type TEXT
  CHECK (requested_account_type IN ('ADMIN', 'STAFF'));
ALTER TABLE staff_access_commands ADD COLUMN requested_roles_json TEXT
  CHECK (requested_roles_json IS NULL OR json_valid(requested_roles_json));

ALTER TABLE staff_lifecycle_commands ADD COLUMN requested_roles_json TEXT
  CHECK (requested_roles_json IS NULL OR json_valid(requested_roles_json));
ALTER TABLE staff_lifecycle_commands ADD COLUMN expected_role_revision INTEGER
  CHECK (expected_role_revision IS NULL OR expected_role_revision >= 0);
ALTER TABLE staff_lifecycle_commands ADD COLUMN result_role_revision INTEGER
  CHECK (result_role_revision IS NULL OR result_role_revision >= 0);

CREATE TABLE staff_role_assignments (
  id TEXT PRIMARY KEY,
  staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN (
    'REGISTRATION',
    'DUCK_MANAGER',
    'ANNOUNCER',
    'HEAT_RUNNER',
    'RESULT_TAKER',
    'RETURN_STEWARD',
    'RACE_DIRECTOR'
  )),
  assigned_at TEXT NOT NULL,
  assigned_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_access_command_id TEXT REFERENCES staff_access_commands(id) ON DELETE RESTRICT,
  source_lifecycle_command_id TEXT REFERENCES staff_lifecycle_commands(id) ON DELETE RESTRICT,
  revoked_at TEXT,
  revoked_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  revocation_source_command_id TEXT REFERENCES staff_lifecycle_commands(id) ON DELETE RESTRICT,
  CHECK (
    (revoked_at IS NULL AND revoked_by_staff_profile_id IS NULL AND revocation_source_command_id IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_staff_profile_id IS NOT NULL AND revocation_source_command_id IS NOT NULL)
  ),
  CHECK (source_access_command_id IS NULL OR source_lifecycle_command_id IS NULL)
);

CREATE UNIQUE INDEX staff_role_assignments_current_idx
  ON staff_role_assignments(staff_profile_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX staff_role_assignments_history_idx
  ON staff_role_assignments(staff_profile_id, assigned_at, revoked_at);

UPDATE staff_access_commands
   SET requested_account_type = (
     SELECT CASE json_extract(a.details_json, '$.role')
              WHEN 'ADMIN' THEN 'ADMIN'
              WHEN 'STAFF' THEN 'STAFF'
              ELSE NULL
            END
       FROM staff_access_audit_events a
      WHERE a.command_id = staff_access_commands.id
        AND a.action = 'STAFF_ACCESS_GRANTED'
        AND json_valid(a.details_json)
      ORDER BY a.occurred_at, a.id
      LIMIT 1
   );

UPDATE staff_access_commands
   SET requested_roles_json = CASE requested_account_type
         WHEN 'ADMIN' THEN '[]'
         WHEN 'STAFF' THEN '["REGISTRATION","DUCK_MANAGER","ANNOUNCER","HEAT_RUNNER","RESULT_TAKER","RETURN_STEWARD","RACE_DIRECTOR"]'
         ELSE NULL
       END;

UPDATE staff_lifecycle_commands
   SET requested_roles_json = CASE requested_role
         WHEN 'ADMIN' THEN '[]'
         WHEN 'STAFF' THEN '["REGISTRATION","DUCK_MANAGER","ANNOUNCER","HEAT_RUNNER","RESULT_TAKER","RETURN_STEWARD","RACE_DIRECTOR"]'
         ELSE NULL
       END;
