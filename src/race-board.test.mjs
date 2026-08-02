import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";

class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) { this.args = args; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
}

const d1 = (database) => ({ prepare: (sql) => new Statement(database, sql) });

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((item) => /^\d{4}_.+\.sql$/.test(item)).sort()) {
    database.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  return database;
};

const responseBoard = async (database) => {
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/race-board"),
    { APP_ORIGIN: "https://quickducks.com", DB: d1(database) },
  );
  assert.equal(response.status, 200);
  return response.json();
};

test("public board stays ordered, current, and privacy-filtered through the race", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('staff', 'staff-sub', 'operator@example.com', 1);
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event', 'public-race', 'Public Race', '2026-08-30', 'America/Denver', 'ROUND_ONE', 'FIRST_NAME_LAST_INITIAL');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, phone, status, lookup_code,
       private_token_hash, submitted_at, status_changed_at, staff_notes)
    VALUES
      ('registration-1', 'event', 'Daisy', 'Duck', 'daisy@example.com', '555-0101', 'ACTIVE', 'PRIVATE1', 'private-hash-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'private note'),
      ('registration-2', 'event', 'Donald', 'Mallard', 'donald@example.com', '555-0102', 'ACTIVE', 'PRIVATE2', 'private-hash-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'other note');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1'), ('entry-2', 'event', 'registration-2');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at, storage_location, notes)
    VALUES
      ('duck-1', 11, 'IN_USE', '2026-07-26T00:00:00Z', 'Secret shelf', 'inventory note'),
      ('duck-2', 22, 'IN_USE', '2026-07-26T00:00:00Z', 'Other shelf', 'inventory note');
    INSERT INTO duck_tags (id, duck_id, token, status, activated_at)
    VALUES ('tag-1', 'duck-1', '${"a".repeat(32)}', 'ACTIVE', '2026-07-26T00:00:00Z'),
           ('tag-2', 'duck-2', '${"b".repeat(32)}', 'ACTIVE', '2026-07-26T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-1', 'event', 'duck-1', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-2', 'event', 'duck-2', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES
      ('assign-1', 'event', 'ASSIGN_DUCK', 'assignment-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
      ('assign-2', 'event', 'ASSIGN_DUCK', 'assignment-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
      ('result-1', 'event', 'FINALIZE_HEAT_RESULT', 'round-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
      ('result-2', 'event', 'FINALIZE_HEAT_RESULT', 'round-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
      ('result-final', 'event', 'FINALIZE_HEAT_RESULT', 'final', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES
      ('assignment-1', 'event', 'entry-1', 'event-duck-1', 'duck-1', '2026-07-26T00:00:00Z', 'staff', 'assign-1'),
      ('assignment-2', 'event', 'entry-2', 'event-duck-2', 'duck-2', '2026-07-26T00:00:00Z', 'staff', 'assign-2');
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size, finalized_at)
    VALUES
      ('round-2', 'event', 'ROUND_ONE', 2, 'PLANNED', 1, NULL),
      ('round-1', 'event', 'ROUND_ONE', 1, 'PLANNED', 1, NULL),
      ('final', 'event', 'FINAL', 1, 'PLANNED', 2, NULL);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('round-entry-1', 'event', 'round-1', 'entry-1', 'ROUND_ONE', 1, 'BALANCED_DRAW', '2026-07-26T00:00:00Z'),
      ('round-entry-2', 'event', 'round-2', 'entry-2', 'ROUND_ONE', 1, 'BALANCED_DRAW', '2026-07-26T00:00:00Z'),
      ('final-entry-1', 'event', 'final', 'entry-1', 'FINAL', 1, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
      ('final-entry-2', 'event', 'final', 'entry-2', 'FINAL', 2, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z');
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-07-26T01:00:00Z' WHERE id = 'round-1';
    UPDATE heats SET status = 'CALLING' WHERE id = 'round-2';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('winner-1', 'event', 'round-1', 'entry-1', 'assignment-1', 1, 1,
            '2026-07-26T01:00:00Z', 'staff', 'result-1');
  `);

  const roundOne = await responseBoard(database);
  assert.equal(roundOne.event.status, "ROUND_ONE");
  assert.deepEqual(roundOne.event.roundOneHeats.map((heat) => heat.number), [1, 2]);
  assert.deepEqual(roundOne.event.currentHeat, { round: "ROUND_ONE", number: 2, status: "CALLING" });
  assert.equal(roundOne.event.roundOneHeats[0].roster[0].participantDisplayName, "Daisy D.");
  assert.equal(roundOne.event.roundOneHeats[0].roster[0].place, 1);
  assert.deepEqual(roundOne.event.podium, []);

  database.exec(`
    UPDATE heats SET status = 'AWAITING_RESULT' WHERE id = 'round-2';
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('record-pending-2', 'event', 'RECORD_HEAT_RESULT', 'round-2',
            '2026-07-26T01:05:00Z', '2026-07-26T01:05:00Z', 'staff');
    INSERT INTO pending_heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
       result_revision, recorded_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('pending-2', 'event', 'round-2', 'entry-2', 'assignment-2', 1,
            1, '2026-07-26T01:05:00Z', 'staff', 'record-pending-2');
  `);
  const awaitingAnnouncement = await responseBoard(database);
  assert.equal(awaitingAnnouncement.event.roundOneHeats[1].status, "AWAITING_RESULT");
  assert.equal(awaitingAnnouncement.event.roundOneHeats[1].roster[0].place, null,
    "a recorded but unannounced result is not public");
  database.exec("DELETE FROM pending_heat_results WHERE heat_id = 'round-2'");

  database.exec(`
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-07-26T01:10:00Z' WHERE id = 'round-2';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('winner-2', 'event', 'round-2', 'entry-2', 'assignment-2', 1, 1,
            '2026-07-26T01:10:00Z', 'staff', 'result-2');
    UPDATE events SET status = 'FINAL' WHERE id = 'event';
    UPDATE heats SET status = 'RUNNING', started_at = '2026-07-26T01:20:00Z' WHERE id = 'final';
  `);
  const finalRunning = await responseBoard(database);
  assert.deepEqual(finalRunning.event.currentHeat, { round: "FINAL", number: 1, status: "RUNNING" });
  assert.deepEqual(finalRunning.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [11, 22]);

  database.exec(`
    UPDATE events SET status = 'COMPLETED' WHERE id = 'event';
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-07-26T01:30:00Z' WHERE id = 'final';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES
      ('podium-1', 'event', 'final', 'entry-2', 'assignment-2', 1, 1, '2026-07-26T01:30:00Z', 'staff', 'result-final'),
      ('podium-2', 'event', 'final', 'entry-1', 'assignment-1', 2, 1, '2026-07-26T01:30:00Z', 'staff', 'result-final');
  `);
  const completed = await responseBoard(database);
  assert.equal(completed.event.status, "COMPLETED");
  assert.equal(completed.event.currentHeat, null);
  assert.deepEqual(completed.event.podium.map((entry) => [entry.place, entry.duckNumber]), [[1, 22], [2, 11]]);
  assert.deepEqual(completed.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [22, 11]);

  // Participant-chosen duck names ride beside the number on the roster and the
  // podium, and the read-time filter decides which of them a visitor sees.
  database.exec(`
    UPDATE race_entries SET duck_name = 'Bubbles' WHERE id = 'entry-2';
    UPDATE race_entries SET duck_name = 'Bastard Duck' WHERE id = 'entry-1';
  `);
  const named = await responseBoard(database);
  assert.deepEqual(
    named.event.podium.map((entry) => [entry.place, entry.duckNumber, entry.duckName]),
    [[1, 22, "Bubbles"], [2, 11, null]],
  );
  assert.equal(named.event.finalHeats[0].roster.find((entry) => entry.duckNumber === 22).duckName, "Bubbles");
  // The suppressed one never reaches the board at all, and its number stays.
  assert.equal(JSON.stringify(named).includes("Bastard"), false);
  assert.equal(named.event.finalHeats[0].roster.find((entry) => entry.duckNumber === 11).duckName, null);
  assert.doesNotMatch(
    JSON.stringify(completed),
    /email|phone|lookup|private|token|staff|note|inventory|audit|registrationId|raceEntry|assignmentId/i,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("official winners lead both heat rounds while non-winner slot order stays stable", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('staff', 'staff-sub', 'operator@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status, public_name_policy)
    VALUES ('event', 'ordered-race', 'Ordered Race', 'UTC', 'ROUND_ONE', 'FIRST_NAME_ONLY');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES
      ('registration-1', 'event', 'One', 'Duck', 'ACTIVE', 'ORDER001', 'hash-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('registration-2', 'event', 'Two', 'Duck', 'ACTIVE', 'ORDER002', 'hash-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('registration-3', 'event', 'Three', 'Duck', 'ACTIVE', 'ORDER003', 'hash-3', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1'),
           ('entry-2', 'event', 'registration-2'),
           ('entry-3', 'event', 'registration-3');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-1', 1, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-2', 2, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-3', 3, 'IN_USE', '2026-07-26T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-1', 'event', 'duck-1', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-2', 'event', 'duck-2', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-3', 'event', 'duck-3', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('assign-1', 'event', 'ASSIGN_DUCK', 'assignment-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('assign-2', 'event', 'ASSIGN_DUCK', 'assignment-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('assign-3', 'event', 'ASSIGN_DUCK', 'assignment-3', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('round-result', 'event', 'FINALIZE_HEAT_RESULT', 'round', '2026-07-26T01:00:00Z', '2026-07-26T01:00:00Z', 'staff'),
           ('final-result', 'event', 'FINALIZE_HEAT_RESULT', 'final', '2026-07-26T02:00:00Z', '2026-07-26T02:00:00Z', 'staff');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment-1', 'event', 'entry-1', 'event-duck-1', 'duck-1', '2026-07-26T00:00:00Z', 'staff', 'assign-1'),
           ('assignment-2', 'event', 'entry-2', 'event-duck-2', 'duck-2', '2026-07-26T00:00:00Z', 'staff', 'assign-2'),
           ('assignment-3', 'event', 'entry-3', 'event-duck-3', 'duck-3', '2026-07-26T00:00:00Z', 'staff', 'assign-3');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('round', 'event', 'ROUND_ONE', 1, 'PLANNED', 3),
           ('final', 'event', 'FINAL', 1, 'PLANNED', 3);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('round-1', 'event', 'round', 'entry-1', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('round-2', 'event', 'round', 'entry-2', 'ROUND_ONE', 2, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('round-3', 'event', 'round', 'entry-3', 'ROUND_ONE', 3, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('final-1', 'event', 'final', 'entry-1', 'FINAL', 1, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
           ('final-2', 'event', 'final', 'entry-2', 'FINAL', 2, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
           ('final-3', 'event', 'final', 'entry-3', 'FINAL', 3, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z');
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-07-26T02:00:00Z';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('round-winner', 'event', 'round', 'entry-3', 'assignment-3', 1, 1, '2026-07-26T01:00:00Z', 'staff', 'round-result'),
           ('final-winner', 'event', 'final', 'entry-2', 'assignment-2', 1, 1, '2026-07-26T02:00:00Z', 'staff', 'final-result');
  `);

  const board = await responseBoard(database);
  assert.deepEqual(board.event.roundOneHeats[0].roster.map((entry) => entry.duckNumber), [3, 1, 2]);
  assert.deepEqual(board.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [2, 1, 3]);
  assert.deepEqual(board.event.roundOneHeats[0].roster.map((entry) => entry.place), [1, null, null]);
  assert.deepEqual(board.event.finalHeats[0].roster.map((entry) => entry.place), [1, null, null]);
});

// A withdrawn or disqualified racer's duck is sealed in its heat bag and may
// still float past the finish line, but publicly it is not in the race. The
// board must omit it without moving anything else: the bags are not resorted, so
// the surviving entries keep their stored slot order, their printed duck
// numbers, and their official places exactly as they were.
test("withdrawn and disqualified racers vanish from every board surface without shifting the rest", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('staff', 'staff-sub', 'operator@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status, public_name_policy)
    VALUES ('event', 'exit-race', 'Exit Race', 'UTC', 'COMPLETED', 'FIRST_NAME_ONLY');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES
      ('registration-1', 'event', 'Alpha', 'Duck', 'ACTIVE', 'EXIT0001', 'hash-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('registration-2', 'event', 'Bravo', 'Duck', 'ACTIVE', 'EXIT0002', 'hash-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('registration-3', 'event', 'Charlie', 'Duck', 'ACTIVE', 'EXIT0003', 'hash-3', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('registration-4', 'event', 'Delta', 'Duck', 'ACTIVE', 'EXIT0004', 'hash-4', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event', 'registration-1'),
           ('entry-2', 'event', 'registration-2'),
           ('entry-3', 'event', 'registration-3'),
           ('entry-4', 'event', 'registration-4');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-1', 1, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-2', 2, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-3', 3, 'IN_USE', '2026-07-26T00:00:00Z'),
           ('duck-4', 4, 'IN_USE', '2026-07-26T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-1', 'event', 'duck-1', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-2', 'event', 'duck-2', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-3', 'event', 'duck-3', '2026-07-26T00:00:00Z', 'staff'),
           ('event-duck-4', 'event', 'duck-4', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('assign-1', 'event', 'ASSIGN_DUCK', 'assignment-1', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('assign-2', 'event', 'ASSIGN_DUCK', 'assignment-2', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('assign-3', 'event', 'ASSIGN_DUCK', 'assignment-3', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('assign-4', 'event', 'ASSIGN_DUCK', 'assignment-4', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', 'staff'),
           ('round-result', 'event', 'FINALIZE_HEAT_RESULT', 'round', '2026-07-26T01:00:00Z', '2026-07-26T01:00:00Z', 'staff'),
           ('final-result', 'event', 'FINALIZE_HEAT_RESULT', 'final', '2026-07-26T02:00:00Z', '2026-07-26T02:00:00Z', 'staff');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment-1', 'event', 'entry-1', 'event-duck-1', 'duck-1', '2026-07-26T00:00:00Z', 'staff', 'assign-1'),
           ('assignment-2', 'event', 'entry-2', 'event-duck-2', 'duck-2', '2026-07-26T00:00:00Z', 'staff', 'assign-2'),
           ('assignment-3', 'event', 'entry-3', 'event-duck-3', 'duck-3', '2026-07-26T00:00:00Z', 'staff', 'assign-3'),
           ('assignment-4', 'event', 'entry-4', 'event-duck-4', 'duck-4', '2026-07-26T00:00:00Z', 'staff', 'assign-4');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('round', 'event', 'ROUND_ONE', 1, 'PLANNED', 4),
           ('final', 'event', 'FINAL', 1, 'PLANNED', 4);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('round-1', 'event', 'round', 'entry-1', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('round-2', 'event', 'round', 'entry-2', 'ROUND_ONE', 2, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('round-3', 'event', 'round', 'entry-3', 'ROUND_ONE', 3, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('round-4', 'event', 'round', 'entry-4', 'ROUND_ONE', 4, 'PAIRING', '2026-07-26T00:00:00Z'),
           ('final-1', 'event', 'final', 'entry-1', 'FINAL', 1, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
           ('final-2', 'event', 'final', 'entry-2', 'FINAL', 2, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
           ('final-3', 'event', 'final', 'entry-3', 'FINAL', 3, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z'),
           ('final-4', 'event', 'final', 'entry-4', 'FINAL', 4, 'WINNER_PROMOTION', '2026-07-26T01:00:00Z');
    UPDATE heats SET status = 'FINALIZED', roster_locked_at = '2026-07-26T00:30:00Z',
                     finalized_at = '2026-07-26T02:00:00Z';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('round-winner', 'event', 'round', 'entry-1', 'assignment-1', 1, 1, '2026-07-26T01:00:00Z', 'staff', 'round-result'),
           ('final-1st', 'event', 'final', 'entry-2', 'assignment-2', 1, 1, '2026-07-26T02:00:00Z', 'staff', 'final-result'),
           ('final-2nd', 'event', 'final', 'entry-3', 'assignment-3', 2, 1, '2026-07-26T02:00:00Z', 'staff', 'final-result'),
           ('final-3rd', 'event', 'final', 'entry-4', 'assignment-4', 3, 1, '2026-07-26T02:00:00Z', 'staff', 'final-result');
  `);

  const before = await responseBoard(database);
  assert.deepEqual(before.event.roundOneHeats[0].roster.map((entry) => entry.duckNumber), [1, 2, 3, 4]);
  assert.deepEqual(before.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [2, 1, 3, 4]);
  assert.deepEqual(before.event.podium.map((entry) => [entry.place, entry.duckNumber]), [[1, 2], [2, 3], [3, 4]]);

  // The round-one heat winner withdraws and a podium finisher is disqualified.
  database.exec(`
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
    UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-3';
  `);
  const after = await responseBoard(database);

  // Both are gone from the round-one roster, the final roster, and the podium.
  assert.deepEqual(after.event.roundOneHeats[0].roster.map((entry) => entry.duckNumber), [2, 4]);
  assert.deepEqual(after.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [2, 4]);
  assert.deepEqual(after.event.podium.map((entry) => [entry.place, entry.duckNumber]), [[1, 2], [3, 4]]);
  // S4, the recorded product decision — see "The Public Podium Keeps Its Place
  // Numbers" in docs/WORKFLOWS.md. Disqualifying the published second place
  // leaves a visible gap at places 1 and 3, and that gap stays. Renumbering the
  // survivor to second would publish a claim the race never made about who
  // finished second, and the official result rows, which are what an appeal is
  // decided from, still say third. Privacy is absolute either way: the racer who
  // left is nowhere in the payload. A director who wants the places closed up
  // corrects the final result, which republishes a genuinely new podium.
  assert.deepEqual(after.event.podium.map((entry) => entry.place), [1, 3]);
  assert.equal(after.event.podium.length, 2, "the podium shrinks rather than promoting anybody");
  assert.deepEqual(after.event.finalHeats[0].roster.map((entry) => entry.place), [1, 3]);
  // The projection reports exactly the stored places, unmodified.
  assert.deepEqual(
    database.prepare(
      "SELECT place FROM heat_results WHERE heat_id = 'final' AND status = 'FINALIZED' ORDER BY place",
    ).all().map((row) => row.place),
    [1, 2, 3],
  );
  assert.equal(after.event.roundOneHeats[0].roster[0].participantDisplayName, "Bravo");

  // The round-one heat's published winner was the racer who withdrew. That heat
  // is still `FINALIZED` and still publishes its surviving roster, simply with
  // nobody holding first place — never a broken row with a place and no name.
  // Correcting or reopening the result is the staff-side remedy; the board must
  // not invent one.
  assert.deepEqual(after.event.roundOneHeats[0].roster.map((entry) => entry.place), [null, null]);
  assert.ok(after.event.roundOneHeats[0].roster.every((entry) => typeof entry.participantDisplayName === "string"));
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'round'").get().count,
    1,
    "the published result row itself is untouched",
  );

  // Neither participant appears anywhere in the payload.
  assert.equal(/Alpha|Charlie/.test(JSON.stringify(after)), false);

  // The heats themselves still exist and keep their numbers and statuses.
  assert.deepEqual(after.event.roundOneHeats.map((heat) => [heat.number, heat.status]), [[1, "FINALIZED"]]);
  assert.deepEqual(after.event.finalHeats.map((heat) => [heat.number, heat.status]), [[1, "FINALIZED"]]);

  // Not one stored row moved: the exclusion is a projection rule only.
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, slot_number FROM heat_entries ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "final-1", heat_id: "final", slot_number: 1 },
      { id: "final-2", heat_id: "final", slot_number: 2 },
      { id: "final-3", heat_id: "final", slot_number: 3 },
      { id: "final-4", heat_id: "final", slot_number: 4 },
      { id: "round-1", heat_id: "round", slot_number: 1 },
      { id: "round-2", heat_id: "round", slot_number: 2 },
      { id: "round-3", heat_id: "round", slot_number: 3 },
      { id: "round-4", heat_id: "round", slot_number: 4 },
    ],
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL").get().count,
    4,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// A heat every one of whose racers has left is still a heat. It keeps its
// number and status on the board with an empty roster rather than disappearing,
// because the bags for that heat physically still exist.
test("a heat whose whole roster withdrew is still published, with no entries", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status, public_name_policy)
    VALUES ('event', 'empty-heat', 'Empty Heat', 'UTC', 'ROUND_ONE', 'FIRST_NAME_ONLY');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Solo', 'Duck', 'WITHDRAWN', 'EMPTY001', 'hash',
            '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry', 'event', 'registration');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat', 'event', 'ROUND_ONE', 1, 'PLANNED', 3);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry', 'event', 'heat', 'entry', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z');
    UPDATE heats SET status = 'CALLING' WHERE id = 'heat';
  `);

  const board = await responseBoard(database);
  assert.deepEqual(board.event.roundOneHeats.map((heat) => [heat.number, heat.status]), [[1, "CALLING"]]);
  assert.deepEqual(board.event.roundOneHeats[0].roster, []);
  assert.deepEqual(board.event.currentHeat, { round: "ROUND_ONE", number: 1, status: "CALLING" });
  assert.equal(JSON.stringify(board).includes("Solo"), false);
});

test("public board is usable when no current event exists", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  assert.deepEqual(await responseBoard(database), { event: null });
});

test("public board does not revive a closed pre-race duck assignment", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('staff', 'staff-sub', 'operator@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'pre-race', 'Pre-Race', 'UTC', 'REGISTRATION_CLOSED');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Daisy', 'Duck', 'SUBMITTED', 'DAISY123', 'hash',
            '2026-07-26T00:00:00Z', '2026-07-26T00:05:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry', 'event', 'registration');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck', 17, 'RESERVED_FOR_EVENT', '2026-07-26T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck', 'event', 'duck', '2026-07-26T00:00:00Z', 'staff');
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('assign', 'event', 'ASSIGN_DUCK', 'assignment', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from, valid_to,
       end_reason, source_command_id)
    VALUES ('assignment', 'event', 'entry', 'event-duck', 'duck', '2026-07-26T00:00:00Z',
            '2026-07-26T00:05:00Z', 'PRE_RACE_UNASSIGNMENT', 'assign');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat', 'event', 'ROUND_ONE', 1, 'PLANNED', 1);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry', 'event', 'heat', 'entry', 'ROUND_ONE', 1, 'BALANCED_DRAW', '2026-07-26T00:00:00Z');
  `);

  const board = await responseBoard(database);
  assert.equal(board.event.roundOneHeats[0].roster[0].participantDisplayName, "Daisy D.");
  assert.equal(board.event.roundOneHeats[0].roster[0].duckNumber, null);

  // An entry with no current duck carries no duck name either, even when one is
  // stored: the name only means something next to the duck it belongs to.
  database.prepare("UPDATE race_entries SET duck_name = 'Bubbles' WHERE id = 'entry'").run();
  const unassigned = await responseBoard(database);
  assert.equal(unassigned.event.roundOneHeats[0].roster[0].duckName, null);
  assert.equal(JSON.stringify(unassigned).includes("Bubbles"), false);

  // The stage wording on the public board is driven by this one public field.
  assert.equal(board.event.status, "REGISTRATION_CLOSED");
  assert.deepEqual(Object.keys(board.event).sort(), [
    "currentHeat",
    "eventDate",
    "finalHeats",
    "name",
    "podium",
    "roundOneHeats",
    "status",
  ]);
});
