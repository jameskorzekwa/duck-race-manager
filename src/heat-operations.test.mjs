import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { staffHomeScript } from "./client-scripts.ts";
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
       'IMMEDIATE_FIXED', 3, 10);
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

  // Six racers fill two heats of three, the smallest layout a race can run.
  const firstNames = ["Daisy", "Donald", "Della", "Dewey", "Huey", "Louie"];
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

// Heats are built as participants are paired, so a closed event already has
// its round-one heats. This mirrors exactly what the pairing route writes.
const seedRoundOneHeats = (database) => {
  database.exec(`
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-1', 'event', 'ROUND_ONE', 1, 'PLANNED', 3),
           ('heat-2', 'event', 'ROUND_ONE', 2, 'PLANNED', 3);
  `);
  const entry = database.prepare(`
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES (?, 'event', ?, ?, 'ROUND_ONE', ?, 'PAIRING', '2026-07-26T10:30:00Z')
  `);
  for (let index = 1; index <= 6; index += 1) {
    const heatId = index <= 3 ? "heat-1" : "heat-2";
    const slot = index <= 3 ? index : index - 3;
    entry.run(`heat-entry-${index}`, heatId, `entry-${index}`, slot);
  }
};

const jsonRequest = (path, method, body) => new Request(`https://quickducks.com${path}`, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const commandId = () => crypto.randomUUID();

test("heat operations cover the paired-heat lifecycle, results, corrections, and verification", async () => {
  const database = createDatabase();
  seedRace(database);
  seedRoundOneHeats(database);
  const env = { DB: d1(database) };
  const handle = (request) => handleHeatOperations(request, env, actor);
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  assert.equal(
    await handle(new Request("https://quickducks.com/api/v1/staff/events/event/not-heat-operations")),
    null,
  );

  // The retired post-close balanced planner has no routes left at all.
  for (const path of ["plan-preview", "plan-commit"]) {
    assert.equal(
      await handle(jsonRequest(`/api/v1/staff/events/event/heats/round-one/${path}`, "POST", {})),
      null,
      `${path} must no longer be routed`,
    );
  }

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

  // Starting the round locked every roster, so no operator lock step remains
  // and the heats are already LOADING.
  const firstHeatId = roundHeats[0].id;
  const firstDetail = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${firstHeatId}`,
  ));
  const firstDetailBody = await firstDetail.json();
  assert.equal(firstDetailBody.heat.status, "LOADING");
  assert.equal(firstDetailBody.heat.rosterLocked, true);
  const reversedRoster = firstDetailBody.roster.map((entry) => entry.raceEntryId).reverse();
  const lockedEdit = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/roster`,
    "PUT",
    { commandId: commandId(), revision: firstDetailBody.heat.revision, raceEntryIds: reversedRoster },
  ));
  assert.equal(lockedEdit.status, 409);
  assert.match((await lockedEdit.json()).error, /only before it is locked/i);

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

  let firstRevision = await transition(firstHeatId, "ready", firstDetailBody.heat.revision, "READY");
  firstRevision = await transition(firstHeatId, "call", firstRevision, "CALLING");
  firstRevision = await transition(firstHeatId, "start", firstRevision, "RUNNING");

  const secondHeatId = roundHeats[1].id;
  let secondRevision = await transition(secondHeatId, "ready", roundHeats[1].revision + 1, "READY");
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
  // The endpoint stays available for the announcer surface even though the
  // console no-op button that refetched it is gone.
  assert.equal(announcer.status, 200);
  assert.equal(announcerBody.roster.length, 3);
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

  // Starting the final locked its roster too, so it is already LOADING.
  const finalHeat = database.prepare(
    "SELECT id, revision, status, roster_locked_at FROM heats WHERE event_id = 'event' AND round = 'FINAL'",
  ).get();
  assert.equal(finalHeat.status, "LOADING");
  assert.notEqual(finalHeat.roster_locked_at, null);
  let finalRevision = finalHeat.revision;

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
    `).run(finalHeat.id, draftEntry.race_entry_id, draftEntry.assignment_id, 'assignment-command-1'), /CHECK constraint failed/);

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

test("the retired balanced round-one planner is unroutable and writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  const handle = (request) => handleHeatOperations(request, { DB: d1(database) }, actor);

  // `null` means no handler claimed the path, which is how the shared staff
  // router falls through to its 404. The routes are gone, not merely disabled.
  for (const path of [
    "/api/v1/staff/events/event/heats/round-one/plan-preview",
    "/api/v1/staff/events/event/heats/round-one/plan-commit",
  ]) {
    assert.equal(await handle(jsonRequest(path, "POST", { commandId: commandId() })), null, path);
    assert.equal(await handle(new Request(`https://quickducks.com${path}`)), null, `GET ${path}`);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heats").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type LIKE '%PLAN%'").get().count, 0);
});

