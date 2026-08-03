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
  "0014_simplified_lifecycle_schema.sql",
  "0015_participant_duck_names.sql",
  "0016_locked_final_winner_correction.sql",
  "0017_final_podium_selections.sql",
  "0018_participant_contact_preferences.sql",
  "0019_round_one_walk_up_admission.sql",
  "0020_email_notification_assignment.sql",
  "0021_email_delivery_claim.sql",
  "0022_pending_heat_result_announcement.sql",
  "0023_duck_photos.sql",
];

const lifecycleStatuses = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "ROUND_ONE",
  "FINAL",
  "COMPLETED",
];

const retiredTables = [
  "duck_event_dispositions",
  "return_batches",
  "return_batch_items",
  "event_purge_claims",
];

const objectNames = (database, type) => database
  .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
  .all(type)
  .map((row) => row.name);

const count = (database, table) =>
  database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

const applyMigrations = (database, names = migrationNames) => {
  for (const name of names) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
};

// Migrations are ordered and append-only, so an upgrade test for migration N
// applies exactly 0001..N-1 first and never a later file.
const migrationsBefore = (name) => migrationNames.slice(0, migrationNames.indexOf(name));

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

test("0023 adds private one-photo requirements without backfilling existing ducks", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0023_duck_photos.sql"));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES
      ('staff', 'staff-sub', 'staff@example.com'),
      ('uploading-staff', 'uploading-staff-sub', 'uploading@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'DRAFT');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('existing-duck', 1, 'AVAILABLE', '2026-08-03T00:00:00Z');
  `);

  applyMigrations(database, ["0023_duck_photos.sql"]);
  assert.equal(count(database, "duck_photos"), 0, "existing/manual ducks are not invented as incomplete");

  // The previously deployed Worker can keep inserting ducks without knowing the
  // additive table exists.
  database.exec(`
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('old-worker-duck', 2, 'AVAILABLE', '2026-08-03T00:00:01Z');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('confirm-command', 'event', 'CONFIRM_DUCK_PROVISIONING', 'old-worker-duck',
            '2026-08-03T00:00:02Z', '2026-08-03T00:00:02Z');
    INSERT INTO duck_photos
      (duck_id, event_id, provisioning_command_id, owner_staff_profile_id,
       status, created_at, updated_at)
    VALUES ('old-worker-duck', 'event', 'confirm-command', 'staff', 'MISSING',
            '2026-08-03T00:00:02Z', '2026-08-03T00:00:02Z');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO duck_photos
      (duck_id, event_id, provisioning_command_id, owner_staff_profile_id,
       status, created_at, updated_at)
    VALUES ('existing-duck', 'event', 'confirm-command', 'staff', 'MISSING',
            '2026-08-03T00:00:03Z', '2026-08-03T00:00:03Z');
  `), /UNIQUE constraint failed/);
  assert.throws(() => database.exec(`
    UPDATE duck_photos SET status = 'STORED' WHERE duck_id = 'old-worker-duck';
  `), /CHECK constraint failed/);
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('other-event', 'other-race', 'Other Race', 'UTC', 'DRAFT');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('cross-event-duck', 3, 'AVAILABLE', '2026-08-03T00:00:03Z');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('cross-event-command', 'event', 'CONFIRM_DUCK_PROVISIONING', 'cross-event-duck',
            '2026-08-03T00:00:03Z', '2026-08-03T00:00:03Z');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO duck_photos
      (duck_id, event_id, provisioning_command_id, owner_staff_profile_id,
       status, created_at, updated_at)
    VALUES ('cross-event-duck', 'other-event', 'cross-event-command', 'staff', 'MISSING',
            '2026-08-03T00:00:03Z', '2026-08-03T00:00:03Z');
  `), /FOREIGN KEY constraint failed/);
  database.exec(`
    INSERT INTO duck_photos
      (duck_id, event_id, provisioning_command_id, owner_staff_profile_id,
       object_key, status, upload_command_id, content_sha256, byte_size, width, height,
       created_at, updated_at)
    VALUES ('cross-event-duck', 'event', 'cross-event-command', 'uploading-staff',
            'duck-photos/event/cross-event-duck/uploading.jpg', 'UPLOADING',
            '22222222-2222-4222-8222-222222222222', '${"b".repeat(64)}', 100, 20, 10,
            '2026-08-03T00:00:03Z', '2026-08-03T00:00:03Z');
    DELETE FROM duck_photos WHERE duck_id = 'cross-event-duck';
  `);
  assert.equal(database.prepare(`
    SELECT requested_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+4 minutes') AS delayed
      FROM duck_photo_cleanup_jobs
     WHERE object_key = 'duck-photos/event/cross-event-duck/uploading.jpg'
  `).get().delayed, 1, "an in-flight write cannot appear after its cleanup job already ran");

  database.exec(`
    UPDATE duck_photos
       SET status = 'STORED', object_key = 'duck-photos/event/old-worker-duck/candidate.jpg',
           upload_command_id = '11111111-1111-4111-8111-111111111111',
           content_sha256 = '${"a".repeat(64)}', byte_size = 100, width = 20, height = 10,
           stored_at = '2026-08-03T00:00:04Z', updated_at = '2026-08-03T00:00:04Z'
     WHERE duck_id = 'old-worker-duck';
    DELETE FROM ducks WHERE id = 'old-worker-duck';
  `);
  assert.equal(count(database, "duck_photos"), 0);
  assert.deepEqual(
    database.prepare(`
      SELECT object_key, attempts FROM duck_photo_cleanup_jobs
       WHERE object_key = 'duck-photos/event/old-worker-duck/candidate.jpg'
    `).all().map((row) => ({ ...row })),
    [{ object_key: "duck-photos/event/old-worker-duck/candidate.jpg", attempts: 0 }],
  );
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
  applyMigrations(database, migrationsBefore("0013_followed_collection_entries.sql"));
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

