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
  "0006_participant_operations.sql",
  "0007_duck_inventory_operations.sql",
  "0008_event_operations.sql",
  "0009_heat_result_operations.sql",
  "0010_staff_lifecycle.sql",
  "0011_support_operations.sql",
  "0012_staff_role_assignments.sql",
  "0013_followed_collection_entries.sql",
];

const applyMigrations = (database, names = migrationNames) => {
  for (const name of names) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
};

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
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
      ('admin-2', 'admin-2-sub', 'admin-2@example.com', 1),
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

test("0013 keeps existing collection links registration-sourced and constrains new sources", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationNames.filter((name) => name !== "0013_followed_collection_entries.sql"));
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_OPEN');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-1', 'event', 'Daisy', 'Duck', 'SUBMITTED', 'DAASY234', 'hash-1',
            '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-1', 'cookie-hash-1', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z', '2027-07-25T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at)
    VALUES ('collection-1', 'registration-1', '2026-07-25T00:00:00Z');
  `);

  applyMigrations(database, ["0013_followed_collection_entries.sql"]);

  // Links created before the migration keep today's shipped projection.
  assert.deepEqual(
    database.prepare("SELECT collection_id, added_via FROM browser_collection_registrations").all()
      .map((row) => ({ ...row })),
    [{ collection_id: "collection-1", added_via: "REGISTRATION" }],
  );

  // The previously deployed Worker writes only the original three columns, so
  // the migration must remain compatible with that insert shape.
  database.exec(`
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-2', 'cookie-hash-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', '2027-07-26T00:00:00Z');
    INSERT OR IGNORE INTO browser_collection_registrations (collection_id, registration_id, added_at)
    VALUES ('collection-2', 'registration-1', '2026-07-26T00:00:00Z');
  `);
  assert.equal(database.prepare(
    "SELECT added_via FROM browser_collection_registrations WHERE collection_id = 'collection-2'",
  ).get().added_via, "REGISTRATION");

  database.exec(`
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-3', 'cookie-hash-3', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', '2027-07-26T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at, added_via)
    VALUES ('collection-3', 'registration-1', '2026-07-26T00:00:00Z', 'FOLLOWED');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-4', 'cookie-hash-4', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', '2027-07-26T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at, added_via)
    VALUES ('collection-4', 'registration-1', '2026-07-26T00:00:00Z', 'STAFF');
  `), /CHECK constraint failed/);
  assert.throws(() => database.exec(`
    UPDATE browser_collection_registrations SET added_via = NULL WHERE collection_id = 'collection-3'
  `), /NOT NULL constraint failed/);

  // The purge path still clears every collection link regardless of source.
  database.exec("DELETE FROM browser_collection_registrations");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM browser_collection_registrations").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0012 backfills historical command metadata without granting operational roles", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationNames.filter((name) => name !== "0012_staff_role_assignments.sql"));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES
      ('actor', 'actor-sub', 'actor@example.com', 1),
      ('promoted', 'promoted-sub', 'promoted@example.com', 0),
      ('demoted', 'demoted-sub', 'demoted@example.com', 1);
    INSERT INTO staff_access_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id, requested_at, completed_at)
    VALUES
      ('grant-promoted', 'ADD_STAFF', 'promoted', 'actor', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      ('grant-demoted', 'ADD_STAFF', 'demoted', 'actor', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    INSERT INTO staff_access_audit_events
      (id, command_id, actor_staff_profile_id, target_staff_profile_id, action, occurred_at, details_json)
    VALUES
      ('grant-promoted-audit', 'grant-promoted', 'actor', 'promoted', 'STAFF_ACCESS_GRANTED',
       '2026-07-01T00:00:00Z', '{"role":"STAFF"}'),
      ('grant-demoted-audit', 'grant-demoted', 'actor', 'demoted', 'STAFF_ACCESS_GRANTED',
       '2026-07-01T00:00:00Z', '{"role":"ADMIN"}');
    INSERT INTO staff_lifecycle_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id,
       requested_role, result_is_system_admin, result_is_active, requested_at, completed_at)
    VALUES
      ('promote', 'CHANGE_STAFF_ROLE', 'promoted', 'actor', 'ADMIN', 1, 1,
       '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z'),
      ('demote', 'CHANGE_STAFF_ROLE', 'demoted', 'actor', 'STAFF', 0, 1,
       '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z'),
      ('deactivate', 'DEACTIVATE_STAFF', 'promoted', 'actor', NULL, 1, 0,
       '2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z');
    UPDATE staff_profiles SET is_system_admin = 1 WHERE id = 'promoted';
    UPDATE staff_profiles SET is_system_admin = 0 WHERE id = 'demoted';
  `);

  applyMigrations(database, ["0012_staff_role_assignments.sql"]);

  const allRoles = '["REGISTRATION","DUCK_MANAGER","ANNOUNCER","HEAT_RUNNER","RESULT_TAKER","RETURN_STEWARD","RACE_DIRECTOR"]';
  assert.deepEqual(
    database.prepare(
      `SELECT id, requested_account_type, requested_roles_json
         FROM staff_access_commands
        ORDER BY id`,
    ).all().map((row) => ({ ...row })),
    [
      { id: "grant-demoted", requested_account_type: "ADMIN", requested_roles_json: "[]" },
      { id: "grant-promoted", requested_account_type: "STAFF", requested_roles_json: allRoles },
    ],
  );
  assert.deepEqual(
    database.prepare(
      `SELECT id, requested_roles_json, expected_role_revision, result_role_revision
         FROM staff_lifecycle_commands
        ORDER BY id`,
    ).all().map((row) => ({ ...row })),
    [
      {
        id: "deactivate", requested_roles_json: null,
        expected_role_revision: null, result_role_revision: null,
      },
      {
        id: "demote", requested_roles_json: allRoles,
        expected_role_revision: null, result_role_revision: null,
      },
      {
        id: "promote", requested_roles_json: "[]",
        expected_role_revision: null, result_role_revision: null,
      },
    ],
  );
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'demoted'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'promoted'",
  ).get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
