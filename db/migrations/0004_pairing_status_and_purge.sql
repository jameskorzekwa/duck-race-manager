ALTER TABLE registrations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE race_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ducks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN public_name_policy TEXT NOT NULL DEFAULT 'FIRST_NAME_LAST_INITIAL' CHECK (
  public_name_policy IN ('FIRST_NAME_ONLY', 'FIRST_NAME_LAST_INITIAL', 'FULL_NAME')
);

CREATE UNIQUE INDEX race_commands_event_id_idx ON race_commands(event_id, id);
CREATE UNIQUE INDEX event_ducks_event_id_idx ON event_ducks(event_id, id);

ALTER TABLE event_ducks ADD COLUMN reserved_by_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;
ALTER TABLE event_ducks ADD COLUMN released_by_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;

CREATE TABLE duck_event_dispositions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  event_duck_id TEXT NOT NULL UNIQUE,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('RETURNED', 'KEPT', 'MISSING', 'DAMAGED', 'QUARANTINED', 'RETIRED', 'UNACCOUNTED_FOR')
  ),
  recorded_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (event_id, event_duck_id)
    REFERENCES event_ducks(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT
);

CREATE INDEX duck_event_dispositions_event_idx
  ON duck_event_dispositions(event_id, disposition);

ALTER TABLE duck_assignments ADD COLUMN ended_by_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX duck_assignments_source_command_idx
  ON duck_assignments(source_command_id);

-- Production has no heat data; replace the provisional v3 heat model before the first event.
DROP TABLE heat_entries;
DROP TABLE heats;

CREATE TABLE heats (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  round TEXT NOT NULL CHECK (round IN ('ROUND_ONE', 'FINAL')),
  heat_number INTEGER NOT NULL CHECK (heat_number > 0),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (
    status IN ('PLANNED', 'LOADING', 'READY', 'CALLING', 'RUNNING', 'AWAITING_RESULT', 'FINALIZED', 'CANCELLED')
  ),
  target_size INTEGER CHECK (target_size IS NULL OR target_size > 0),
  started_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, round, heat_number),
  UNIQUE (event_id, id),
  UNIQUE (event_id, id, round),
  CHECK (status != 'FINALIZED' OR finalized_at IS NOT NULL)
);

CREATE INDEX heats_event_status_idx ON heats(event_id, status, round, heat_number);

CREATE TABLE heat_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  round TEXT NOT NULL CHECK (round IN ('ROUND_ONE', 'FINAL')),
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  assignment_source TEXT NOT NULL CHECK (assignment_source IN ('PAIRING', 'BALANCED_DRAW', 'WINNER_PROMOTION')),
  assigned_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, heat_id, round) REFERENCES heats(event_id, id, round) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, race_entry_id) REFERENCES race_entries(event_id, id) ON DELETE RESTRICT,
  UNIQUE (heat_id, race_entry_id),
  UNIQUE (heat_id, slot_number),
  UNIQUE (event_id, round, race_entry_id),
  UNIQUE (event_id, heat_id, race_entry_id)
);

CREATE INDEX heat_entries_race_entry_idx ON heat_entries(race_entry_id, heat_id);

CREATE TABLE heat_results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  duck_assignment_id TEXT NOT NULL,
  place INTEGER NOT NULL CHECK (place > 0),
  finalized_at TEXT NOT NULL,
  recorded_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, heat_id) REFERENCES heats(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, heat_id, race_entry_id)
    REFERENCES heat_entries(event_id, heat_id, race_entry_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, duck_assignment_id, race_entry_id)
    REFERENCES duck_assignments(event_id, id, race_entry_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  UNIQUE (heat_id, race_entry_id),
  UNIQUE (heat_id, place)
);

CREATE INDEX heat_results_race_entry_idx ON heat_results(race_entry_id, finalized_at);

CREATE TABLE browser_registration_collections (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX browser_registration_collections_expiry_idx
  ON browser_registration_collections(expires_at);

CREATE TABLE browser_collection_registrations (
  collection_id TEXT NOT NULL REFERENCES browser_registration_collections(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, registration_id)
);

CREATE INDEX browser_collection_registrations_registration_idx
  ON browser_collection_registrations(registration_id);