test("0018 adds private contact proof and SMS consent without breaking older writes", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0018_participant_contact_preferences.sql"));
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event-contact', 'contact-race', 'Contact Race', 'UTC', 'REGISTRATION_OPEN');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, phone, status, lookup_code,
       private_token_hash, submitted_at, status_changed_at)
    VALUES
      ('registration-contact', 'event-contact', 'Daisy', 'Duck', '+15550100',
       'SUBMITTED', 'DAASY234', 'private-hash',
       '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'),
      ('registration-other', 'event-contact', 'Donald', 'Duck', '+15550101',
       'SUBMITTED', 'DNNALD23', 'private-hash-other',
       '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z');
    INSERT INTO browser_registration_collections
      (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-owner', 'cookie-owner', '2026-07-29T00:00:00Z',
            '2026-07-29T00:00:00Z', '2027-07-29T00:00:00Z');
    INSERT INTO browser_collection_registrations
      (collection_id, registration_id, added_at, added_via)
    VALUES ('collection-owner', 'registration-contact', '2026-07-29T00:00:00Z', 'REGISTRATION');
  `);

  applyMigrations(database, ["0018_participant_contact_preferences.sql"]);
  assert.equal(database.prepare(
    "SELECT ownership_proof_hash FROM browser_collection_registrations WHERE collection_id = 'collection-owner'",
  ).get().ownership_proof_hash, null);
  assert.equal(
    database.prepare("SELECT sms_notifications_enabled FROM registrations").get().sms_notifications_enabled,
    0,
  );

  // The previously deployed Worker still omits both new columns.
  database.exec(`
    INSERT INTO browser_registration_collections
      (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection-old-worker', 'cookie-old-worker', '2026-07-29T00:00:00Z',
            '2026-07-29T00:00:00Z', '2027-07-29T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at)
    VALUES ('collection-old-worker', 'registration-contact', '2026-07-29T00:00:00Z');
  `);
  database.prepare(
    "UPDATE browser_collection_registrations SET ownership_proof_hash = ? WHERE collection_id = ?",
  ).run("a".repeat(64), "collection-owner");
  // The same participant may retain the same proof in another owned collection,
  // but that proof cannot be installed for a different participant.
  database.prepare(
    "UPDATE browser_collection_registrations SET ownership_proof_hash = ? WHERE collection_id = ?",
  ).run("a".repeat(64), "collection-old-worker");
  assert.throws(
    () => database.exec(`
      INSERT INTO browser_collection_registrations
        (collection_id, registration_id, added_at, added_via, ownership_proof_hash)
      VALUES ('collection-old-worker', 'registration-other', '2026-07-29T00:00:00Z',
              'REGISTRATION', '${"a".repeat(64)}');
    `),
    /ownership proof belongs to another participant/,
  );
  database.exec(`
    INSERT INTO browser_collection_registrations
      (collection_id, registration_id, added_at, added_via)
    VALUES ('collection-old-worker', 'registration-other', '2026-07-29T00:00:00Z',
            'REGISTRATION');
  `);
  assert.throws(
    () => database.prepare(`
      UPDATE browser_collection_registrations
         SET ownership_proof_hash = ?
       WHERE collection_id = ? AND registration_id = ?
    `).run("a".repeat(64), "collection-old-worker", "registration-other"),
    /ownership proof belongs to another participant/,
  );
  database.prepare(
    "UPDATE registrations SET sms_notifications_enabled = 1 WHERE id = ?",
  ).run("registration-contact");
  database.prepare("UPDATE registrations SET phone = NULL WHERE id = ?").run("registration-contact");
  assert.equal(database.prepare(
    "SELECT phone, sms_notifications_enabled FROM registrations WHERE id = ?",
  ).get("registration-contact").sms_notifications_enabled, 0);
  assert.throws(
    () => database.exec(`
      UPDATE browser_collection_registrations
         SET added_via = 'FOLLOWED'
       WHERE collection_id = 'collection-owner';
    `),
    /followed links cannot hold ownership proof/,
  );
  assert.throws(
    () => database.prepare(
      "UPDATE browser_collection_registrations SET ownership_proof_hash = ? WHERE collection_id = ?",
    ).run("not-a-valid-hash", "collection-old-worker"),
    /CHECK constraint failed/,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0019 permits only command-bound pairing into a never-started Round One heat", () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff-walk-up', 'staff-walk-up-sub', 'walk-up@example.com');
    INSERT INTO events
      (id, slug, name, timezone, status, round_one_heat_capacity)
    VALUES ('event-walk-up', 'walk-up-race', 'Walk-up Race', 'UTC', 'ROUND_ONE', 3);
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       created_via, submitted_at, status_changed_at)
    VALUES
      ('registration-walk-up', 'event-walk-up', 'Late', 'Racer', 'SUBMITTED',
       'LATEDUCK', 'private-hash', 'STAFF', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z'),
      ('registration-unbound', 'event-walk-up', 'Other', 'Racer', 'SUBMITTED',
       'THERDUCK', 'private-hash-2', 'STAFF', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES
      ('entry-walk-up', 'event-walk-up', 'registration-walk-up'),
      ('entry-unbound', 'event-walk-up', 'registration-unbound');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-walk-up', 901, 'IN_USE', '2026-07-30T00:00:00Z');
    INSERT INTO event_ducks
      (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-walk-up', 'event-walk-up', 'duck-walk-up',
            '2026-07-30T00:00:00Z', 'staff-walk-up');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('assign-walk-up', 'event-walk-up', 'ASSIGN_DUCK', 'assignment-walk-up',
            '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment-walk-up', 'event-walk-up', 'entry-walk-up',
            'event-duck-walk-up', 'duck-walk-up', '2026-07-30T00:00:00Z',
            'staff-walk-up', 'assign-walk-up');
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size, roster_locked_at,
       roster_locked_by_staff_profile_id)
    VALUES
      ('heat-unstarted', 'event-walk-up', 'ROUND_ONE', 1, 'LOADING', 3,
       '2026-07-30T00:00:00Z', 'staff-walk-up'),
      ('heat-planned', 'event-walk-up', 'ROUND_ONE', 2, 'PLANNED', 3, NULL, NULL);
  `);

  database.exec(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number,
       assignment_source, assigned_at, source_command_id)
    VALUES ('late-entry', 'event-walk-up', 'heat-unstarted', 'entry-walk-up',
            'ROUND_ONE', 1, 'PAIRING', '2026-07-30T00:00:00Z', 'assign-walk-up');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number,
       assignment_source, assigned_at)
    VALUES ('unbound-entry', 'event-walk-up', 'heat-unstarted', 'entry-unbound',
            'ROUND_ONE', 2, 'PAIRING', '2026-07-30T00:00:00Z');
  `), /heat roster is locked/);

  // The old Worker insert shape remains valid on an ordinary unlocked heat.
  database.exec(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number,
       assignment_source, assigned_at)
    VALUES ('planned-entry', 'event-walk-up', 'heat-planned', 'entry-unbound',
            'ROUND_ONE', 1, 'PAIRING', '2026-07-30T00:00:00Z');
  `);

  database.exec(`
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('start-walk-up', 'event-walk-up', 'START_HEAT', 'heat-unstarted',
            '2026-07-30T00:01:00Z', '2026-07-30T00:01:00Z');
    UPDATE heats SET status = 'RUNNING', started_at = '2026-07-30T00:01:00Z'
     WHERE id = 'heat-unstarted';
  `);
  assert.throws(() => database.prepare(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number,
       assignment_source, assigned_at, source_command_id)
    VALUES (?, ?, ?, ?, 'ROUND_ONE', 2, 'PAIRING', ?, ?)
  `).run(
    'after-start', 'event-walk-up', 'heat-unstarted', 'entry-unbound',
    '2026-07-30T00:02:00Z', 'assign-walk-up',
  ), /heat roster is locked/);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0020 pins new notifications to an assignment without inventing one for legacy rows", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0020_email_notification_assignment.sql"));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff-email', 'staff-email-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event-email', 'email-race', 'Email Race', 'UTC', 'REGISTRATION_OPEN');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, email_notifications_enabled,
       status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-email', 'event-email', 'Daisy', 'Duck',
            'daisy@example.com', 1, 'ACTIVE', 'DAASY234', 'private-hash',
            '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-email', 'event-email', 'registration-email');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-email', 42, 'IN_USE', '2026-08-01T00:00:00Z');
    INSERT INTO event_ducks
      (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-email', 'event-email', 'duck-email',
            '2026-08-01T00:00:00Z', 'staff-email');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('assign-email', 'event-email', 'ASSIGN_DUCK', 'assignment-email',
            '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment-email', 'event-email', 'entry-email', 'event-duck-email',
            'duck-email', '2026-08-01T00:00:00Z', 'staff-email', 'assign-email');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-email', 'event-email', 'ROUND_ONE', 1, 'PLANNED', 3);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number,
       assignment_source, assigned_at, source_command_id)
    VALUES ('heat-entry-email', 'event-email', 'heat-email', 'entry-email',
            'ROUND_ONE', 1, 'PAIRING', '2026-08-01T00:00:00Z', 'assign-email');
    INSERT INTO email_notifications
      (id, event_id, registration_id, heat_id, notification_type, status)
    VALUES ('legacy-before', 'event-email', 'registration-email', 'heat-email',
            'HEAT_ASSIGNED', 'PENDING');
  `);

  applyMigrations(database, ["0020_email_notification_assignment.sql"]);
  assert.equal(database.prepare(
    "SELECT duck_assignment_id FROM email_notifications WHERE id = 'legacy-before'",
  ).get().duck_assignment_id, null, "a current assignment is not guessed for pre-migration work");

  // The previously deployed Worker still writes the original column list.
  database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, heat_id, notification_type, status)
    VALUES ('legacy-after', 'event-email', 'registration-email', 'heat-email',
            'HEAT_UPCOMING', 'PENDING');
  `);
  assert.equal(database.prepare(
    "SELECT duck_assignment_id FROM email_notifications WHERE id = 'legacy-after'",
  ).get().duck_assignment_id, null);

  assert.throws(() => database.prepare(
    "UPDATE email_notifications SET duck_assignment_id = ? WHERE id = ?",
  ).run("missing-assignment", "legacy-before"), /FOREIGN KEY constraint failed/);
  database.prepare(
    "UPDATE email_notifications SET duck_assignment_id = ? WHERE id = ?",
  ).run("assignment-email", "legacy-before");
  database.prepare("DELETE FROM duck_assignments WHERE id = ?").run("assignment-email");
  assert.equal(database.prepare(
    "SELECT duck_assignment_id FROM email_notifications WHERE id = 'legacy-before'",
  ).get().duck_assignment_id, null, "assignment deletion safely invalidates pending work");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0015 adds an optional bounded duck name that older writes keep working without", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0015_participant_duck_names.sql"));
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_OPEN');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-1', 'event', 'Daisy', 'Duck', 'ACTIVE', 'DAASY234', 'hash-1',
            '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1');
  `);

  applyMigrations(database, ["0015_participant_duck_names.sql"]);

  // Existing race entries are unnamed, and the previously deployed Worker's
  // insert shape still works because the column is nullable with no default.
  assert.equal(database.prepare("SELECT duck_name FROM race_entries WHERE id = 'entry-1'").get().duck_name, null);
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-2', 'event', 'Donald', 'Mallard', 'SUBMITTED', 'DNNALD23', 'hash-2',
            '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-2', 'event', 'registration-2');
  `);
  assert.equal(database.prepare("SELECT duck_name FROM race_entries WHERE id = 'entry-2'").get().duck_name, null);

  // The CHECK is the authoritative bound on what may be stored.
  database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run("Sir Quacks-a-Lot");
  database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-2'").run("d".repeat(40));
  for (const value of ["", "  ", " Bubbles", "Bubbles ", "e".repeat(41)]) {
    assert.throws(
      () => database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run(value),
      /CHECK constraint failed/,
      JSON.stringify(value),
    );
  }
  assert.equal(
    database.prepare("SELECT duck_name FROM race_entries WHERE id = 'entry-1'").get().duck_name,
    "Sir Quacks-a-Lot",
  );

  // Two entries may carry the same name: it is a personal label, not an
  // identifier, and nothing keys off it.
  database.prepare("UPDATE race_entries SET duck_name = 'Bubbles' WHERE id = 'entry-1'").run();
  database.prepare("UPDATE race_entries SET duck_name = 'Bubbles' WHERE id = 'entry-2'").run();
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE duck_name = 'Bubbles'").get().count,
    2,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

// A provisional podium place is the only row in the schema that is deliberately
// not a fact yet, so the constraints that keep it honest are the whole point of
// the table: one duck per place, one place per duck, and no such row at all
// unless a final is actually waiting for its result.
test("0017 keeps a scanned podium exclusive, bounded, and attached to a waiting final", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0017_final_podium_selections.sql"));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'FINAL');
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'event', 'RECORD_FINAL_PODIUM_PLACE', 'final',
            '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
           ('22222222-2222-4222-8222-222222222222', 'event', 'PAIR_DUCK', 'assignment-1',
            '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
           ('33333333-3333-4333-8333-333333333333', 'event', 'PAIR_DUCK', 'assignment-2',
            '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-1', 1, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-2', 2, 'IN_USE', '2026-07-26T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-1', 'event', 'duck-1', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-2', 'event', 'duck-2', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-1', 'event', 'Daisy', 'Duck', 'ACTIVE', 'DAASY234', 'hash-1',
            '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
           ('registration-2', 'event', 'Donald', 'Mallard', 'ACTIVE', 'DNNALD23', 'hash-2',
            '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1'), ('entry-2', 'event', 'registration-2');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from, assigned_by_staff_profile_id,
       source_command_id)
    VALUES ('assignment-1', 'event', 'entry-1', 'event-duck-1', 'duck-1', '2026-07-26T00:00:00Z', 'staff',
            '22222222-2222-4222-8222-222222222222'),
           ('assignment-2', 'event', 'entry-2', 'event-duck-2', 'duck-2', '2026-07-26T00:00:00Z', 'staff',
            '33333333-3333-4333-8333-333333333333');
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('final', 'event', 'FINAL', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('final-1', 'event', 'final', 'entry-1', 'FINAL', 1, 'WINNER_PROMOTION', '2026-07-26T00:00:00Z'),
           ('final-2', 'event', 'final', 'entry-2', 'FINAL', 2, 'WINNER_PROMOTION', '2026-07-26T00:00:00Z');
  `);

  applyMigrations(database, ["0017_final_podium_selections.sql"]);

  const record = (id, raceEntryId, assignmentId, place) => database.prepare(
    `INSERT INTO final_podium_selections
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, recorded_at,
       recorded_by_staff_profile_id, source_command_id)
     VALUES (?, 'event', 'final', ?, ?, ?, '2026-07-26T01:00:00Z', 'staff',
             '11111111-1111-4111-8111-111111111111')`,
  ).run(id, raceEntryId, assignmentId, place);

  // A final that has not finished yet has no places to record.
  assert.throws(
    () => record("place-early", "entry-1", "assignment-1", 1),
    /final podium places may be recorded only while the final awaits its result/,
  );
  database.exec("UPDATE heats SET status = 'AWAITING_RESULT' WHERE id = 'final'");
  record("place-1", "entry-1", "assignment-1", 1);

  // One duck per place, and one place per duck.
  assert.throws(() => record("place-clash", "entry-2", "assignment-2", 1), /UNIQUE constraint failed/);
  assert.throws(() => record("duck-clash", "entry-1", "assignment-1", 2), /UNIQUE constraint failed/);
  // A podium is three places deep at most, whatever a caller asks for.
  for (const place of [0, 4, -1]) {
    assert.throws(() => record(`place-${place}`, "entry-2", "assignment-2", place), /CHECK constraint failed/);
  }
  record("place-2", "entry-2", "assignment-2", 2);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    2,
  );

  // Nothing here may ever be the reason an event's own rows cannot be deleted:
  // these are scratch state with no historical value, so every event-scoped
  // foreign key cascades. Delete event is the only cleanup path this product
  // has, and a RESTRICT on a row nobody thinks about is exactly how that path
  // was broken once before. `recorded_by_staff_profile_id` is the deliberate
  // exception and stays RESTRICT like every other "who wrote this" column;
  // staff profiles are deactivated rather than deleted, and force delete never
  // touches that table.
  database.exec("DELETE FROM duck_assignments WHERE id = 'assignment-2'");
  assert.deepEqual(
    database.prepare("SELECT id FROM final_podium_selections ORDER BY place").all().map((row) => row.id),
    ["place-1"],
  );
  database.exec("DELETE FROM race_commands WHERE id = '11111111-1111-4111-8111-111111111111'");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    0,
  );
  // The one deliberate RESTRICT, asserted so the exception stays a decision
  // rather than becoming a surprise. Its command row survived the delete above.
  database.exec(`
    INSERT INTO final_podium_selections
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, recorded_at,
       recorded_by_staff_profile_id, source_command_id)
    VALUES ('place-again', 'event', 'final', 'entry-1', 'assignment-1', 1,
            '2026-07-26T01:00:00Z', 'staff', '22222222-2222-4222-8222-222222222222');
  `);
  assert.throws(
    () => database.exec("DELETE FROM staff_profiles WHERE id = 'staff'"),
    /FOREIGN KEY constraint failed/,
  );
  database.exec("DELETE FROM final_podium_selections");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0012 backfills historical command metadata without granting operational roles", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0012_staff_role_assignments.sql"));
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

