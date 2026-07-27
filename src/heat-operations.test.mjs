import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";

// The full ordered chain, so heat behavior is always exercised against the
// schema production actually runs.
const migrationNames = readdirSync(new URL("../db/migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.args) };
  }
}

const d1 = (database) => ({
  beforeBatch: null,
  prepare(sql) {
    return new D1Statement(database, sql);
  },
  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook(statements);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = database.prepare(statement.sql).run(...statement.args);
        return { success: true, meta: { changes: Number(result.changes) } };
      });
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
};

const actor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Race Director",
  isSystemAdmin: false,
  roles: ["RACE_DIRECTOR"],
  authentication: "bearer",
};

const seedRace = (database) => {
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name)
    VALUES ('staff', 'staff-sub', 'staff@example.com', 'Race Director');
    INSERT INTO events
      (id, slug, name, timezone, status, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity)
    VALUES
      ('event', 'race-day', 'Race Day', 'America/Denver', 'REGISTRATION_CLOSED',
       'POST_CLOSE_BALANCED', 2, 10);
  `);
  const registration = database.prepare(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code,
       private_token_hash, submitted_at, status_changed_at)
    VALUES (?, 'event', ?, ?, 'ACTIVE', ?, ?, '2026-07-26T10:00:00Z', '2026-07-26T10:00:00Z')
  `);
  const raceEntry = database.prepare(
    "INSERT INTO race_entries (id, event_id, registration_id) VALUES (?, 'event', ?)",
  );
  const duck = database.prepare(`
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES (?, ?, 'IN_USE', '2026-07-26T10:00:00Z')
  `);
  const eventDuck = database.prepare(`
    INSERT INTO event_ducks
      (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES (?, 'event', ?, '2026-07-26T10:00:00Z', 'staff')
  `);
  const command = database.prepare(`
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES (?, 'event', 'ASSIGN_DUCK', ?, '2026-07-26T10:00:00Z', '2026-07-26T10:00:00Z', 'staff')
  `);
  const assignment = database.prepare(`
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES (?, 'event', ?, ?, ?, '2026-07-26T10:00:00Z', 'staff', ?)
  `);

  const firstNames = ["Daisy", "Donald", "Della", "Dewey"];
  for (let index = 1; index <= firstNames.length; index += 1) {
    const registrationId = `registration-${index}`;
    const entryId = `entry-${index}`;
    const duckId = `duck-${index}`;
    const eventDuckId = `event-duck-${index}`;
    const commandId = `assignment-command-${index}`;
    const assignmentId = `assignment-${index}`;
    registration.run(
      registrationId,
      firstNames[index - 1],
      "Duck",
      `CODE000${index}`,
      `private-hash-${index}`,
    );
    raceEntry.run(entryId, registrationId);
    duck.run(duckId, index);
    eventDuck.run(eventDuckId, duckId);
    command.run(commandId, assignmentId);
    assignment.run(assignmentId, entryId, eventDuckId, duckId, commandId);
  }
};

