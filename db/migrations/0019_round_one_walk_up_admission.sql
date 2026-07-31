-- Round One walk-ups are placed by the ordinary ASSIGN_DUCK command. The
-- previously deployed Worker never attempts this insert after the round starts,
-- so this narrow exception is backward compatible while the migration is live
-- ahead of the Worker that uses it.
--
-- Every generic insert remains refused. The exception requires the exact
-- pairing command and assignment created earlier in the same transaction, a
-- locked but never-started Round One heat, and a slot inside the configured
-- heat capacity. A reset heat has a historical START_HEAT command and therefore
-- cannot regain the exception after the admission cutoff.
DROP TRIGGER heat_entries_insert_unlocked;

CREATE TRIGGER heat_entries_insert_unlocked
BEFORE INSERT ON heat_entries
WHEN NOT EXISTS (
  SELECT 1 FROM heats h
   WHERE h.id = NEW.heat_id AND h.event_id = NEW.event_id
     AND (
       (h.status = 'PLANNED' AND h.roster_locked_at IS NULL)
       OR (
         h.round = 'ROUND_ONE'
         AND h.status IN ('LOADING', 'READY', 'CALLING')
         AND EXISTS (
           SELECT 1 FROM events e
            WHERE e.id = h.event_id AND e.status = 'ROUND_ONE'
              AND NEW.slot_number <= e.round_one_heat_capacity
         )
         AND NOT EXISTS (
           SELECT 1 FROM race_commands started
            WHERE started.event_id = h.event_id
              AND started.command_type = 'START_HEAT'
              AND started.result_id = h.id
         )
         AND EXISTS (
           SELECT 1
             FROM race_commands pair_command
             JOIN duck_assignments assignment
               ON assignment.id = pair_command.result_id
              AND assignment.event_id = pair_command.event_id
            WHERE pair_command.id = NEW.source_command_id
              AND pair_command.event_id = NEW.event_id
              AND pair_command.command_type = 'ASSIGN_DUCK'
              AND assignment.source_command_id = pair_command.id
              AND assignment.race_entry_id = NEW.race_entry_id
         )
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'heat roster is locked');
END;