test("0014 from an empty database leaves the simplified schema", () => {
  const database = createDatabase();

  const tables = objectNames(database, "table");
  for (const table of retiredTables) {
    assert.ok(!tables.includes(table), `expected ${table} to be dropped`);
  }

  const triggers = objectNames(database, "trigger");
  assert.ok(!triggers.includes("events_require_purge_claim"));
  assert.ok(!triggers.includes("purging_events_are_read_only"));
  // The surviving roster triggers keep their shipped names.
  assert.ok(triggers.includes("heat_entries_insert_unlocked"));
  assert.ok(triggers.includes("heat_entries_update_unlocked"));
  assert.ok(triggers.includes("heat_entries_delete_unlocked"));
  assert.ok(triggers.includes("heat_results_place_guard"));
  assert.ok(triggers.includes("staff_profiles_keep_active_admin_on_update"));
  assert.ok(triggers.includes("staff_profiles_keep_active_admin_on_delete"));

  const deleteTrigger = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'heat_entries_delete_unlocked'",
  ).get().sql;
  assert.doesNotMatch(deleteTrigger, /ARCHIVED/);
  assert.match(deleteTrigger, /FORCE_DELETE_EVENT/);
  const updateTrigger = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'heat_entries_update_unlocked'",
  ).get().sql;
  assert.match(updateTrigger, /NEW\.id = OLD\.id/);
  assert.match(updateTrigger, /NEW\.created_at = OLD\.created_at/);

  const indexes = objectNames(database, "index");
  assert.ok(indexes.includes("events_status_date_idx"));
  assert.ok(indexes.includes("staff_role_assignments_current_idx"));
  assert.ok(indexes.includes("staff_role_assignments_history_idx"));

  // Every remaining lifecycle status is accepted.
  for (const status of lifecycleStatuses) {
    database.exec(
      `INSERT INTO events (id, slug, name, timezone, status)
       VALUES ('event-${status}', 'slug-${status}', 'Race ${status}', 'UTC', '${status}')`,
    );
  }
  assert.equal(count(database, "events"), lifecycleStatuses.length);

  // Both retired statuses are rejected.
  for (const status of ["RETURN_PROCESSING", "ARCHIVED"]) {
    assert.throws(() => database.exec(
      `INSERT INTO events (id, slug, name, timezone, status)
       VALUES ('event-retired', 'slug-retired', 'Retired', 'UTC', '${status}')`,
    ), /CHECK constraint failed/, status);
  }

  // Every other events constraint and default survived the rebuild.
  assert.throws(() => database.exec(
    `INSERT INTO events (id, slug, name, timezone, status)
     VALUES ('event-blank', '   ', 'Blank Slug', 'UTC', 'DRAFT')`,
  ), /CHECK constraint failed/);
  assert.throws(() => database.exec(
    `INSERT INTO events (id, slug, name, timezone, status)
     VALUES ('event-dup', 'SLUG-DRAFT', 'Duplicate Slug', 'UTC', 'DRAFT')`,
  ), /UNIQUE constraint failed/);
  assert.throws(() => database.exec(
    `INSERT INTO events (id, slug, name, timezone, status, registration_opens_at, registration_closes_at)
     VALUES ('event-window', 'slug-window', 'Bad Window', 'UTC', 'DRAFT',
             '2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ), /CHECK constraint failed/);
  assert.throws(() => database.exec(
    `INSERT INTO events (id, slug, name, timezone, status, round_one_heat_capacity)
     VALUES ('event-capacity', 'slug-capacity', 'Bad Capacity', 'UTC', 'DRAFT', 0)`,
  ), /CHECK constraint failed/);
  assert.deepEqual(
    { ...database.prepare("SELECT * FROM events WHERE id = 'event-DRAFT'").get() },
    {
      id: "event-DRAFT",
      slug: "slug-DRAFT",
      name: "Race DRAFT",
      event_date: null,
      timezone: "UTC",
      status: "DRAFT",
      registration_opens_at: null,
      registration_closes_at: null,
      email_required: 0,
      heat_assignment_mode: "POST_CLOSE_BALANCED",
      round_one_heat_capacity: 10,
      final_heat_capacity: 50,
      created_at: database.prepare("SELECT created_at FROM events WHERE id = 'event-DRAFT'").get().created_at,
      updated_at: database.prepare("SELECT updated_at FROM events WHERE id = 'event-DRAFT'").get().updated_at,
      public_name_policy: "FIRST_NAME_LAST_INITIAL",
      revision: 0,
    },
  );

  // Inbound foreign keys still resolve to the rebuilt events table.
  assert.throws(() => database.exec(
    `INSERT INTO registrations
       (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
        submitted_at, status_changed_at)
     VALUES ('orphan', 'missing-event', 'Daisy', 'Duck', 'SUBMITTED', 'DAISY123', 'orphan-hash',
             '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z')`,
  ), /FOREIGN KEY constraint failed/);
  database.exec(
    `INSERT INTO registrations
       (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
        submitted_at, status_changed_at)
     VALUES ('registration', 'event-DRAFT', 'Daisy', 'Duck', 'SUBMITTED', 'DAISY123', 'hash',
             '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z')`,
  );
  assert.throws(
    () => database.exec("DELETE FROM events WHERE id = 'event-DRAFT'"),
    /FOREIGN KEY constraint failed/,
    "ON DELETE RESTRICT must still protect the rebuilt events table",
  );

  // The role vocabulary lost exactly RETURN_STEWARD.
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff', 'staff-sub', 'staff@example.com'),
           ('other-staff', 'other-sub', 'other@example.com');
  `);
  for (const role of [
    "REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR",
  ]) {
    database.exec(
      `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
       VALUES ('role-${role}', 'staff', '${role}', '2026-07-26T00:00:00Z')`,
    );
  }
  assert.throws(() => database.exec(
    `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
     VALUES ('role-retired', 'staff', 'RETURN_STEWARD', '2026-07-26T00:00:00Z')`,
  ), /CHECK constraint failed/);
  // The current-role partial unique index survived the rebuild.
  assert.throws(() => database.exec(
    `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
     VALUES ('role-duplicate', 'staff', 'ANNOUNCER', '2026-07-26T00:00:00Z')`,
  ), /UNIQUE constraint failed/);
  // The revocation all-or-nothing CHECK survived the rebuild.
  assert.throws(() => database.exec(
    "UPDATE staff_role_assignments SET revoked_at = '2026-07-27T00:00:00Z' WHERE id = 'role-ANNOUNCER'",
  ), /CHECK constraint failed/);
  // Both staff_profiles foreign keys survived the rebuild.
  assert.throws(() => database.exec(
    `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
     VALUES ('role-bad-target', 'missing-staff', 'REGISTRATION', '2026-07-26T00:00:00Z')`,
  ), /FOREIGN KEY constraint failed/);
  assert.throws(() => database.exec(
    `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at, assigned_by_staff_profile_id)
     VALUES ('role-bad-actor', 'other-staff', 'RESULT_TAKER', '2026-07-27T00:00:00Z', 'missing-staff')`,
  ), /FOREIGN KEY constraint failed/);

  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    database.prepare("PRAGMA integrity_check").all().map((row) => ({ ...row })),
    [{ integrity_check: "ok" }],
  );
  database.close();
});

