import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationNames = [
  "0001_staff_identity.sql",
  "0002_registration_foundation.sql",
  "0003_assignment_and_heat_status.sql",
  "0004_pairing_status_and_purge.sql",
  "0005_staff_access_management.sql",
];

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
};

test("fresh migrations enforce event, duck, heat, and result relationships", () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff', 'staff-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_CLOSED');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES
      ('registration-1', 'event', 'Daisy', 'Duck', 'SUBMITTED', 'DAASY234', 'hash-1', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
      ('registration-2', 'event', 'Donald', 'Duck', 'SUBMITTED', 'DNNALD23', 'hash-2', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1'), ('entry-2', 'event', 'registration-2');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES
      ('duck-1', 1, 'RESERVED_FOR_EVENT', '2026-07-25T00:00:00Z'),
      ('duck-2', 2, 'RESERVED_FOR_EVENT', '2026-07-25T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES
      ('event-duck-1', 'event', 'duck-1', '2026-07-25T00:00:00Z', 'staff'),
      ('event-duck-2', 'event', 'duck-2', '2026-07-25T00:00:00Z', 'staff');
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES
      ('command-1', 'event', 'ASSIGN_DUCK', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
      ('command-2', 'event', 'ASSIGN_DUCK', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
      ('command-3', 'event', 'RECORD_RESULT', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
  `);

  assert.throws(() => database.exec(`
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from, assigned_by_staff_profile_id, source_command_id)
    VALUES ('bad-assignment', 'event', 'entry-1', 'event-duck-1', 'duck-2', '2026-07-25T00:00:00Z', 'staff', 'command-1');
  `), /FOREIGN KEY constraint failed/);

  database.exec(`
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from, assigned_by_staff_profile_id, source_command_id)
    VALUES
      ('assignment-1', 'event', 'entry-1', 'event-duck-1', 'duck-1', '2026-07-25T00:00:00Z', 'staff', 'command-1'),
      ('assignment-2', 'event', 'entry-2', 'event-duck-2', 'duck-2', '2026-07-25T00:00:00Z', 'staff', 'command-2');
    INSERT INTO heats (id, event_id, round, heat_number)
    VALUES ('heat-1', 'event', 'ROUND_ONE', 1);
  `);

  assert.throws(() => database.exec(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('bad-heat-entry', 'event', 'heat-1', 'entry-1', 'FINAL', 1, 'PAIRING', '2026-07-25T00:00:00Z');
  `), /FOREIGN KEY constraint failed/);

  database.exec(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-1', 'event', 'heat-1', 'entry-1', 'ROUND_ONE', 1, 'PAIRING', '2026-07-25T00:00:00Z');
  `);

  assert.throws(() => database.exec(`
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('bad-result', 'event', 'heat-1', 'entry-1', 'assignment-2', 1, '2026-07-25T00:00:00Z', 'staff', 'command-3');
  `), /FOREIGN KEY constraint failed/);

  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("staff access commands retain administrator and target relationships", () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 1),
      ('staff', 'staff-sub', 'staff@example.com', 0);
    INSERT INTO staff_access_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id, requested_at, completed_at)
    VALUES
      ('command', 'ADD_STAFF', 'staff', 'admin', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO staff_access_audit_events
      (id, command_id, actor_staff_profile_id, target_staff_profile_id, action, occurred_at)
    VALUES
      ('audit', 'command', 'admin', 'staff', 'STAFF_ACCESS_GRANTED', '2026-07-26T00:00:00Z');
  `);

  assert.throws(() => database.exec("DELETE FROM staff_profiles WHERE id = 'admin'"), /FOREIGN KEY constraint failed/);
  assert.throws(() => database.exec("DELETE FROM staff_profiles WHERE id = 'staff'"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
