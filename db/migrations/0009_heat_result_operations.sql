ALTER TABLE race_commands ADD COLUMN actor_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;
ALTER TABLE race_commands ADD COLUMN reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 4 AND 500);

ALTER TABLE heats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE heats ADD COLUMN roster_locked_at TEXT;
ALTER TABLE heats ADD COLUMN roster_locked_by_staff_profile_id TEXT
  REFERENCES staff_profiles(id) ON DELETE RESTRICT;
ALTER TABLE heats ADD COLUMN finished_at TEXT;
ALTER TABLE heats ADD COLUMN source_command_id TEXT
  REFERENCES race_commands(id) ON DELETE RESTRICT;

ALTER TABLE heat_entries ADD COLUMN source_command_id TEXT
  REFERENCES race_commands(id) ON DELETE RESTRICT;

-- Preserve every published result revision so a correction never erases history.
ALTER TABLE heat_results RENAME TO heat_results_v4;

CREATE TABLE heat_results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  duck_assignment_id TEXT NOT NULL,
  place INTEGER NOT NULL CHECK (place > 0),
  status TEXT NOT NULL DEFAULT 'FINALIZED' CHECK (status = 'FINALIZED'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
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

INSERT INTO heat_results
  (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
   finalized_at, recorded_by_staff_profile_id, source_command_id, created_at)
SELECT id, event_id, heat_id, race_entry_id, duck_assignment_id, place, 'FINALIZED', 1,
       finalized_at, recorded_by_staff_profile_id, source_command_id, created_at
  FROM heat_results_v4;

DROP TABLE heat_results_v4;

CREATE TABLE heat_result_history (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  duck_assignment_id TEXT NOT NULL,
  place INTEGER NOT NULL CHECK (place > 0),
  status TEXT NOT NULL CHECK (status = 'SUPERSEDED'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  finalized_at TEXT NOT NULL,
  recorded_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL,
  invalidated_at TEXT NOT NULL,
  invalidated_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  invalidated_by_source_command_id TEXT NOT NULL,
  invalidation_reason TEXT NOT NULL CHECK (length(trim(invalidation_reason)) BETWEEN 4 AND 500),
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id, heat_id) REFERENCES heats(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, invalidated_by_source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX heats_one_running_per_event_idx
  ON heats(event_id) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX heats_one_final_per_event_idx
  ON heats(event_id) WHERE round = 'FINAL';
CREATE INDEX heats_event_round_order_idx
  ON heats(event_id, round, heat_number);
CREATE INDEX heat_entries_source_command_idx
  ON heat_entries(source_command_id) WHERE source_command_id IS NOT NULL;
CREATE INDEX heat_results_race_entry_idx
  ON heat_results(race_entry_id, status, finalized_at);
CREATE INDEX heat_results_heat_revision_idx
  ON heat_results(heat_id, revision, status);
CREATE INDEX heat_result_history_heat_revision_idx
  ON heat_result_history(heat_id, revision, status);

CREATE TRIGGER heat_entries_insert_unlocked
BEFORE INSERT ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = NEW.heat_id AND h.event_id = NEW.event_id
     AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;

CREATE TRIGGER heat_entries_update_unlocked
BEFORE UPDATE ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = OLD.heat_id AND h.event_id = OLD.event_id
     AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;

CREATE TRIGGER heat_entries_delete_unlocked
BEFORE DELETE ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = OLD.heat_id AND h.event_id = OLD.event_id
     AND (
       (h.status = 'PLANNED' AND h.roster_locked_at IS NULL)
       OR EXISTS (SELECT 1 FROM events e WHERE e.id = h.event_id AND e.status = 'ARCHIVED')
     )
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;

CREATE TRIGGER heat_results_place_guard
BEFORE INSERT ON heat_results
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = NEW.heat_id AND h.event_id = NEW.event_id
     AND (
       (h.round = 'ROUND_ONE' AND NEW.place = 1)
       OR (h.round = 'FINAL' AND NEW.place BETWEEN 1 AND 3)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid published result place');
END;
