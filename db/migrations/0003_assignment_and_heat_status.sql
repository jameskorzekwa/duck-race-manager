CREATE UNIQUE INDEX race_entries_event_id_idx ON race_entries(event_id, id);

CREATE TABLE event_ducks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  duck_id TEXT NOT NULL REFERENCES ducks(id) ON DELETE RESTRICT,
  reserved_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id, duck_id),
  CHECK (released_at IS NULL OR released_at >= reserved_at)
);

CREATE UNIQUE INDEX event_ducks_active_duck_idx
  ON event_ducks(duck_id) WHERE released_at IS NULL;
CREATE INDEX event_ducks_event_idx ON event_ducks(event_id, released_at);

CREATE TABLE duck_assignments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  event_duck_id TEXT NOT NULL,
  duck_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  end_reason TEXT,
  assigned_by_staff_profile_id TEXT REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL REFERENCES race_commands(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, id, race_entry_id),
  FOREIGN KEY (event_id, race_entry_id)
    REFERENCES race_entries(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, event_duck_id, duck_id)
    REFERENCES event_ducks(event_id, id, duck_id) ON DELETE RESTRICT,
  CHECK ((valid_to IS NULL AND end_reason IS NULL) OR (valid_to IS NOT NULL AND end_reason IS NOT NULL)),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX duck_assignments_active_entry_idx
  ON duck_assignments(race_entry_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX duck_assignments_active_duck_idx
  ON duck_assignments(duck_id) WHERE valid_to IS NULL;
CREATE INDEX duck_assignments_event_idx ON duck_assignments(event_id, valid_to);

CREATE TABLE heats (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  round_type TEXT NOT NULL CHECK (round_type IN ('ROUND_ONE', 'FINAL')),
  heat_number INTEGER NOT NULL CHECK (heat_number > 0),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (
    status IN ('PLANNED', 'CALLING', 'RUNNING', 'COMPLETED', 'CANCELLED')
  ),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, round_type, heat_number),
  UNIQUE (event_id, id),
  CHECK (completed_at IS NULL OR started_at IS NOT NULL),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX heats_one_running_per_event_idx
  ON heats(event_id) WHERE status = 'RUNNING';
CREATE INDEX heats_event_status_idx ON heats(event_id, status, round_type, heat_number);

CREATE TABLE heat_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  lane_number INTEGER CHECK (lane_number IS NULL OR lane_number > 0),
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (
    status IN ('SCHEDULED', 'CALLED', 'STARTED', 'FINISHED', 'WITHDRAWN', 'DISQUALIFIED')
  ),
  result_position INTEGER CHECK (result_position IS NULL OR result_position > 0),
  advanced INTEGER NOT NULL DEFAULT 0 CHECK (advanced IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, heat_id)
    REFERENCES heats(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, race_entry_id)
    REFERENCES race_entries(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, assignment_id, race_entry_id)
    REFERENCES duck_assignments(event_id, id, race_entry_id) ON DELETE RESTRICT,
  UNIQUE (heat_id, race_entry_id),
  UNIQUE (heat_id, lane_number)
);

CREATE INDEX heat_entries_race_entry_idx ON heat_entries(race_entry_id, status);
CREATE INDEX heat_entries_event_idx ON heat_entries(event_id, heat_id, status);
