-- Recording a result and making it official are separate race-day facts. These
-- rows hold the complete, validated result while the announcer reads it and the
-- finish line waits for the winner-announced confirmation. `heat_results`
-- remains published-only, so public and progression readers cannot mistake an
-- unannounced result for an official one.
CREATE TABLE pending_heat_results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  duck_assignment_id TEXT NOT NULL,
  place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 3),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  recorded_at TEXT NOT NULL,
  recorded_by_staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id, heat_id) REFERENCES heats(event_id, id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, heat_id, race_entry_id)
    REFERENCES heat_entries(event_id, heat_id, race_entry_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, duck_assignment_id, race_entry_id)
    REFERENCES duck_assignments(event_id, id, race_entry_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, source_command_id)
    REFERENCES race_commands(event_id, id) ON DELETE CASCADE,
  UNIQUE (heat_id, race_entry_id),
  UNIQUE (heat_id, place)
);

CREATE INDEX pending_heat_results_heat_place_idx
  ON pending_heat_results(heat_id, place);

CREATE TRIGGER pending_heat_results_awaiting_only
BEFORE INSERT ON pending_heat_results
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = NEW.heat_id AND h.event_id = NEW.event_id
     AND h.status = 'AWAITING_RESULT'
)
BEGIN
  SELECT RAISE(ABORT, 'pending results require a heat awaiting its result');
END;

-- A rolled-back Worker does not know how to confirm or clear pending results.
-- Fail closed instead of letting it publish a second result over the recorded
-- announcement. The new Worker inserts the confirmation command first, which
-- is the narrow exception used by its one atomic confirmation batch.
CREATE TRIGGER heat_results_require_announcement_confirmation
BEFORE INSERT ON heat_results
WHEN EXISTS (
  SELECT 1 FROM pending_heat_results pending
   WHERE pending.event_id = NEW.event_id AND pending.heat_id = NEW.heat_id
)
AND NOT EXISTS (
  SELECT 1 FROM race_commands confirmation
   WHERE confirmation.id = NEW.source_command_id
     AND confirmation.event_id = NEW.event_id
     AND confirmation.result_id = NEW.heat_id
     AND confirmation.command_type = 'CONFIRM_WINNER_ANNOUNCEMENT'
)
BEGIN
  SELECT RAISE(ABORT, 'pending result must be announcement-confirmed');
END;

-- Likewise, an old reset/finalize path may not move the heat away and strand
-- the recorded result. New reset and confirmation paths clear the rows before
-- changing status; force-delete cascades them with the heat.
CREATE TRIGGER heats_keep_pending_result_awaiting
BEFORE UPDATE OF status ON heats
WHEN OLD.status = 'AWAITING_RESULT'
  AND NEW.status <> 'AWAITING_RESULT'
  AND EXISTS (
    SELECT 1 FROM pending_heat_results pending
     WHERE pending.event_id = OLD.event_id AND pending.heat_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'clear pending result before changing heat status');
END;