// Seeds the pre-0014 world: a full event dataset in a retired status, retired
// return/disposition/purge rows, a RETURN_STEWARD assignment, and historical
// role JSON that still names the retired role.
const seedLegacyData = (database, eventStatus) => {
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 'Administrator', 1, 1),
      ('steward', 'steward-sub', 'steward@example.com', 'Steward', 0, 1);
    INSERT INTO staff_access_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id,
       requested_at, completed_at, requested_account_type, requested_roles_json)
    VALUES
      ('grant-steward', 'ADD_STAFF', 'steward', 'admin', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
       'STAFF', '["REGISTRATION","DUCK_MANAGER","ANNOUNCER","HEAT_RUNNER","RESULT_TAKER","RETURN_STEWARD","RACE_DIRECTOR"]'),
      ('grant-admin', 'ADD_STAFF', 'admin', 'admin', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
       'ADMIN', '[]'),
      ('grant-steward-only', 'ADD_STAFF', 'steward', 'admin', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z',
       'STAFF', '["RETURN_STEWARD"]');
    INSERT INTO staff_lifecycle_commands
      (id, command_type, target_staff_profile_id, requested_by_staff_profile_id, requested_role,
       result_is_system_admin, result_is_active, requested_at, completed_at, requested_roles_json)
    VALUES
      ('change-steward', 'CHANGE_STAFF_ROLE', 'steward', 'admin', 'STAFF', 0, 1,
       '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z',
       '["RETURN_STEWARD","RACE_DIRECTOR"]'),
      ('deactivate-steward', 'DEACTIVATE_STAFF', 'steward', 'admin', NULL, 0, 1,
       '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z', NULL);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES
      ('steward-returns', 'steward', 'RETURN_STEWARD', '2026-07-02T00:00:00Z'),
      ('steward-registration', 'steward', 'REGISTRATION', '2026-07-02T00:00:00Z'),
      ('steward-director', 'steward', 'RACE_DIRECTOR', '2026-07-02T00:00:00Z');

    INSERT INTO events (id, slug, name, event_date, timezone, status)
    VALUES ('event', 'legacy-race', 'Legacy Race', '2026-08-30', 'UTC', '${eventStatus}');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, status, lookup_code, private_token_hash,
       email_notifications_enabled, submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Daisy', 'Duck', 'daisy@example.com', 'ACTIVE', 'DAISY123',
            'private-hash', 1, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id) VALUES ('entry', 'event', 'registration');
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES
      ('pair-command', 'event', 'PAIR_DUCK', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('result-command', 'event', 'FINALIZE_HEAT_RESULTS', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck', 1, 'IN_USE', '2026-07-26T00:00:00Z');
    INSERT INTO duck_tags (id, duck_id, token, status, supersedes_tag_id, activated_at, retired_at)
    VALUES
      ('tag-old', 'duck', '${"o".repeat(32)}', 'RETIRED', NULL, '2026-07-26T00:00:00Z', '2026-07-26T00:10:00Z'),
      ('tag-new', 'duck', '${"n".repeat(32)}', 'ACTIVE', 'tag-old', '2026-07-26T00:10:00Z', NULL);
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck', 'event', 'duck', '2026-07-26T00:00:00Z', 'admin');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment', 'event', 'entry', 'event-duck', 'duck', '2026-07-26T00:00:00Z',
            'admin', 'pair-command');
    INSERT INTO duck_inventory_events
      (id, event_id, duck_id, action, actor_staff_profile_id, source_command_id, occurred_at, details_json)
    VALUES ('inventory', 'event', 'duck', 'DUCK_ASSIGNED', 'admin', 'pair-command',
            '2026-07-26T00:00:00Z', '{}');
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('heat', 'event', 'ROUND_ONE', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry', 'event', 'heat', 'entry', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z');
    -- A locked, finalized roster: the legacy delete trigger would refuse this.
    UPDATE heats
       SET status = 'FINALIZED', roster_locked_at = '2026-07-26T01:00:00Z',
           finalized_at = '2026-07-26T01:10:00Z'
     WHERE id = 'heat';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('heat-result', 'event', 'heat', 'entry', 'assignment', 1, 'FINALIZED', 1,
            '2026-07-26T01:10:00Z', 'admin', 'result-command');
    INSERT INTO heat_result_history
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id, invalidated_at,
       invalidated_by_staff_profile_id, invalidated_by_source_command_id, invalidation_reason, created_at)
    VALUES ('result-history', 'event', 'heat', 'entry', 'assignment', 2, 'SUPERSEDED', 1,
            '2026-07-26T01:08:00Z', 'admin', 'result-command', '2026-07-26T01:09:00Z',
            'admin', 'result-command', 'Correction test', '2026-07-26T01:08:00Z');
    INSERT INTO email_notifications (id, event_id, registration_id, heat_id, notification_type, status)
    VALUES ('notification', 'event', 'registration', 'heat', 'HEAT_ASSIGNED', 'PENDING');
    INSERT INTO email_attempts (id, event_id, notification_id, attempt_number, stage, status, started_at)
    VALUES ('attempt', 'event', 'notification', 1, 'QUEUE', 'PENDING', '2026-07-26T02:00:00Z');
    INSERT INTO return_batches
      (id, event_id, status, source_command_id, started_by_staff_profile_id, started_at)
    VALUES ('batch', 'event', 'OPEN', 'batch-command', 'admin', '2026-07-26T03:00:00Z');
    INSERT INTO return_batch_items
      (id, event_id, batch_id, event_duck_id, sequence_number, disposition, source_command_id,
       added_by_staff_profile_id, added_at)
    VALUES ('batch-item', 'event', 'batch', 'event-duck', 1, 'RETURNED', 'item-command',
            'admin', '2026-07-26T03:01:00Z');
    INSERT INTO duck_event_dispositions
      (id, event_id, event_duck_id, disposition, recorded_by_staff_profile_id, source_command_id, recorded_at)
    VALUES ('disposition', 'event', 'event-duck', 'RETURNED', 'admin', 'pair-command',
            '2026-07-26T03:02:00Z');
    INSERT INTO event_purge_claims (event_id, command_id, status, claimed_by_staff_profile_id, claimed_at)
    VALUES ('event', 'claim-command', 'PURGING', 'admin', '2026-07-26T04:00:00Z');
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection', 'collection-hash', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z',
            '2027-07-26T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at)
    VALUES ('collection', 'registration', '2026-07-26T00:00:00Z');
    INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
    VALUES ('audit', 'event', 'pair-command', 'DUCK_PAIRED', 'RACE_ENTRY', 'entry', 'STAFF',
            '2026-07-26T00:00:00Z', '{}');
  `);
};

const clearedTables = [
  "events",
  "registrations",
  "race_entries",
  "ducks",
  "duck_tags",
  "event_ducks",
  "duck_assignments",
  "duck_inventory_events",
  "heats",
  "heat_entries",
  "heat_results",
  "heat_result_history",
  "email_notifications",
  "email_attempts",
  "browser_registration_collections",
  "browser_collection_registrations",
  "race_commands",
  "audit_events",
];

for (const eventStatus of ["ARCHIVED", "RETURN_PROCESSING", "COMPLETED"]) {
  test(`0014 wipes legacy ${eventStatus} race data and keeps staff records`, () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database, migrationsBefore("0014_simplified_lifecycle_schema.sql"));
    seedLegacyData(database, eventStatus);

    applyMigrations(database, ["0014_simplified_lifecycle_schema.sql"]);

    for (const table of clearedTables) {
      assert.equal(count(database, table), 0, `expected ${table} to be empty`);
    }
    for (const table of retiredTables) {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table).count,
        0,
        `expected ${table} to be dropped`,
      );
    }

    // Staff profiles and their still-valid role assignments survive untouched.
    assert.deepEqual(
      database.prepare("SELECT id, email, is_system_admin, is_active FROM staff_profiles ORDER BY id")
        .all().map((row) => ({ ...row })),
      [
        { id: "admin", email: "admin@example.com", is_system_admin: 1, is_active: 1 },
        { id: "steward", email: "steward@example.com", is_system_admin: 0, is_active: 1 },
      ],
    );
    assert.deepEqual(
      database.prepare("SELECT id, role FROM staff_role_assignments ORDER BY id").all()
        .map((row) => ({ ...row })),
      [
        { id: "steward-director", role: "RACE_DIRECTOR" },
        { id: "steward-registration", role: "REGISTRATION" },
      ],
    );
    assert.equal(count(database, "organization_event_defaults"), 1);
    assert.equal(count(database, "staff_access_commands"), 3);
    assert.equal(count(database, "staff_lifecycle_commands"), 2);

    // The retired role survives in no historical role JSON either.
    assert.deepEqual(
      database.prepare("SELECT id, requested_roles_json FROM staff_access_commands ORDER BY id")
        .all().map((row) => ({ ...row })),
      [
        { id: "grant-admin", requested_roles_json: "[]" },
        {
          id: "grant-steward",
          requested_roles_json:
            '["REGISTRATION","DUCK_MANAGER","ANNOUNCER","HEAT_RUNNER","RESULT_TAKER","RACE_DIRECTOR"]',
        },
        { id: "grant-steward-only", requested_roles_json: "[]" },
      ],
    );
    assert.deepEqual(
      database.prepare("SELECT id, requested_roles_json FROM staff_lifecycle_commands ORDER BY id")
        .all().map((row) => ({ ...row })),
      [
        { id: "change-steward", requested_roles_json: '["RACE_DIRECTOR"]' },
        { id: "deactivate-steward", requested_roles_json: null },
      ],
    );
    assert.equal(
      database.prepare(
        `SELECT COUNT(*) AS count FROM staff_access_commands
          WHERE requested_roles_json LIKE '%RETURN_STEWARD%'`,
      ).get().count,
      0,
    );
    assert.equal(
      database.prepare(
        `SELECT COUNT(*) AS count FROM staff_lifecycle_commands
          WHERE requested_roles_json LIKE '%RETURN_STEWARD%'`,
      ).get().count,
      0,
    );

    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      database.prepare("PRAGMA integrity_check").all().map((row) => ({ ...row })),
      [{ integrity_check: "ok" }],
    );
    database.close();
  });
}

// The rebuilt trigger must keep protecting a locked roster in normal operation
// and open exactly one escape: the FORCE_DELETE_EVENT sentinel row.
test("0014 heat_entries_delete_unlocked protects locked rosters except under the force delete sentinel", () => {
  const database = createDatabase();
  const seedRoster = (suffix, lock) => {
    database.exec(`
      INSERT INTO events (id, slug, name, timezone, status)
      VALUES ('event-${suffix}', 'slug-${suffix}', 'Race ${suffix}', 'UTC', 'ROUND_ONE');
      INSERT INTO registrations
        (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
         submitted_at, status_changed_at)
      VALUES ('registration-${suffix}', 'event-${suffix}', 'Daisy', 'Duck', 'ACTIVE', 'DAISY12${suffix}',
              'hash-${suffix}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
      INSERT INTO race_entries (id, event_id, registration_id)
      VALUES ('entry-${suffix}', 'event-${suffix}', 'registration-${suffix}');
      INSERT INTO heats (id, event_id, round, heat_number, status)
      VALUES ('heat-${suffix}', 'event-${suffix}', 'ROUND_ONE', 1, 'PLANNED');
      INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
      VALUES ('heat-entry-${suffix}', 'event-${suffix}', 'heat-${suffix}', 'entry-${suffix}',
              'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z');
    `);
    if (lock) {
      database.exec(`
        UPDATE heats
           SET status = 'FINALIZED', roster_locked_at = '2026-07-26T01:00:00Z',
               finalized_at = '2026-07-26T01:10:00Z'
         WHERE id = 'heat-${suffix}';
      `);
    }
  };

  // An unlocked PLANNED roster is still freely editable.
  seedRoster("open", false);
  database.exec("DELETE FROM heat_entries WHERE id = 'heat-entry-open'");
  assert.equal(count(database, "heat_entries"), 0);

  // A locked roster is still protected.
  seedRoster("locked", true);
  const lockedEntry = {
    ...database.prepare("SELECT id, created_at FROM heat_entries WHERE id = 'heat-entry-locked'").get(),
  };
  assert.throws(
    () => database.exec("DELETE FROM heat_entries WHERE id = 'heat-entry-locked'"),
    /heat roster is locked/,
  );
  assert.equal(count(database, "heat_entries"), 1);
  assert.throws(
    () => database.exec("UPDATE heat_entries SET id = 'renamed-entry' WHERE id = 'heat-entry-locked'"),
    /heat roster is locked/,
  );
  assert.throws(
    () => database.exec(
      "UPDATE heat_entries SET created_at = '2026-07-27T00:00:00Z' WHERE id = 'heat-entry-locked'",
    ),
    /heat roster is locked/,
  );
  assert.deepEqual(
    { ...database.prepare("SELECT id, created_at FROM heat_entries WHERE id = 'heat-entry-locked'").get() },
    lockedEntry,
  );

  // A sentinel for a different command type does not open the escape.
  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('other-command', 'event-locked', 'FINALIZE_HEAT_RESULTS',
            '2026-07-26T02:00:00Z', '2026-07-26T02:00:00Z');
  `);
  assert.throws(
    () => database.exec("DELETE FROM heat_entries WHERE id = 'heat-entry-locked'"),
    /heat roster is locked/,
  );

  // A sentinel for a different event does not open the escape either.
  seedRoster("other", true);
  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('force-other', 'event-other', 'FORCE_DELETE_EVENT',
            '2026-07-26T02:00:00Z', '2026-07-26T02:00:00Z');
  `);
  assert.throws(
    () => database.exec("DELETE FROM heat_entries WHERE id = 'heat-entry-locked'"),
    /heat roster is locked/,
  );

  // The event's own force delete sentinel opens it.
  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('force-locked', 'event-locked', 'FORCE_DELETE_EVENT',
            '2026-07-26T02:00:00Z', '2026-07-26T02:00:00Z');
    DELETE FROM heat_entries WHERE id = 'heat-entry-locked';
  `);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE id = 'heat-entry-locked'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0021 adds unique nullable delivery claims without breaking older notification writes", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0021_email_delivery_claim.sql"));
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('claim-event', 'claim-race', 'Claim Race', 'UTC', 'REGISTRATION_OPEN');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code,
       private_token_hash, submitted_at, status_changed_at)
    VALUES
      ('claim-registration-1', 'claim-event', 'Daisy', 'Duck', 'ACTIVE',
       'DAISY123', 'claim-hash-1', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
      ('claim-registration-2', 'claim-event', 'Donald', 'Duck', 'ACTIVE',
       'DONALD12', 'claim-hash-2', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status, sending_started_at)
    VALUES
      ('claim-notification-1', 'claim-event', 'claim-registration-1',
       'HEAT_ASSIGNED', 'SENDING', '2026-08-01T00:05:00Z');
  `);

  applyMigrations(database, ["0021_email_delivery_claim.sql"]);
  assert.equal(database.prepare(
    "SELECT delivery_claim_token FROM email_notifications WHERE id = 'claim-notification-1'",
  ).get().delivery_claim_token, null);

  // The previously deployed Worker omits the new column. Its insert remains
  // valid while migration and Worker deployment are separated.
  database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status)
    VALUES
      ('claim-notification-2', 'claim-event', 'claim-registration-2',
       'HEAT_ASSIGNED', 'PENDING');
  `);
  database.prepare(
    "UPDATE email_notifications SET delivery_claim_token = ? WHERE id = ?",
  ).run("claim-token", "claim-notification-1");
  assert.throws(() => database.prepare(
    "UPDATE email_notifications SET delivery_claim_token = ? WHERE id = ?",
  ).run("claim-token", "claim-notification-2"), /UNIQUE constraint failed/);
  assert.throws(() => database.prepare(
    "UPDATE email_notifications SET delivery_claim_token = ? WHERE id = ?",
  ).run("", "claim-notification-2"), /CHECK constraint failed/);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("0022 keeps pending results private and fails closed for an older Worker", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, migrationsBefore("0022_pending_heat_result_announcement.sql"));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff', 'staff-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'pending-race', 'Pending Race', 'UTC', 'ROUND_ONE');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Daisy', 'Duck', 'ACTIVE', 'DAISY123', 'hash',
            '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry', 'event', 'registration');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck', 1, 'IN_USE', '2026-08-02T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck', 'event', 'duck', '2026-08-02T00:00:00Z', 'staff');
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('assign', 'event', 'ASSIGN_DUCK', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment', 'event', 'entry', 'event-duck', 'duck',
            '2026-08-02T00:00:00Z', 'staff', 'assign');
    INSERT INTO heats
      (id, event_id, round, heat_number, status)
    VALUES ('heat', 'event', 'ROUND_ONE', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry', 'event', 'heat', 'entry', 'ROUND_ONE', 1,
            'PAIRING', '2026-08-02T00:20:00Z');
    UPDATE heats
       SET status = 'AWAITING_RESULT', roster_locked_at = '2026-08-02T00:30:00Z',
           finished_at = '2026-08-02T00:40:00Z'
     WHERE id = 'heat';
  `);

  applyMigrations(database, ["0022_pending_heat_result_announcement.sql"]);
  database.exec(`
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('record', 'event', 'RECORD_HEAT_RESULT', 'heat',
            '2026-08-02T00:45:00Z', '2026-08-02T00:45:00Z', 'staff');
    INSERT INTO pending_heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
       result_revision, recorded_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('pending', 'event', 'heat', 'entry', 'assignment', 1, 1,
            '2026-08-02T00:45:00Z', 'staff', 'record');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('old-finalize', 'event', 'FINALIZE_HEAT_RESULT', 'heat',
            '2026-08-02T00:46:00Z', '2026-08-02T00:46:00Z', 'staff');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('old-result', 'event', 'heat', 'entry', 'assignment', 1, 1,
            '2026-08-02T00:46:00Z', 'staff', 'old-finalize')
  `), /pending result must be announcement-confirmed/);
  assert.throws(
    () => database.exec("UPDATE heats SET status = 'FINALIZED' WHERE id = 'heat'"),
    /clear pending result before changing heat status/,
  );

  database.exec(`
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('announce', 'event', 'CONFIRM_WINNER_ANNOUNCEMENT', 'heat',
            '2026-08-02T00:47:00Z', '2026-08-02T00:47:00Z', 'staff');
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('official', 'event', 'heat', 'entry', 'assignment', 1, 1,
            '2026-08-02T00:47:00Z', 'staff', 'announce');
    DELETE FROM pending_heat_results WHERE heat_id = 'heat';
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-08-02T00:47:00Z' WHERE id = 'heat';
  `);
  assert.equal(count(database, "pending_heat_results"), 0);
  assert.equal(count(database, "heat_results"), 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
