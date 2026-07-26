ALTER TABLE ducks ADD COLUMN physical_condition TEXT NOT NULL DEFAULT 'GOOD' CHECK (
  physical_condition IN ('GOOD', 'NEEDS_TAG', 'DAMAGED', 'RETIRED')
);
ALTER TABLE ducks ADD COLUMN storage_location TEXT CHECK (
  storage_location IS NULL OR length(storage_location) BETWEEN 1 AND 100
);
ALTER TABLE ducks ADD COLUMN notes TEXT CHECK (
  notes IS NULL OR length(notes) BETWEEN 1 AND 1000
);

CREATE TABLE duck_inventory_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  duck_id TEXT NOT NULL REFERENCES ducks(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (
    action IN (
      'DUCK_INTAKE',
      'DUCK_EDITED',
      'DUCK_TAG_REPLACED',
      'DUCK_TAG_RETIRED',
      'DUCK_ASSIGNED',
      'DUCK_REASSIGNED',
      'DUCK_UNASSIGNED',
      'DUCK_RESERVATION_RELEASED'
    )
  ),
  actor_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE CASCADE,
  UNIQUE (source_command_id, duck_id, action)
);

CREATE INDEX duck_inventory_events_duck_idx
  ON duck_inventory_events(duck_id, occurred_at DESC);
CREATE INDEX duck_inventory_events_event_idx
  ON duck_inventory_events(event_id, occurred_at DESC);