const jsonRequest = (path, method, body) => new Request(`https://quickducks.com${path}`, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const commandId = () => crypto.randomUUID();

test("heat operations cover balanced planning, lifecycle, results, corrections, and verification", async () => {
  const database = createDatabase();
  seedRace(database);
  const env = { DB: d1(database) };
  const handle = (request) => handleHeatOperations(request, env, actor);
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  assert.equal(
    await handle(new Request("https://quickducks.com/api/v1/staff/events/event/not-heat-operations")),
    null,
  );

  const preview = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/round-one/plan-preview",
    "POST",
    {},
  ));
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.balanced, true);
  assert.deepEqual(previewBody.heats.map((heat) => heat.size), [2, 2]);

  const planCommand = commandId();
  const commitBody = { commandId: planCommand, fingerprint: previewBody.fingerprint };
  const commit = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/round-one/plan-commit",
    "POST",
    commitBody,
  ));
  assert.equal(commit.status, 201);
  assert.equal((await commit.json()).committed, true);
  const commitReplay = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/round-one/plan-commit",
    "POST",
    commitBody,
  ));
  assert.equal(commitReplay.status, 200);
  assert.equal((await commitReplay.json()).replayed, true);

  const listed = await handle(new Request("https://quickducks.com/api/v1/staff/events/event/heats"));
  assert.equal(listed.status, 200);
  const roundHeats = (await listed.json()).heats.filter((heat) => heat.round === "ROUND_ONE");
  assert.equal(roundHeats.length, 2);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "REGISTRATION_CLOSED");
  const startRoundOne = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-round-one",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(startRoundOne.status, 201, JSON.stringify(await startRoundOne.clone().json()));

  const firstHeatId = roundHeats[0].id;
  const firstDetail = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${firstHeatId}`,
  ));
  const firstRoster = (await firstDetail.json()).roster;
  const reversedRoster = firstRoster.map((entry) => entry.raceEntryId).reverse();
  const rosterEdit = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/roster`,
    "PUT",
    { commandId: commandId(), revision: 0, raceEntryIds: reversedRoster },
  ));
  assert.equal(rosterEdit.status, 200);
  assert.equal((await rosterEdit.json()).heat.revision, 1);

  const transition = async (heatId, operation, revision, expectedStatus) => {
    const response = await handle(jsonRequest(
      `/api/v1/staff/events/event/heats/${heatId}/${operation}`,
      "POST",
      { commandId: commandId(), revision },
    ));
    const body = await response.json();
    assert.equal(response.status, 201, `${operation}: ${JSON.stringify(body)}`);
    assert.equal(body.heat.status, expectedStatus);
    return body.heat.revision;
  };

  let firstRevision = await transition(firstHeatId, "lock", 1, "LOADING");
  const lockedEdit = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/roster`,
    "PUT",
    { commandId: commandId(), revision: firstRevision, raceEntryIds: reversedRoster },
  ));
  assert.equal(lockedEdit.status, 409);
  firstRevision = await transition(firstHeatId, "ready", firstRevision, "READY");
  firstRevision = await transition(firstHeatId, "call", firstRevision, "CALLING");
  firstRevision = await transition(firstHeatId, "start", firstRevision, "RUNNING");

  const secondHeatId = roundHeats[1].id;
  let secondRevision = await transition(secondHeatId, "lock", 0, "LOADING");
  secondRevision = await transition(secondHeatId, "ready", secondRevision, "READY");
  secondRevision = await transition(secondHeatId, "call", secondRevision, "CALLING");
  const blockedStart = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${secondHeatId}/start`,
    "POST",
    { commandId: commandId(), revision: secondRevision },
  ));
  assert.equal(blockedStart.status, 409);

  firstRevision = await transition(firstHeatId, "finish", firstRevision, "AWAITING_RESULT");
  const awaitingResultStart = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${secondHeatId}/start`,
    "POST",
    { commandId: commandId(), revision: secondRevision },
  ));
  assert.equal(awaitingResultStart.status, 409);
  assert.match((await awaitingResultStart.json()).error, /Publish the official result/i);

  const announcer = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${firstHeatId}/announcer-roster`,
  ));
  const announcerBody = await announcer.json();
  assert.equal(announcerBody.roster.length, 2);
  assert.equal(JSON.stringify(announcerBody).includes("email"), false);

  const finalize = async (heatId, revision, winnerId) => {
    const id = commandId();
    const body = { commandId: id, revision, results: [{ raceEntryId: winnerId, place: 1 }] };
    const response = await handle(jsonRequest(
      `/api/v1/staff/events/event/heats/${heatId}/results/finalize`,
      "POST",
      body,
    ));
    const responseBody = await response.json();
    assert.equal(response.status, 201, JSON.stringify(responseBody));
    const replay = await handle(jsonRequest(
      `/api/v1/staff/events/event/heats/${heatId}/results/finalize`,
      "POST",
      body,
    ));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    return responseBody.heat.revision;
  };

  const rosters = [];
  for (const heat of roundHeats) {
    const detail = await handle(new Request(
      `https://quickducks.com/api/v1/staff/events/event/heats/${heat.id}`,
    ));
    rosters.push((await detail.json()).roster.map((entry) => entry.raceEntryId));
  }
  firstRevision = await finalize(firstHeatId, firstRevision, rosters[0][0]);

  env.DB.beforeBatch = () => {
    database.exec(`UPDATE heats SET status = 'AWAITING_RESULT' WHERE id = '${firstHeatId}'`);
  };
  const atomicBlockedStart = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${secondHeatId}/start`,
    "POST",
    { commandId: commandId(), revision: secondRevision },
  ));
  assert.equal(atomicBlockedStart.status, 409);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = ?").get(secondHeatId).status, "CALLING");
  database.prepare("UPDATE heats SET status = 'FINALIZED' WHERE id = ?").run(firstHeatId);

  secondRevision = await transition(secondHeatId, "start", secondRevision, "RUNNING");
  secondRevision = await transition(secondHeatId, "finish", secondRevision, "AWAITING_RESULT");

  const correction = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/results/correct`,
    "POST",
    {
      commandId: commandId(),
      revision: firstRevision,
      reason: "Finish judge confirmed the other duck.",
      results: [{ raceEntryId: rosters[0][1], place: 1 }],
    },
  ));
  assert.equal(correction.status, 201);
  firstRevision = (await correction.json()).heat.revision;

  secondRevision = await finalize(secondHeatId, secondRevision, rosters[1][0]);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "ROUND_ONE");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heats WHERE event_id = 'event' AND round = 'FINAL'").get().count, 1);

  const finalistResponse = await handle(new Request("https://quickducks.com/api/v1/staff/events/event/finalists"));
  const finalistBody = await finalistResponse.json();
  assert.equal(finalistBody.verification.verified, true);
  assert.equal(finalistBody.finalists.length, 2);
  assert.equal(finalistBody.finalists[0].raceEntryId, rosters[0][1]);
  const verification = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/finalists/verification",
  ));
  assert.equal((await verification.json()).verification.verified, true);

  const startFinal = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-final",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(startFinal.status, 201, JSON.stringify(await startFinal.clone().json()));

  const finalHeat = database.prepare(
    "SELECT id, revision FROM heats WHERE event_id = 'event' AND round = 'FINAL'",
  ).get();
  let finalRevision = await transition(finalHeat.id, "lock", finalHeat.revision, "LOADING");

  const dependentReopen = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/results/reopen`,
    "POST",
    { commandId: commandId(), revision: firstRevision, reason: "Review requested by finish judge." },
  ));
  assert.equal(dependentReopen.status, 409);

  finalRevision = await transition(finalHeat.id, "ready", finalRevision, "READY");
  finalRevision = await transition(finalHeat.id, "call", finalRevision, "CALLING");
  finalRevision = await transition(finalHeat.id, "start", finalRevision, "RUNNING");
  finalRevision = await transition(finalHeat.id, "finish", finalRevision, "AWAITING_RESULT");

  const finalistIds = finalistBody.finalists.map((entry) => entry.raceEntryId);
  const podium = finalistIds.map((raceEntryId, index) => ({ raceEntryId, place: index + 1 }));
  const finalResult = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${finalHeat.id}/results/finalize`,
    "POST",
    { commandId: commandId(), revision: finalRevision, results: podium },
  ));
  assert.equal(finalResult.status, 201);
  finalRevision = (await finalResult.json()).heat.revision;
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "FINAL");
  const complete = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/complete",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(complete.status, 201, JSON.stringify(await complete.clone().json()));

  const correctedPodium = [
    { raceEntryId: finalistIds[1], place: 1 },
    { raceEntryId: finalistIds[0], place: 2 },
  ];
  const finalCorrection = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${finalHeat.id}/results/correct`,
    "POST",
    {
      commandId: commandId(),
      revision: finalRevision,
      reason: "Photo review changed the first two places.",
      results: correctedPodium,
    },
  ));
  assert.equal(finalCorrection.status, 201);
  finalRevision = (await finalCorrection.json()).heat.revision;
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = ? AND status = 'SUPERSEDED'").get(finalHeat.id).count,
    2,
  );

  const reopen = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${finalHeat.id}/results/reopen`,
    "POST",
    { commandId: commandId(), revision: finalRevision, reason: "Podium requires one more video review." },
  ));
  assert.equal(reopen.status, 201);
  finalRevision = (await reopen.json()).heat.revision;
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "FINAL");

  const detailAfterReopen = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${finalHeat.id}`,
  ));
  assert.deepEqual((await detailAfterReopen.json()).results, []);

  const draftEntry = database.prepare(`
    SELECT he.race_entry_id, da.id AS assignment_id
      FROM heat_entries he
      JOIN duck_assignments da ON da.race_entry_id = he.race_entry_id AND da.valid_to IS NULL
     WHERE he.heat_id = ? ORDER BY he.slot_number LIMIT 1
  `).get(finalHeat.id);
  assert.throws(() => database.prepare(`
      INSERT INTO heat_results
        (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status,
         revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
      VALUES ('draft-result', 'event', ?, ?, ?, 1, 'DRAFT', 99,
              '2026-07-26T12:00:00Z', 'staff', ?)
    `).run(finalHeat.id, draftEntry.race_entry_id, draftEntry.assignment_id, planCommand), /CHECK constraint failed/);

  const refinalize = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${finalHeat.id}/results/finalize`,
    "POST",
    { commandId: commandId(), revision: finalRevision, results: correctedPodium },
  ));
  assert.equal(refinalize.status, 201);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "FINAL");
  const recomplete = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/complete",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(recomplete.status, 201, JSON.stringify(await recomplete.clone().json()));

  const malicious = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/'%20OR%201=1--/heats",
  ));
  assert.equal(malicious.status, 404);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE details_json LIKE '%reason%'").get().count >= 3, true);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  // Locked rosters are deletable only under the force delete sentinel.
  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('force-delete-sentinel', 'event', 'FORCE_DELETE_EVENT',
            '2026-07-26T09:00:00Z', '2026-07-26T09:00:00Z');
  `);
  database.exec("DELETE FROM heat_results WHERE event_id = 'event'");
  database.exec("DELETE FROM heat_entries WHERE event_id = 'event'");
  database.exec("DELETE FROM heats WHERE event_id = 'event'");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_result_history").get().count, 0);
  database.close();
});

test("heat lock, finish scan, validation, and atomic finalization require ACTIVE registrations", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-active', 'event', 'ROUND_ONE', 1, 'PLANNED', 1);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-active', 'event', 'heat-active', 'entry-1', 'ROUND_ONE', 1,
            'BALANCED_DRAW', '2026-07-26T11:00:00Z');
  `);
  const DB = d1(database);
  const env = { APP_ORIGIN: "https://quickducks.com", DB };
  const handle = (request) => handleHeatOperations(request, env, actor);

  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1'");
  const inactiveLock = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/lock",
    "POST",
    { commandId: commandId(), revision: 0 },
  ));
  assert.equal(inactiveLock.status, 409);
  assert.match((await inactiveLock.json()).error, /Update this planned, unlocked roster/i);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-active'").get().status, "PLANNED");

  database.exec("UPDATE registrations SET status = 'ACTIVE' WHERE id = 'registration-1'");
  DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-1'");
  };
  const atomicLock = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/lock",
    "POST",
    { commandId: commandId(), revision: 0 },
  ));
  assert.equal(atomicLock.status, 409);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-active'").get().status, "PLANNED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'LOCK_HEAT'").get().count, 0);

  database.exec(`
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
    UPDATE heats
       SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T11:05:00Z',
           finished_at = '2026-07-26T11:10:00Z', revision = 4
     WHERE id = 'heat-active';
  `);
  const inactiveScan = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-active/finish-scan?value=1",
  ));
  assert.equal(inactiveScan.status, 422);
  assert.match((await inactiveScan.json()).error, /no longer active.*race director/i);

  const inactiveResult = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/results/finalize",
    "POST",
    { commandId: commandId(), revision: 4, results: [{ raceEntryId: "entry-1", place: 1 }] },
  ));
  assert.equal(inactiveResult.status, 422);
  assert.match((await inactiveResult.json()).error, /must still be ACTIVE.*Refresh the heat/i);

  database.exec("UPDATE registrations SET status = 'ACTIVE' WHERE id = 'registration-1'");
  DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1'");
  };
  const racedFinalization = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/results/finalize",
    "POST",
    { commandId: commandId(), revision: 4, results: [{ raceEntryId: "entry-1", place: 1 }] },
  ));
  assert.equal(racedFinalization.status, 409);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-active'").get().status, "AWAITING_RESULT");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'heat-active'").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'FINALIZE_HEAT_RESULT'").get().count, 0);
});

