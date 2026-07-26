ALTER TABLE events ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE race_commands ADD COLUMN request_fingerprint TEXT;

CREATE TABLE organization_event_defaults (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  timezone TEXT NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 64),
  email_required INTEGER NOT NULL CHECK (email_required IN (0, 1)),
  heat_assignment_mode TEXT NOT NULL CHECK (
    heat_assignment_mode IN ('IMMEDIATE_FIXED', 'POST_CLOSE_BALANCED')
  ),
  round_one_heat_capacity INTEGER NOT NULL CHECK (round_one_heat_capacity > 0),
  final_heat_capacity INTEGER NOT NULL CHECK (final_heat_capacity > 0),
  public_name_policy TEXT NOT NULL CHECK (
    public_name_policy IN ('FIRST_NAME_ONLY', 'FIRST_NAME_LAST_INITIAL', 'FULL_NAME')
  ),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT
);

INSERT INTO organization_event_defaults
  (singleton_id, timezone, email_required, heat_assignment_mode,
   round_one_heat_capacity, final_heat_capacity, public_name_policy, updated_at)
SELECT 1, timezone, email_required, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity, public_name_policy,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM events
 ORDER BY updated_at DESC, created_at DESC
 LIMIT 1;

INSERT OR IGNORE INTO organization_event_defaults
  (singleton_id, timezone, email_required, heat_assignment_mode,
   round_one_heat_capacity, final_heat_capacity, public_name_policy, updated_at)
VALUES
  (1, 'UTC', 0, 'POST_CLOSE_BALANCED', 10, 50,
   'FIRST_NAME_LAST_INITIAL', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