// ---------------------------------------------------------------------------
// The roster replacement window
// ---------------------------------------------------------------------------
//
// Starting a round locks every planned heat of that round in the same batch as
// the status change, so "PLANNED and unlocked" and "the round is running" are
// mutually exclusive. The editable window is therefore the window before the
// round starts, and these cases pin it from both ends: which lifecycle statuses
// the API accepts, and that the console offers the form for exactly those.

const LIFECYCLE_STATUSES = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "ROUND_ONE",
  "FINAL",
  "COMPLETED",
];

// A final heat holding the two round-one winners, so a FINAL roster replacement
// reaches the same guard a round-one one does instead of failing eligibility.
const seedFinalHeat = (database) => {
  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('result-command', 'event', 'FINALIZE_HEAT_RESULT', 'heat-1',
            '2026-07-26T11:00:00Z', '2026-07-26T11:00:00Z');
    UPDATE heats SET status = 'FINALIZED', finalized_at = '2026-07-26T11:00:00Z',
           roster_locked_at = '2026-07-26T10:45:00Z'
     WHERE id IN ('heat-1', 'heat-2');
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES
      ('result-1', 'event', 'heat-1', 'entry-1', 'assignment-1', 1, 'FINALIZED', 1,
       '2026-07-26T11:00:00Z', 'staff', 'result-command'),
      ('result-2', 'event', 'heat-2', 'entry-4', 'assignment-4', 1, 'FINALIZED', 1,
       '2026-07-26T11:00:00Z', 'staff', 'result-command');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-final', 'event', 'FINAL', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('final-entry-1', 'event', 'heat-final', 'entry-1', 'FINAL', 1,
       'WINNER_PROMOTION', '2026-07-26T11:05:00Z'),
      ('final-entry-2', 'event', 'heat-final', 'entry-4', 'FINAL', 2,
       'WINNER_PROMOTION', '2026-07-26T11:05:00Z');
  `);
};

const rosterAttempt = async (round, eventStatus) => {
  const database = createDatabase();
  seedRace(database);
  seedRoundOneHeats(database);
  if (round === "FINAL") seedFinalHeat(database);
  database.exec(`UPDATE events SET status = '${eventStatus}' WHERE id = 'event'`);
  const heatId = round === "FINAL" ? "heat-final" : "heat-2";
  const raceEntryIds = round === "FINAL" ? ["entry-4", "entry-1"] : ["entry-5", "entry-4"];
  const response = await handleHeatOperations(
    jsonRequest(`/api/v1/staff/events/event/heats/${heatId}/roster`, "PUT", {
      commandId: commandId(),
      revision: 0,
      raceEntryIds,
    }),
    { DB: d1(database) },
    actor,
  );
  const body = await response.json();
  const stored = database.prepare(
    "SELECT race_entry_id FROM heat_entries WHERE heat_id = ? ORDER BY slot_number",
  ).all(heatId).map((row) => row.race_entry_id);
  const commands = database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'REPLACE_HEAT_ROSTER'",
  ).get().count;
  database.close();
  return { status: response.status, body, stored, commands, raceEntryIds };
};

test("a round-one roster is replaceable only while registration is closed", async () => {
  const accepted = [];
  for (const status of LIFECYCLE_STATUSES) {
    const attempt = await rosterAttempt("ROUND_ONE", status);
    if (attempt.status === 200) {
      accepted.push(status);
      // The write actually happened, in the submitted slot order.
      assert.deepEqual(attempt.stored, attempt.raceEntryIds, status);
      assert.deepEqual(attempt.body.roster.map((entry) => entry.raceEntryId), attempt.raceEntryIds);
      assert.equal(attempt.body.replayed, false);
      assert.equal(attempt.commands, 1);
      continue;
    }
    assert.equal(attempt.status, 409, status);
    assert.match(attempt.body.error, /round-one roster can be replaced only while registration is closed/i);
    // A refusal writes nothing at all, rather than deleting the roster first.
    assert.deepEqual(attempt.stored, ["entry-4", "entry-5", "entry-6"], status);
    assert.equal(attempt.commands, 0, status);
  }
  assert.deepEqual(accepted, ["REGISTRATION_CLOSED"]);
});

test("a final roster is replaceable only while round one is running", async () => {
  const accepted = [];
  for (const status of LIFECYCLE_STATUSES) {
    const attempt = await rosterAttempt("FINAL", status);
    if (attempt.status === 200) {
      accepted.push(status);
      assert.deepEqual(attempt.stored, attempt.raceEntryIds, status);
      assert.equal(attempt.commands, 1);
      continue;
    }
    assert.equal(attempt.status, 409, status);
    assert.match(attempt.body.error, /final roster can be replaced only during round one/i);
    assert.deepEqual(attempt.stored, ["entry-1", "entry-4"], status);
    assert.equal(attempt.commands, 0, status);
  }
  assert.deepEqual(accepted, ["ROUND_ONE"]);
});

test("a roster replacement whose command row loses its guard writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  const DB = d1(database);
  const env = { DB };

  // The event leaves the editable window between the preflight and the batch,
  // so the guarded command insert matches nothing. The delete and the roster
  // update carry the same sentinel, so the whole replacement is a no-op instead
  // of emptying the heat and relying on a later foreign key to notice.
  DB.beforeBatch = () => {
    database.exec("UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event'");
  };
  const response = await handleHeatOperations(
    jsonRequest("/api/v1/staff/events/event/heats/heat-2/roster", "PUT", {
      commandId: commandId(),
      revision: 0,
      raceEntryIds: ["entry-5", "entry-4"],
    }),
    env,
    actor,
  );
  assert.equal(response.status, 409);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'REPLACE_HEAT_ROSTER'").get().count,
    0,
  );
  assert.deepEqual(
    database.prepare("SELECT race_entry_id FROM heat_entries WHERE heat_id = 'heat-2' ORDER BY slot_number").all()
      .map((row) => row.race_entry_id),
    ["entry-4", "entry-5", "entry-6"],
    "the roster is untouched",
  );
  assert.equal(database.prepare("SELECT target_size FROM heats WHERE id = 'heat-2'").get().target_size, 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The console renders the replacement form from its own copy of the lifecycle
// state, so it can drift from the API and 409 every submission with a
// misleading message. This runs the shipped console gate against the real API
// answer for every lifecycle status and requires them to be identical.
test("the console offers the roster form for exactly the states the API accepts", async () => {
  const lifted = [
    /const rosterEditableEventStatus = \{[^}]*\};/,
    /const rosterFormAllowed = \(heat, event\) => [\s\S]*?;\n/,
    /const addRosterForm = \(body\) => \{[\s\S]*?\n\};/,
  ].map((pattern) => {
    const match = staffHomeScript.match(pattern);
    assert.ok(match, `the console script defines ${pattern}`);
    return match[0];
  }).join("\n");

  const node = () => ({
    children: [],
    dataset: {},
    append(...items) {
      this.children.push(...items);
    },
    addEventListener() {},
  });
  const offersForm = (round, eventStatus) => {
    const heatControls = node();
    const addRosterForm = new Function(
      "canDirectRace",
      "currentEvent",
      "text",
      "document",
      "heatControls",
      `${lifted}\nreturn addRosterForm;`,
    )(
      true,
      { id: "event", status: eventStatus },
      () => node(),
      { createElement: () => node() },
      heatControls,
    );
    addRosterForm({
      heat: { round, status: "PLANNED", rosterLocked: false, revision: 0 },
      roster: [{ raceEntryId: "entry-4" }],
    });
    return heatControls.children.length > 0;
  };

  for (const round of ["ROUND_ONE", "FINAL"]) {
    for (const status of LIFECYCLE_STATUSES) {
      const attempt = await rosterAttempt(round, status);
      assert.equal(
        offersForm(round, status),
        attempt.status === 200,
        `console and API disagree for a ${round} heat in ${status}`,
      );
    }
  }

  // A locked or already advanced heat is never offered either, matching the
  // refusal the API returns before it even looks at the event.
  assert.equal(offersForm("ROUND_ONE", "REGISTRATION_CLOSED"), true);
  const lockedControls = node();
  new Function(
    "canDirectRace",
    "currentEvent",
    "text",
    "document",
    "heatControls",
    `${lifted}\nreturn addRosterForm;`,
  )(true, { status: "REGISTRATION_CLOSED" }, () => node(), { createElement: () => node() }, lockedControls)({
    heat: { round: "ROUND_ONE", status: "PLANNED", rosterLocked: true, revision: 0 },
    roster: [],
  });
  assert.equal(lockedControls.children.length, 0);
});

// Starting the final locks its roster the same way starting round one does, so
// it carries the same refusal: a finalist who withdrew is never locked in or
// announced, and the reachable remedy is the final's own roster editor.
test("a withdrawn finalist blocks the final until the final roster is replaced", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
  `);
  const env = { DB: d1(database) };
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  const readiness = await handleEvent(new Request(
    "https://quickducks.com/api/v1/staff/events/event/readiness",
  ));
  const gate = (await readiness.json()).readiness["start-final"];
  assert.equal(gate.allowed, false);
  assert.deepEqual(gate.blockers, [
    "A heat in the final still has a withdrawn or disqualified racer on the roster. "
    + "Replace that roster before starting, so no inactive racer is locked in or announced.",
  ]);

  const blocked = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-final",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(blocked.status, 409);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "ROUND_ONE");
  const finalHeat = database.prepare("SELECT status, roster_locked_at, revision FROM heats WHERE id = 'heat-final'").get();
  assert.equal(finalHeat.status, "PLANNED");
  assert.equal(finalHeat.roster_locked_at, null);

  const replaced = await handleHeatOperations(
    jsonRequest("/api/v1/staff/events/event/heats/heat-final/roster", "PUT", {
      commandId: commandId(),
      revision: finalHeat.revision,
      raceEntryIds: ["entry-4"],
    }),
    env,
    actor,
  );
  assert.equal(replaced.status, 200, JSON.stringify(await replaced.clone().json()));

  const started = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-final",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  const locked = database.prepare("SELECT status, roster_locked_at FROM heats WHERE id = 'heat-final'").get();
  assert.equal(locked.status, "LOADING");
  assert.notEqual(locked.roster_locked_at, null);
  assert.deepEqual(
    database.prepare("SELECT race_entry_id FROM heat_entries WHERE heat_id = 'heat-final'").all()
      .map((row) => row.race_entry_id),
    ["entry-4"],
  );
});