test("heat station rosters retain unassigned and withdrawn entries without exposing closed duck assignments", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-roster', 'event', 'ROUND_ONE', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('heat-entry-1', 'event', 'heat-roster', 'entry-1', 'ROUND_ONE', 1,
       'BALANCED_DRAW', '2026-07-26T11:00:00Z'),
      ('heat-entry-2', 'event', 'heat-roster', 'entry-2', 'ROUND_ONE', 2,
       'BALANCED_DRAW', '2026-07-26T11:00:00Z');
    UPDATE duck_assignments
       SET valid_to = '2026-07-26T11:05:00Z', end_reason = 'UNASSIGNED'
     WHERE race_entry_id IN ('entry-1', 'entry-2');
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2';
  `);
  const handle = (request) => handleHeatOperations(request, { DB: d1(database) }, actor);

  const detail = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-roster",
  ));
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.heat.rosterSize, 2);
  assert.deepEqual(detailBody.roster.map((entry) => ({
    raceEntryId: entry.raceEntryId,
    registrationStatus: entry.participant.registrationStatus,
    duck: entry.duck,
  })), [
    { raceEntryId: "entry-1", registrationStatus: "ACTIVE", duck: null },
    { raceEntryId: "entry-2", registrationStatus: "WITHDRAWN", duck: null },
  ]);

  const announcer = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-roster/announcer-roster",
  ));
  assert.equal(announcer.status, 200);
  assert.deepEqual((await announcer.json()).roster.map((entry) => entry.duckNumber), [null, null]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE heat_id = 'heat-roster'").get().count, 2);
});

// The staff console links a roster entry back to the participant and the duck,
// so the detail projection has to name the identifiers those two sections
// select on. They are internal identifiers, never participant contact data.
test("heat roster entries carry the registration and duck identifiers the console selects on", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-links', 'event', 'ROUND_ONE', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('link-entry-1', 'event', 'heat-links', 'entry-1', 'ROUND_ONE', 1,
       'BALANCED_DRAW', '2026-07-26T11:00:00Z'),
      ('link-entry-2', 'event', 'heat-links', 'entry-2', 'ROUND_ONE', 2,
       'BALANCED_DRAW', '2026-07-26T11:00:00Z');
    UPDATE duck_assignments
       SET valid_to = '2026-07-26T11:05:00Z', end_reason = 'UNASSIGNED'
     WHERE race_entry_id = 'entry-2';
  `);

  const detail = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-links"),
    { DB: d1(database) },
    actor,
  );
  assert.equal(detail.status, 200);
  const body = await detail.json();

  assert.deepEqual(body.roster.map((entry) => ({
    raceEntryId: entry.raceEntryId,
    registrationId: entry.participant.registrationId,
    duck: entry.duck,
  })), [
    { raceEntryId: "entry-1", registrationId: "registration-1", duck: { id: "duck-1", visibleNumber: 1 } },
    // An unassigned entry exposes no duck at all, so no duck link can be built.
    { raceEntryId: "entry-2", registrationId: "registration-2", duck: null },
  ]);
  // The existing projection is unchanged around the new fields.
  assert.equal(body.roster[0].participant.firstName, "Daisy");
  assert.equal(body.roster[0].participant.registrationStatus, "ACTIVE");
  assert.equal(JSON.stringify(body).includes("email"), false);
});

test("balanced preview and commit reject plans with more heats than final capacity", async () => {
  const database = createDatabase();
  seedRace(database);
  database.exec("UPDATE events SET final_heat_capacity = 1 WHERE id = 'event'");
  const handle = (request) => handleHeatOperations(request, { DB: d1(database) }, actor);

  const preview = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/round-one/plan-preview",
    "POST",
    {},
  ));
  assert.equal(preview.status, 409);
  assert.match((await preview.json()).error, /requires 2 heats.*final capacity of 1/i);

  const commit = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/round-one/plan-commit",
    "POST",
    { commandId: commandId(), fingerprint: "stale-preview" },
  ));
  assert.equal(commit.status, 409);
  assert.match((await commit.json()).error, /requires 2 heats.*final capacity of 1/i);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heats").get().count, 0);
  database.close();
});
