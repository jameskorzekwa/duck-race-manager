-- The final podium is now built by scanning one duck at a time and choosing the
-- place it took, so the places a station has taken must survive between scans:
-- each scan is a separate request from a separate page load, and the staffer
-- may be holding a different phone for each duck.
--
-- These rows are deliberately NOT results. A `heat_results` row is a published
-- fact about a finished heat; a row here is a provisional selection that only
-- becomes a result when the last required place is recorded, in the same batch
-- that writes every published place and finalizes the heat. Keeping them in
-- their own table is what lets `heat_results` stay "published only", so no
-- reader anywhere has to learn to filter a half-finished podium out of a result
-- set, and no partially scanned podium can ever reach the public board.
--
-- Every event-scoped foreign key cascades. These rows are scratch state with no
-- historical value, so they must never be the reason a heat, a roster entry, an
-- assignment, a command, or an event cannot be deleted — delete event is the only
-- cleanup path this product has, and `duck_tags.supersedes_tag_id` is the
-- standing reminder of what a RESTRICT on a row nobody thinks about costs there.
--
-- `recorded_by_staff_profile_id` is the deliberate exception and stays RESTRICT,
-- matching `heat_results` and every other row that names the staffer who wrote
-- it. Staff profiles are deactivated, never deleted, and force delete does not
-- touch that table, so this cannot reach the cleanup path.
CREATE TABLE final_podium_selections (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  heat_id TEXT NOT NULL,
  race_entry_id TEXT NOT NULL,
  duck_assignment_id TEXT NOT NULL,
  place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 3),
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
  -- One duck per place and one place per duck, enforced by the schema rather
  -- than only by the preflight that reads the podium before each scan. Two
  -- staffers scanning two ducks for third place at the same moment is an
  -- ordinary race-day event, and the second one has to lose.
  UNIQUE (heat_id, place),
  UNIQUE (heat_id, race_entry_id)
);

CREATE INDEX final_podium_selections_heat_place_idx
  ON final_podium_selections(heat_id, place);

-- A provisional podium place exists only for a final that has physically
-- finished and is waiting for its result. Every other heat state either cannot
-- have a podium at all or already published one, and in both cases a row here
-- would be a podium place belonging to nothing.
CREATE TRIGGER final_podium_selections_awaiting_final_only
BEFORE INSERT ON final_podium_selections
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = NEW.heat_id AND h.event_id = NEW.event_id
     AND h.round = 'FINAL' AND h.status = 'AWAITING_RESULT'
)
BEGIN
  SELECT RAISE(ABORT, 'final podium places may be recorded only while the final awaits its result');
END;
