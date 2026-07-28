-- A round-one winner correction may replace only its exact promoted final
-- entry while the final is loading. Generic updates remain forbidden by the
-- same trigger, and READY or later final heats never satisfy this exception.
DROP TRIGGER heat_entries_update_unlocked;

CREATE TRIGGER heat_entries_update_unlocked
BEFORE UPDATE ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = OLD.heat_id AND h.event_id = OLD.event_id
     AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL
)
AND NOT EXISTS (
  SELECT 1
    FROM heats final_heat
    JOIN race_commands correction
      ON correction.id = NEW.source_command_id
     AND correction.event_id = final_heat.event_id
     AND correction.command_type = 'CORRECT_HEAT_RESULT'
    JOIN heats qualifier
      ON qualifier.id = correction.result_id
     AND qualifier.event_id = final_heat.event_id
     AND qualifier.round = 'ROUND_ONE'
    JOIN heat_result_history old_winner
      ON old_winner.heat_id = qualifier.id
     AND old_winner.event_id = qualifier.event_id
     AND old_winner.race_entry_id = OLD.race_entry_id
     AND old_winner.place = 1
     AND old_winner.status = 'SUPERSEDED'
     AND old_winner.invalidated_by_source_command_id = correction.id
    JOIN heat_results new_winner
      ON new_winner.heat_id = qualifier.id
     AND new_winner.event_id = qualifier.event_id
     AND new_winner.race_entry_id = NEW.race_entry_id
     AND new_winner.place = 1
     AND new_winner.status = 'FINALIZED'
     AND new_winner.source_command_id = correction.id
   WHERE final_heat.id = OLD.heat_id
     AND final_heat.event_id = OLD.event_id
     AND final_heat.round = 'FINAL'
     AND final_heat.status = 'LOADING'
     AND NEW.event_id = OLD.event_id
     AND NEW.heat_id = OLD.heat_id
     AND NEW.round = OLD.round
     AND NEW.slot_number = OLD.slot_number
     AND NEW.assignment_source = OLD.assignment_source
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;