// ---------------------------------------------------------------------------
// The roster projection contract
// ---------------------------------------------------------------------------

// The heat detail is served to ANNOUNCER, HEAT_RUNNER, and RESULT_TAKER, so
// widening it is a privacy decision, not a rendering convenience. This pins the
// exact identifier surface: a later field has to be added here deliberately.
test("the heat roster projection exposes exactly its documented identifier fields", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  const handle = (request) => handleHeatOperations(request, { DB: d1(database) }, actor);

  const detail = await handle(new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-1"));
  assert.equal(detail.status, 200);
  const body = await detail.json();

  assert.deepEqual(Object.keys(body).sort(), ["heat", "results", "roster"]);
  const [entry] = body.roster;
  assert.deepEqual(Object.keys(entry).sort(), [
    "assignmentSource",
    "duck",
    "heatEntryId",
    "participant",
    "raceEntryId",
    "slotNumber",
  ]);
  assert.deepEqual(Object.keys(entry.participant).sort(), [
    "firstName",
    "lastName",
    "registrationId",
    "registrationStatus",
  ]);
  assert.deepEqual(Object.keys(entry.duck).sort(), ["id", "visibleNumber"]);

  // The announcer projection is narrower still and names no internal duck or
  // registration identifier at all.
  const announcer = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/announcer-roster",
  ));
  assert.equal(announcer.status, 200);
  const announcerBody = await announcer.json();
  assert.deepEqual(Object.keys(announcerBody).sort(), ["heat", "roster"]);
  assert.deepEqual(Object.keys(announcerBody.roster[0]).sort(), [
    "displayName",
    "duckNumber",
    "raceEntryId",
    "slotNumber",
  ]);

  // No contact detail, lookup code, private token, or staff note reaches either
  // projection, whatever identifiers they do carry.
  for (const payload of [JSON.stringify(body), JSON.stringify(announcerBody)]) {
    assert.doesNotMatch(payload, /email|phone|lookupCode|CODE000|private|token|notes/i);
  }
});
