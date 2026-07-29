import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";
import { staffHomeScript } from "./client-scripts.ts";
import { handleEventOperations } from "./event-operations.ts";
import {
  FINAL_RESULT_REVISABLE_EVENT_STATUSES,
  FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL,
  FINISH_DUCK_INELIGIBLE_REASON,
  handleHeatOperations,
  winnerByTagCandidate,
  winnerByTagIneligible,
} from "./heat-operations.ts";

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

const startedRoundHarness = async (database) => {
  seedRace(database);
  seedRoundOneHeats(database);
  const DB = d1(database);
  const env = { DB };
  const started = await handleEventOperations(jsonRequest(
    "/api/v1/staff/events/event/start-round-one",
    "POST",
    { commandId: commandId() },
  ), env, actor);
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  return {
    DB,
    env,
    handle: (request) => handleHeatOperations(request, env, actor),
  };
};

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
  assert.equal(finalistBody.finalists.length, 2);
  assert.equal("verification" in finalistBody, false);
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
  const promotedEntryBefore = database.prepare(
    "SELECT id, created_at FROM heat_entries WHERE heat_id = ? AND slot_number = 1",
  ).get(finalHeat.id);

  const loadingCorrectionDetail = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${firstHeatId}`,
  ));
  assert.equal((await loadingCorrectionDetail.json()).heat.resultCorrectionAllowed, true);
  const loadingCorrection = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/results/correct`,
    "POST",
    {
      commandId: commandId(),
      revision: firstRevision,
      reason: "Finish judge corrected the winner before final readiness.",
      results: [{ raceEntryId: rosters[0][2], place: 1 }],
    },
  ));
  assert.equal(loadingCorrection.status, 201, JSON.stringify(await loadingCorrection.clone().json()));
  firstRevision = (await loadingCorrection.json()).heat.revision;
  const refreshedFinalists = await (await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/finalists",
  ))).json();
  assert.equal(refreshedFinalists.finalists[0].raceEntryId, rosters[0][2]);
  const refreshedFinal = await (await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${finalHeat.id}`,
  ))).json();
  assert.equal(refreshedFinal.roster[0].raceEntryId, rosters[0][2]);
  assert.equal(refreshedFinal.heat.revision, finalRevision + 1);
  assert.deepEqual(
    database.prepare("SELECT id, created_at FROM heat_entries WHERE heat_id = ? AND slot_number = 1")
      .get(finalHeat.id),
    promotedEntryBefore,
  );
  finalRevision = refreshedFinal.heat.revision;

  const dependentReopen = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/results/reopen`,
    "POST",
    { commandId: commandId(), revision: firstRevision, reason: "Review requested by finish judge." },
  ));
  assert.equal(dependentReopen.status, 409);

  finalRevision = await transition(finalHeat.id, "ready", finalRevision, "READY");
  const readyCorrectionDetail = await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${firstHeatId}`,
  ));
  assert.equal((await readyCorrectionDetail.json()).heat.resultCorrectionAllowed, false);
  const readyCorrection = await handle(jsonRequest(
    `/api/v1/staff/events/event/heats/${firstHeatId}/results/correct`,
    "POST",
    {
      commandId: commandId(), revision: firstRevision,
      reason: "This correction is too late.",
      results: [{ raceEntryId: rosters[0][0], place: 1 }],
    },
  ));
  assert.equal(readyCorrection.status, 409);
  finalRevision = await transition(finalHeat.id, "call", finalRevision, "CALLING");
  finalRevision = await transition(finalHeat.id, "start", finalRevision, "RUNNING");
  finalRevision = await transition(finalHeat.id, "finish", finalRevision, "AWAITING_RESULT");

  const finalistIds = refreshedFinalists.finalists.map((entry) => entry.raceEntryId);
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
  // Correcting a final result never writes the event's status. Admitting `FINAL`
  // to the correction gate must not let a correction walk a completed event
  // backwards out of `COMPLETED`.
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "COMPLETED");

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

test("a heat reset accepts every post-lock pre-result state and preserves its locked roster", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { handle } = await startedRoundHarness(database);
  const rosterBefore = database.prepare(
    "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-1' ORDER BY slot_number",
  ).all();
  const lockBefore = database.prepare(
    "SELECT roster_locked_at, roster_locked_by_staff_profile_id, round FROM heats WHERE id = 'heat-1'",
  ).get();

  let replayedCommand = null;
  let replayedRevision = null;
  for (const status of ["READY", "CALLING", "RUNNING", "AWAITING_RESULT"]) {
    database.prepare(
      `UPDATE heats
          SET status = ?, started_at = '2026-07-26T11:00:00Z',
              finished_at = '2026-07-26T11:05:00Z', finalized_at = '2026-07-26T11:10:00Z'
        WHERE id = 'heat-1'`,
    ).run(status);
    const revision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-1'").get().revision;
    const resetCommand = commandId();
    const requestBody = { commandId: resetCommand, revision };
    const response = await handle(jsonRequest(
      "/api/v1/staff/events/event/heats/heat-1/reset",
      "POST",
      requestBody,
    ));
    const body = await response.json();
    assert.equal(response.status, 201, `${status}: ${JSON.stringify(body)}`);
    assert.equal(body.replayed, false);
    assert.equal(body.heat.status, "LOADING");
    assert.equal(body.heat.revision, revision + 1);
    assert.equal(body.heat.startedAt, null);
    assert.equal(body.heat.finishedAt, null);
    assert.equal(body.heat.finalizedAt, null);

    const stored = database.prepare(
      `SELECT status, round, revision, roster_locked_at,
              roster_locked_by_staff_profile_id, started_at, finished_at, finalized_at
         FROM heats WHERE id = 'heat-1'`,
    ).get();
    assert.equal(stored.status, "LOADING");
    assert.equal(stored.round, lockBefore.round);
    assert.equal(stored.roster_locked_at, lockBefore.roster_locked_at);
    assert.equal(stored.roster_locked_by_staff_profile_id, lockBefore.roster_locked_by_staff_profile_id);
    assert.equal(stored.started_at, null);
    assert.equal(stored.finished_at, null);
    assert.equal(stored.finalized_at, null);
    assert.deepEqual(
      database.prepare(
        "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-1' ORDER BY slot_number",
      ).all(),
      rosterBefore,
    );
    assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "ROUND_ONE");
    const audit = database.prepare(
      "SELECT action, subject_type, subject_id, details_json FROM audit_events WHERE command_id = ?",
    ).get(resetCommand);
    assert.deepEqual(
      { action: audit.action, subjectType: audit.subject_type, subjectId: audit.subject_id },
      { action: "HEAT_RESET", subjectType: "HEAT", subjectId: "heat-1" },
    );
    assert.deepEqual(JSON.parse(audit.details_json), {
      staff_profile_id: "staff",
      from: status,
      to: "LOADING",
    });

    if (replayedCommand === null) {
      replayedCommand = resetCommand;
      replayedRevision = body.heat.revision;
      const replay = await handle(jsonRequest(
        "/api/v1/staff/events/event/heats/heat-1/reset",
        "POST",
        requestBody,
      ));
      assert.equal(replay.status, 200);
      const replayBody = await replay.json();
      assert.equal(replayBody.replayed, true);
      assert.equal(replayBody.heat.revision, replayedRevision);

      const mismatchedReuse = await handle(jsonRequest(
        "/api/v1/staff/events/event/heats/heat-2/reset",
        "POST",
        { commandId: replayedCommand, revision: 1 },
      ));
      assert.equal(mismatchedReuse.status, 409);
      assert.match((await mismatchedReuse.json()).error, /already used for another operation/i);
    }
  }

  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'RESET_HEAT'").get().count,
    4,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'HEAT_RESET'").get().count,
    4,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'heat-1'").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("heat reset validates input and rejects non-resettable, unlocked, empty, stale, and published heats", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { handle } = await startedRoundHarness(database);
  database.exec("UPDATE heats SET status = 'READY' WHERE id = 'heat-1'");
  const revision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-1'").get().revision;

  const malformedRequests = [
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-1/reset", {
      method: "POST",
      body: JSON.stringify({ commandId: commandId(), revision }),
    }),
    jsonRequest("/api/v1/staff/events/event/heats/heat-1/reset", "POST", { commandId: "not-a-uuid", revision }),
    jsonRequest("/api/v1/staff/events/event/heats/heat-1/reset", "POST", { commandId: commandId(), revision: -1 }),
    jsonRequest("/api/v1/staff/events/event/heats/heat-1/reset", "POST", { commandId: commandId(), revision: 1.5 }),
  ];
  for (const request of malformedRequests) {
    const response = await handle(request);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Command identifier and heat revision/i);
  }

  const stale = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/reset",
    "POST",
    { commandId: commandId(), revision: revision + 1 },
  ));
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /heat changed/i);

  for (const status of ["LOADING", "PLANNED", "FINALIZED", "CANCELLED"]) {
    database.prepare(
      "UPDATE heats SET status = ?, finalized_at = ? WHERE id = 'heat-1'",
    ).run(status, status === "FINALIZED" ? "2026-07-26T11:10:00Z" : null);
    const response = await handle(jsonRequest(
      "/api/v1/staff/events/event/heats/heat-1/reset",
      "POST",
      { commandId: commandId(), revision },
    ));
    assert.equal(response.status, 409, status);
    assert.match((await response.json()).error, /Only a READY, CALLING, RUNNING, or AWAITING_RESULT/i);
    assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-1'").get().status, status);
  }

  database.exec("UPDATE heats SET status = 'READY', finalized_at = NULL, roster_locked_at = NULL WHERE id = 'heat-1'");
  const unlocked = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/reset",
    "POST",
    { commandId: commandId(), revision },
  ));
  assert.equal(unlocked.status, 409);
  assert.match((await unlocked.json()).error, /locked roster intact/i);

  database.exec(`
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size, roster_locked_at,
       roster_locked_by_staff_profile_id)
    VALUES ('heat-empty', 'event', 'ROUND_ONE', 3, 'READY', 3,
            '2026-07-26T10:45:00Z', 'staff');
  `);
  const empty = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-empty/reset",
    "POST",
    { commandId: commandId(), revision: 0 },
  ));
  assert.equal(empty.status, 409);
  assert.match((await empty.json()).error, /locked roster intact/i);

  database.exec(`
    UPDATE heats
       SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T10:45:00Z',
           roster_locked_by_staff_profile_id = 'staff'
     WHERE id = 'heat-1';
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('published-result-command', 'event', 'FINALIZE_HEAT_RESULT', 'heat-1',
            '2026-07-26T11:10:00Z', '2026-07-26T11:10:00Z', 'staff');
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status,
       revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES ('published-result', 'event', 'heat-1', 'entry-1', 'assignment-1', 1,
            'FINALIZED', 1, '2026-07-26T11:10:00Z', 'staff', 'published-result-command');
  `);
  const published = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/reset",
    "POST",
    { commandId: commandId(), revision },
  ));
  assert.equal(published.status, 409);
  assert.match((await published.json()).error, /Published results must be reopened or corrected/i);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'heat-1'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-1'").get().count, 0);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'RESET_HEAT'").get().count,
    0,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'HEAT_RESET'").get().count, 0);
});

test("heat reset repeats state, lock, roster, and result guards inside its atomic batch", async () => {
  for (const conflict of ["state", "lock", "result"]) {
    const database = createDatabase();
    try {
      const { DB, handle } = await startedRoundHarness(database);
      database.exec(`
        UPDATE heats
           SET status = 'RUNNING', started_at = '2026-07-26T11:00:00Z'
         WHERE id = 'heat-1';
      `);
      const revision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-1'").get().revision;
      DB.beforeBatch = () => {
        if (conflict === "state") {
          database.exec("UPDATE heats SET status = 'CANCELLED' WHERE id = 'heat-1'");
        } else if (conflict === "lock") {
          database.exec("UPDATE heats SET roster_locked_at = NULL WHERE id = 'heat-1'");
        } else {
          database.exec(`
            INSERT INTO race_commands
              (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
            VALUES ('concurrent-result-command', 'event', 'FINALIZE_HEAT_RESULT', 'heat-1',
                    '2026-07-26T11:05:00Z', '2026-07-26T11:05:00Z', 'staff');
            INSERT INTO heat_results
              (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status,
               revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
            VALUES ('concurrent-result', 'event', 'heat-1', 'entry-1', 'assignment-1', 1,
                    'FINALIZED', 1, '2026-07-26T11:05:00Z', 'staff', 'concurrent-result-command');
          `);
        }
      };

      const response = await handle(jsonRequest(
        "/api/v1/staff/events/event/heats/heat-1/reset",
        "POST",
        { commandId: commandId(), revision },
      ));
      assert.equal(response.status, 409, conflict);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'RESET_HEAT'").get().count,
        0,
        conflict,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'HEAT_RESET'").get().count, 0, conflict);
      if (conflict === "state") {
        assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-1'").get().status, "CANCELLED");
      } else if (conflict === "lock") {
        assert.equal(database.prepare("SELECT roster_locked_at FROM heats WHERE id = 'heat-1'").get().roster_locked_at, null);
      } else {
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'heat-1'").get().count, 1);
      }
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
  }
});

test("a heat with no eligible racer left cannot lock, and results still require ACTIVE", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-active', 'event', 'ROUND_ONE', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-active', 'event', 'heat-active', 'entry-1', 'ROUND_ONE', 1,
            'BALANCED_DRAW', '2026-07-26T11:00:00Z'),
           ('heat-entry-active-2', 'event', 'heat-active', 'entry-2', 'ROUND_ONE', 2,
            'BALANCED_DRAW', '2026-07-26T11:00:00Z');
  `);
  const DB = d1(database);
  const env = { APP_ORIGIN: "https://quickducks.com", DB };
  const handle = (request) => handleHeatOperations(request, env, actor);
  const entriesBefore = database.prepare(
    "SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id",
  ).all().map((row) => ({ ...row }));

  // One racer out of two leaving is normal: the heat still has someone who can
  // win, so it locks with the withdrawn racer in place.
  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1'");
  const mixedLock = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/lock",
    "POST",
    { commandId: commandId(), revision: 0 },
  ));
  assert.equal(mixedLock.status, 201, JSON.stringify(await mixedLock.clone().json()));
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row })),
    entriesBefore,
  );
  database.exec(`
    UPDATE heats SET status = 'PLANNED', roster_locked_at = NULL,
           roster_locked_by_staff_profile_id = NULL, revision = 0,
           source_command_id = NULL WHERE id = 'heat-active';
    DELETE FROM audit_events WHERE action = 'HEAT_LOCKED';
    DELETE FROM race_commands WHERE command_type = 'LOCK_HEAT';
  `);

  // Both racers gone is the one roster the lock still refuses: this heat could
  // never produce a result.
  database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-2'");
  const inactiveLock = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/lock",
    "POST",
    { commandId: commandId(), revision: 0 },
  ));
  assert.equal(inactiveLock.status, 409);
  assert.match((await inactiveLock.json()).error, /cannot produce a winner.*Reactivate/is);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-active'").get().status, "PLANNED");

  database.exec("UPDATE registrations SET status = 'ACTIVE' WHERE id IN ('registration-1', 'registration-2')");
  DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id IN ('registration-1', 'registration-2')");
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
    UPDATE registrations SET status = 'ACTIVE' WHERE id = 'registration-2';
    UPDATE heats
       SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T11:05:00Z',
           finished_at = '2026-07-26T11:10:00Z', revision = 4
     WHERE id = 'heat-active';
  `);
  const inactiveScan = await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-active/finish-scan?value=1",
  ));
  assert.equal(inactiveScan.status, 422);
  const inactiveScanBody = await inactiveScan.json();
  assert.equal(inactiveScanBody.reason, FINISH_DUCK_INELIGIBLE_REASON);
  assert.match(inactiveScanBody.error, /Withdrawn.*scan the next duck to pass the finish line/i);

  const inactiveResult = await handle(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-active/results/finalize",
    "POST",
    { commandId: commandId(), revision: 4, results: [{ raceEntryId: "entry-1", place: 1 }] },
  ));
  assert.equal(inactiveResult.status, 422);
  const inactiveResultBody = await inactiveResult.json();
  assert.equal(inactiveResultBody.reason, FINISH_DUCK_INELIGIBLE_REASON);
  assert.deepEqual(inactiveResultBody.ineligibleRaceEntryIds, ["entry-1"]);
  assert.match(inactiveResultBody.error, /withdrawn or disqualified.*scan the next duck/i);

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

  // Through all of it, no heat entry moved.
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row })),
    entriesBefore,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("winner-by-tag candidates require one awaiting heat, its roster, and the current assignment", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  const winningToken = "a".repeat(32);
  const otherToken = "b".repeat(32);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    INSERT INTO duck_tags (id, duck_id, token, status, activated_at)
    VALUES ('tag-1', 'duck-1', '${winningToken}', 'ACTIVE', '2026-07-26T11:00:00Z'),
           ('tag-2', 'duck-2', '${otherToken}', 'ACTIVE', '2026-07-26T11:00:00Z');
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size, revision)
    VALUES ('heat-awaiting', 'event', 'ROUND_ONE', 4, 'PLANNED', 1, 7),
           ('heat-other', 'event', 'ROUND_ONE', 5, 'PLANNED', 1, 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('candidate-entry', 'event', 'heat-awaiting', 'entry-1', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T11:00:00Z'),
           ('other-entry', 'event', 'heat-other', 'entry-2', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T11:00:00Z');
    UPDATE heats SET status = 'AWAITING_RESULT' WHERE id = 'heat-awaiting';
    UPDATE heats SET status = 'READY' WHERE id = 'heat-other';
  `);
  const DB = d1(database);
  const env = { DB };

  assert.deepEqual(await winnerByTagCandidate(env, winningToken), {
    eventId: "event",
    heatId: "heat-awaiting",
    raceEntryId: "entry-1",
    revision: 7,
    heatNumber: 4,
    round: "ROUND_ONE",
    participantDisplayName: "Daisy D.",
    // A round-one heat awards one place, so it carries no podium to choose
    // from. The field is present and null rather than absent, so a client can
    // branch on the round without guessing.
    podium: null,
  });
  assert.equal(await winnerByTagCandidate(env, otherToken), null, "wrong-heat duck");
  assert.equal(await winnerByTagCandidate(env, "z".repeat(32)), null, "unknown duck");

  database.exec("UPDATE duck_assignments SET valid_to = '2026-07-26T11:05:00Z', end_reason = 'UNASSIGNED' WHERE id = 'assignment-1'");
  assert.equal(await winnerByTagCandidate(env, winningToken), null, "unassigned duck");
  database.exec("UPDATE duck_assignments SET valid_to = NULL, end_reason = NULL WHERE id = 'assignment-1'");
  database.exec("UPDATE heats SET status = 'AWAITING_RESULT' WHERE id = 'heat-other'");
  assert.equal(await winnerByTagCandidate(env, winningToken), null, "ambiguous awaiting heat");
  database.exec("UPDATE heats SET status = 'READY' WHERE id = 'heat-other'");

  DB.beforeBatch = () => {
    database.exec("UPDATE duck_assignments SET valid_to = '2026-07-26T11:06:00Z', end_reason = 'UNASSIGNED' WHERE id = 'assignment-1'");
  };
  const response = await handleHeatOperations(jsonRequest(
    `/api/v1/staff/ducks/${winningToken}/heat-winner`,
    "POST",
    {
      commandId: commandId(), eventId: "event", heatId: "heat-awaiting",
      raceEntryId: "entry-1", revision: 7,
    },
  ), env, actor);
  assert.equal(response.status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
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
// The old model refused to start the final while any finalist was not ACTIVE and
// named "replace that roster" as the remedy. That is exactly backwards now: the
// finalist's duck is already sealed into the final's bag, replacing the roster
// would renumber slots the bags cannot follow, and refusing made the rule
// unreachable. The final starts with them on it, marked and ineligible.
test("a withdrawn finalist does not block the final and keeps their exact roster place", async (context) => {
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
  const entriesBefore = database.prepare(
    "SELECT id, heat_id, race_entry_id, slot_number, assignment_source FROM heat_entries ORDER BY id",
  ).all().map((row) => ({ ...row }));

  const readiness = await handleEvent(new Request(
    "https://quickducks.com/api/v1/staff/events/event/readiness",
  ));
  const gate = (await readiness.json()).readiness["start-final"];
  assert.equal(gate.allowed, true);
  assert.deepEqual(gate.blockers, []);
  // Reported, never blocking.
  assert.deepEqual(gate.notes, [
    "1 racer on the final roster is withdrawn or disqualified. That duck stays in its heat bag "
    + "and races as normal, but cannot be recorded as a winner.",
  ]);

  const started = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-final",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  const locked = database.prepare("SELECT status, roster_locked_at FROM heats WHERE id = 'heat-final'").get();
  assert.equal(locked.status, "LOADING");
  assert.notEqual(locked.roster_locked_at, null);
  // Byte for byte the roster it was before the final started.
  assert.deepEqual(
    database.prepare(
      "SELECT id, heat_id, race_entry_id, slot_number, assignment_source FROM heat_entries ORDER BY id",
    ).all().map((row) => ({ ...row })),
    entriesBefore,
  );

  // The staff finalist list keeps showing them, marked, because their duck is
  // physically in the final's bag and staff have to reconcile the bag.
  const finalists = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/finalists"),
    env,
    actor,
  );
  assert.equal(finalists.status, 200);
  assert.deepEqual((await finalists.json()).finalists.map((row) => ({
    raceEntryId: row.raceEntryId,
    slotNumber: row.slotNumber,
    eligible: row.eligible,
    registrationStatus: row.participant.registrationStatus,
  })), [
    { raceEntryId: "entry-1", slotNumber: 1, eligible: false, registrationStatus: "WITHDRAWN" },
    { raceEntryId: "entry-4", slotNumber: 2, eligible: true, registrationStatus: "ACTIVE" },
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The one roster fact that still refuses: a final nobody can win.
test("a final whose every finalist left is refused and writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
    UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-4';
  `);
  const env = { DB: d1(database) };
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  const readiness = await handleEvent(new Request(
    "https://quickducks.com/api/v1/staff/events/event/readiness",
  ));
  const gate = (await readiness.json()).readiness["start-final"];
  assert.equal(gate.allowed, false);
  assert.deepEqual(gate.blockers, [
    "A heat in the final has no racer left who can win: every racer on that roster is "
    + "withdrawn or disqualified, so the heat could not produce a result. Reactivate a racer "
    + "before starting. The roster, the slot numbers, and the ducks in the bag stay exactly as they are.",
  ]);

  const blocked = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-final",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(blocked.status, 409);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "ROUND_ONE");
  const finalHeat = database.prepare("SELECT status, roster_locked_at FROM heats WHERE id = 'heat-final'").get();
  assert.equal(finalHeat.status, "PLANNED");
  assert.equal(finalHeat.roster_locked_at, null);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_FINAL'",
  ).get().count, 0);
});

// ---------------------------------------------------------------------------
// Promotion and result correction when a winner is no longer eligible
// ---------------------------------------------------------------------------

// Promotion into the final happens in the same guarded batch that publishes the
// round-one winner, and that batch requires an `ACTIVE` racer. So a racer who
// left can never become a winner and therefore can never be promoted — there is
// no separate promotion path to guard.
test("a round-one winner who left cannot be published and is never promoted", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE heats SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T10:45:00Z',
           finished_at = '2026-07-26T11:00:00Z' WHERE id = 'heat-1';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
  `);
  const env = { DB: d1(database) };

  const refused = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/results/finalize",
    "POST",
    { commandId: commandId(), revision: 0, results: [{ raceEntryId: "entry-1", place: 1 }] },
  ), env, actor);
  assert.equal(refused.status, 422);
  const body = await refused.json();
  assert.equal(body.reason, FINISH_DUCK_INELIGIBLE_REASON);
  assert.deepEqual(body.ineligibleRaceEntryIds, ["entry-1"]);

  // No result, no final heat, no promotion — the entire batch was never run.
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heats WHERE round = 'FINAL'").get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_entries WHERE round = 'FINAL'",
  ).get().count, 0);

  // An eligible racer in the same heat still publishes and is promoted, which
  // proves the refusal was about the racer and not about the heat.
  const published = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/results/finalize",
    "POST",
    { commandId: commandId(), revision: 0, results: [{ raceEntryId: "entry-2", place: 1 }] },
  ), env, actor);
  assert.equal(published.status, 201, JSON.stringify(await published.clone().json()));
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, slot_number FROM heat_entries WHERE round = 'FINAL' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [{ race_entry_id: "entry-2", slot_number: 1 }],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// A result stays published when its winner is later disqualified: the board
// simply shows that heat with nobody in first place. The correction path is how
// staff fix it, and it must still work with the original winner ineligible.
test("a published round-one result is correctable after its winner is disqualified", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-1';
  `);
  const env = { DB: d1(database) };

  // The staff heat detail keeps naming the published winner and marks them, so
  // the director can see both facts before deciding.
  const detail = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-1"),
    env,
    actor,
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.deepEqual(detailBody.results.map((row) => ({
    raceEntryId: row.raceEntryId,
    place: row.place,
    eligible: row.eligible,
    registrationStatus: row.participant.registrationStatus,
  })), [{ raceEntryId: "entry-1", place: 1, eligible: false, registrationStatus: "DISQUALIFIED" }]);

  const corrected = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/results/correct",
    "POST",
    {
      commandId: commandId(),
      revision: 0,
      reason: "The published winner was disqualified after the heat.",
      results: [{ raceEntryId: "entry-2", place: 1 }],
    },
  ), env, actor);
  assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()));
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, place FROM heat_results WHERE heat_id = 'heat-1' AND status = 'FINALIZED'",
    ).all().map((row) => ({ ...row })),
    [{ race_entry_id: "entry-2", place: 1 }],
  );
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE race_entry_id = 'entry-1' AND status = 'SUPERSEDED'",
  ).get().count, 1);
  // The promoted final entry was replaced in place: same row, same slot.
  assert.deepEqual(
    database.prepare(
      "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [
      { id: "final-entry-1", race_entry_id: "entry-2", slot_number: 1 },
      { id: "final-entry-2", race_entry_id: "entry-4", slot_number: 2 },
    ],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a published round-one result is reopenable and republishable after its winner withdraws", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-4';
  `);
  const env = { DB: d1(database) };

  const reopened = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-2/results/reopen",
    "POST",
    { commandId: commandId(), revision: 0, reason: "The published winner withdrew after the heat." },
  ), env, actor);
  assert.equal(reopened.status, 201, JSON.stringify(await reopened.clone().json()));
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-2'").get().status, "AWAITING_RESULT");
  // Their promotion is withdrawn with the result; the other finalist keeps their
  // exact slot.
  assert.deepEqual(
    database.prepare(
      "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [{ id: "final-entry-1", race_entry_id: "entry-1", slot_number: 1 }],
  );

  const revision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-2'").get().revision;
  const republished = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-2/results/finalize",
    "POST",
    { commandId: commandId(), revision, results: [{ raceEntryId: "entry-5", place: 1 }] },
  ), env, actor);
  assert.equal(republished.status, 201, JSON.stringify(await republished.clone().json()));
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [
      { race_entry_id: "entry-1", slot_number: 1 },
      { race_entry_id: "entry-5", slot_number: 2 },
    ],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The podium is only as deep as the racers who can take a place. A withdrawn
// finalist keeps their slot and their duck in the bag, but demanding a place for
// them would make the final impossible to publish and the event impossible to
// complete.
test("a final with a withdrawn finalist publishes a shorter podium and still completes", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'FINAL' WHERE id = 'event';
    UPDATE heats SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T12:00:00Z',
           started_at = '2026-07-26T12:05:00Z', finished_at = '2026-07-26T12:10:00Z'
     WHERE id = 'heat-final';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-1';
  `);
  const env = { DB: d1(database) };

  // Two on the roster, one eligible: a podium of exactly one place.
  const tooDeep = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/finalize",
    "POST",
    {
      commandId: commandId(),
      revision: 0,
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(tooDeep.status, 422);
  assert.match((await tooDeep.json()).error, /exactly places 1 through 1/);

  const published = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/finalize",
    "POST",
    { commandId: commandId(), revision: 0, results: [{ raceEntryId: "entry-4", place: 1 }] },
  ), env, actor);
  assert.equal(published.status, 201, JSON.stringify(await published.clone().json()));
  // The withdrawn finalist keeps their roster place; only the podium is shorter.
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [
      { race_entry_id: "entry-1", slot_number: 1 },
      { race_entry_id: "entry-4", slot_number: 2 },
    ],
  );

  const completion = await handleEventOperations(jsonRequest(
    "/api/v1/staff/events/event/complete",
    "POST",
    { commandId: commandId() },
  ), env, actor);
  assert.equal(completion.status, 201, JSON.stringify(await completion.clone().json()));
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "COMPLETED");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// ---------------------------------------------------------------------------
// Revising a published final while the race is still the race
// ---------------------------------------------------------------------------

// A finalized final holding a published podium while the event is still
// `FINAL`: exactly where a race director stands the moment they disqualify a
// winner. `seedFinalHeat` promotes two finalists, so the podium is two deep.
const seedPublishedFinal = async (database) => {
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'FINAL' WHERE id = 'event';
    UPDATE heats SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T12:00:00Z',
           started_at = '2026-07-26T12:05:00Z', finished_at = '2026-07-26T12:10:00Z'
     WHERE id = 'heat-final';
  `);
  const env = { DB: d1(database) };
  const published = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/finalize",
    "POST",
    {
      commandId: commandId(),
      revision: 0,
      results: [{ raceEntryId: "entry-1", place: 1 }, { raceEntryId: "entry-4", place: 2 }],
    },
  ), env, actor);
  assert.equal(published.status, 201, JSON.stringify(await published.clone().json()));
  return { env, revision: (await published.json()).heat.revision };
};

// The remedy that used to be circular. Correcting a final result demanded the
// event already be `COMPLETED`, but a podium the completion check disagreed with
// was exactly what stopped the event completing, so the documented instruction
// "complete the event, then correct it" could not be followed. `FINAL` is
// admitted because it is the state the director is actually in.
test("a final result is correctable while the event is still FINAL", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);

  const detail = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-final"),
    env,
    actor,
  );
  const detailBody = await detail.json();
  assert.equal(detailBody.heat.resultCorrectionAllowed, true, "the console is offered the same capability");
  assert.equal(detailBody.heat.resultReopenAllowed, true);

  // Least privilege: publishing a result and altering a published one stay
  // different powers, and the state change does not blur them.
  const resultTaker = { ...actor, roles: ["RESULT_TAKER"] };
  assert.equal((await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "A result taker may not alter a published podium.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, resultTaker)).status, 403);

  // Cookie-authenticated staff mutations require the exact application origin.
  const cookieActor = { ...actor, authentication: "cookie" };
  const apiEnv = { ...env, APP_ORIGIN: "https://quickducks.com" };
  const crossOrigin = await handleApi(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-final/results/correct",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com.evil.example" },
      body: JSON.stringify({
        commandId: commandId(), revision,
        reason: "A cross-origin correction must never land.",
        results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
      }),
    },
  ), apiEnv, async () => cookieActor);
  assert.equal(crossOrigin.status, 403);

  // A stale heat revision is a lifecycle conflict, not a silent overwrite.
  assert.equal((await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision: revision + 5,
      reason: "This correction was composed against a stale heat.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor)).status, 409);

  const correctionCommand = commandId();
  const correctedPodium = [
    { raceEntryId: "entry-4", place: 1 },
    { raceEntryId: "entry-1", place: 2 },
  ];
  const corrected = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: correctionCommand, revision,
      reason: "Photo review changed the podium before the event was completed.",
      results: correctedPodium,
    },
  ), env, actor);
  assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()));
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, place FROM heat_results WHERE heat_id = 'heat-final' AND status = 'FINALIZED' ORDER BY place",
    ).all().map((row) => ({ ...row })),
    [{ race_entry_id: "entry-4", place: 1 }, { race_entry_id: "entry-1", place: 2 }],
  );
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final' AND status = 'SUPERSEDED'",
  ).get().count, 2);
  // The event did not move. A `FINAL` correction never completes the event for
  // the operator, and it can never walk a `COMPLETED` event backwards either.
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "FINAL");
  // Finalist promotion belongs to round one alone; a FINAL correction computes
  // none and must leave every promoted roster row exactly where it was.
  assert.deepEqual(
    database.prepare(
      "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [
      { id: "final-entry-1", race_entry_id: "entry-1", slot_number: 1 },
      { id: "final-entry-2", race_entry_id: "entry-4", slot_number: 2 },
    ],
  );

  // A matching retry replays instead of superseding the podium a second time.
  const replay = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: correctionCommand, revision,
      reason: "Photo review changed the podium before the event was completed.",
      results: correctedPodium,
    },
  ), env, actor);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final' AND status = 'SUPERSEDED'",
  ).get().count, 2);
  // The same identifier for different material is a conflict.
  const reused = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: correctionCommand, revision,
      reason: "A different correction reusing the identifier.",
      results: [{ raceEntryId: "entry-1", place: 1 }, { raceEntryId: "entry-4", place: 2 }],
    },
  ), env, actor);
  assert.equal(reused.status, 409);

  const completion = await handleEventOperations(jsonRequest(
    "/api/v1/staff/events/event/complete",
    "POST",
    { commandId: commandId() },
  ), env, actor);
  assert.equal(completion.status, 201, JSON.stringify(await completion.clone().json()));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a final result is reopenable while the event is still FINAL and the event never moves", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);

  const reopened = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/reopen",
    "POST",
    { commandId: commandId(), revision, reason: "The podium needs one more video review." },
  ), env, actor);
  assert.equal(reopened.status, 201, JSON.stringify(await reopened.clone().json()));
  const reopenedRevision = (await reopened.json()).heat.revision;
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-final'").get().status, "AWAITING_RESULT");
  // Reopening a `COMPLETED` event's final walks it back to `FINAL`. Reopening
  // one that is already `FINAL` must leave it there rather than anywhere else.
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event'").get().status, "FINAL");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = 'heat-final' AND status = 'FINALIZED'",
  ).get().count, 0);
  // The final roster is untouched: a FINAL reopen removes no promotion.
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_entries WHERE heat_id = 'heat-final'",
  ).get().count, 2);

  const republished = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/finalize",
    "POST",
    {
      commandId: commandId(),
      revision: reopenedRevision,
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(republished.status, 201, JSON.stringify(await republished.clone().json()));
  const completion = await handleEventOperations(jsonRequest(
    "/api/v1/staff/events/event/complete",
    "POST",
    { commandId: commandId() },
  ), env, actor);
  assert.equal(completion.status, 201, JSON.stringify(await completion.clone().json()));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The old refusal blamed "return processing", a concept this product does not
// have: no role, no status, no endpoint, and no column implements it. What the
// guard actually reads is `event_ducks.released_at`, set when a duck is deleted
// or released back to inventory, plus the event's own status.
//
// It reads it for the rows this command rewrites and for nothing else. An
// event-wide `EXISTS (any released event_duck)` refused every later correction
// the moment any duck anywhere left the event — a spare un-reserved at the
// registration desk did it — which is the shape of stranding this whole area
// keeps producing.
test("final correction and reopen name their real preconditions", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);

  // A duck named by a published podium row has left the event, so that row's
  // assignment no longer describes a duck in this race. `assignment-1` backs
  // the published first place.
  database.exec(`
    UPDATE event_ducks
       SET released_at = '2026-07-26T13:00:00Z', release_reason = 'STAFF_RELEASED',
           released_by_staff_profile_id = 'staff'
     WHERE id = 'event-duck-1'
  `);
  const correction = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "A correction attempted after a duck left the event.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(correction.status, 409);
  assert.equal(
    (await correction.json()).error,
    "Final results cannot be corrected once a duck has been released from this event.",
  );
  const reopen = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/reopen",
    "POST",
    { commandId: commandId(), revision, reason: "A reopen attempted after a duck left the event." },
  ), env, actor);
  assert.equal(reopen.status, 409);
  assert.equal(
    (await reopen.json()).error,
    "Final results cannot be reopened once a duck has been released from this event.",
  );
  // The console is told the same thing rather than offering a control the
  // server refuses.
  const detail = await (await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-final"),
    env,
    actor,
  )).json();
  assert.equal(detail.heat.resultCorrectionAllowed, false);
  assert.equal(detail.heat.resultReopenAllowed, false);
  // Nothing was written by either refusal.
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final'",
  ).get().count, 0);

  // A duck released somewhere else in the event is not this result's problem.
  // `event-duck-6` belongs to a racer who never reached the final, so no row
  // this command writes or supersedes names it, and the remedy stays reachable.
  database.exec(`
    UPDATE event_ducks SET released_at = NULL, release_reason = NULL,
           released_by_staff_profile_id = NULL WHERE id = 'event-duck-1';
    UPDATE event_ducks
       SET released_at = '2026-07-26T13:00:00Z', release_reason = 'STAFF_RELEASED',
           released_by_staff_profile_id = 'staff'
     WHERE id = 'event-duck-6';
  `);
  const unrelatedDetail = await (await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-final"),
    env,
    actor,
  )).json();
  assert.equal(unrelatedDetail.heat.resultCorrectionAllowed, true);
  assert.equal(unrelatedDetail.heat.resultReopenAllowed, true);
  const unrelated = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "A duck released elsewhere in the event blocks nothing here.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(unrelated.status, 201, JSON.stringify(await unrelated.clone().json()));
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, place FROM heat_results WHERE heat_id = 'heat-final' AND status = 'FINALIZED' ORDER BY place",
    ).all().map((row) => ({ ...row })),
    [{ race_entry_id: "entry-4", place: 1 }, { race_entry_id: "entry-1", place: 2 }],
  );

  // The other precondition, stated separately so a caller is never told the
  // wrong reason: the event has to be in a state where a final result exists to
  // revise at all.
  const correctedRevision = database.prepare(
    "SELECT revision FROM heats WHERE id = 'heat-final'",
  ).get().revision;
  database.exec(`
    UPDATE event_ducks SET released_at = NULL, release_reason = NULL,
           released_by_staff_profile_id = NULL WHERE id = 'event-duck-6';
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
  `);
  const wrongState = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision: correctedRevision,
      reason: "A correction attempted from the wrong event state.",
      results: [{ raceEntryId: "entry-1", place: 1 }, { raceEntryId: "entry-4", place: 2 }],
    },
  ), env, actor);
  assert.equal(wrongState.status, 409);
  assert.equal(
    (await wrongState.json()).error,
    "Final results can be corrected only while the event is FINAL or COMPLETED.",
  );
  const wrongStateReopen = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/reopen",
    "POST",
    {
      commandId: commandId(),
      revision: correctedRevision,
      reason: "A reopen attempted from the wrong event state.",
    },
  ), env, actor);
  assert.equal(wrongStateReopen.status, 409);
  assert.equal(
    (await wrongStateReopen.json()).error,
    "Final results can be reopened only while the event is FINAL or COMPLETED.",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// ---------------------------------------------------------------------------
// One event-status list, four places that read it
// ---------------------------------------------------------------------------

// The states a published final result may be revised from were written out five
// times: once as a JavaScript array and four times as a SQL literal, in the two
// heat-summary capability projections and in the two guarded command rows. That
// is exactly the preflight/guarded-batch drift the shared podium-depth
// expression was extracted to stop, one table over.
//
// This drives the real projection and both real command inserts, captures the
// SQL the handlers actually prepared, and proves all three carry the identical
// interpolated string — and that no hand-written variant of it survives in the
// module.
test("one interpolated event-status list serves the projection and both command rows", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  assert.deepEqual([...FINAL_RESULT_REVISABLE_EVENT_STATUSES], ["FINAL", "COMPLETED"]);
  assert.equal(FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL, "('FINAL', 'COMPLETED')");

  const { env, revision } = await seedPublishedFinal(database);
  const inner = env.DB;
  const prepared = [];
  env.DB = {
    get beforeBatch() {
      return inner.beforeBatch;
    },
    set beforeBatch(hook) {
      inner.beforeBatch = hook;
    },
    prepare(sql) {
      prepared.push(sql);
      return inner.prepare(sql);
    },
    batch(statements) {
      return inner.batch(statements);
    },
  };

  const detail = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event/heats/heat-final"),
    env,
    actor,
  );
  assert.equal(detail.status, 200);
  const corrected = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "Driving the real correction command row to capture its SQL.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()));
  const reopened = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/reopen",
    "POST",
    {
      commandId: commandId(),
      revision: (await corrected.json()).heat.revision,
      reason: "Driving the real reopen command row to capture its SQL.",
    },
  ), env, actor);
  assert.equal(reopened.status, 201, JSON.stringify(await reopened.clone().json()));

  const only = (needle, label) => {
    const matches = prepared.filter((sql) => sql.includes(needle));
    assert.ok(matches.length > 0, `${label}: no statement was prepared`);
    return matches[0];
  };
  const projection = only("AS result_correction_allowed", "the heat summary projection");
  const correctCommand = only("'CORRECT_HEAT_RESULT'", "the correction command row");
  const reopenCommand = only("'REOPEN_HEAT_RESULT'", "the reopen command row");

  const fragment = `e.status IN ${FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL}`;
  const occurrences = (sql) => sql.split(fragment).length - 1;
  // The projection reads it once for correction and once for reopen.
  assert.equal(occurrences(projection), 2, "both capability projections read the one list");
  assert.equal(occurrences(correctCommand), 1, "the correction command row reads the one list");
  assert.equal(occurrences(reopenCommand), 1, "the reopen command row reads the one list");

  // And no hand-written variant of the same set survives anywhere in the module.
  const source = readFileSync(new URL("./heat-operations.ts", import.meta.url), "utf8");
  for (const variant of [
    "('FINAL', 'COMPLETED')",
    "('FINAL','COMPLETED')",
    "('COMPLETED', 'FINAL')",
  ]) {
    assert.equal(source.includes(variant), false, `a literal ${variant} was retyped instead of derived`);
  }
  assert.equal(
    source.split("FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL").length - 1,
    5,
    "one definition and exactly four readers",
  );
});

// ---------------------------------------------------------------------------
// A correction cannot write a racer who left the race
// ---------------------------------------------------------------------------

// The preflight refusal. `validateResultSet` runs for a correction exactly as it
// does for a first publication, so the ordinary race-day case — a director opens
// the correction form for a racer somebody else has already disqualified — is
// answered with the same stable reason and the same "which selection to drop"
// list the finish line uses.
test("a correction naming a racer who already left the race is refused and writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);
  database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-4'");

  // Two finalists, one eligible: a one-place podium, and the racer who left may
  // not hold it.
  const refused = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "A correction naming the racer who was just disqualified.",
      results: [{ raceEntryId: "entry-4", place: 1 }],
    },
  ), env, actor);
  assert.equal(refused.status, 422);
  const body = await refused.json();
  assert.equal(body.reason, FINISH_DUCK_INELIGIBLE_REASON);
  assert.deepEqual(body.ineligibleRaceEntryIds, ["entry-4"]);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CORRECT_HEAT_RESULT'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final'",
  ).get().count, 0);

  // The eligible racer can still be corrected into the one place that exists.
  const corrected = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "The podium shrank to the one racer who can hold a place.",
      results: [{ raceEntryId: "entry-1", place: 1 }],
    },
  ), env, actor);
  assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The decisive one. `correctResults` reads the roster, then makes at least two
// further round trips before `env.DB.batch(...)`. Withdrawal and disqualification
// are legal at any heat state, they touch only `race_commands`, `registrations`,
// and `audit_events`, and they never close the duck assignment — so nothing about
// the heat revision or any foreign key notices one landing in that window. Only a
// guard inside the batch can.
//
// Without the in-batch eligibility count this commits, and `heat_results` ends up
// holding a `DISQUALIFIED` racer at a published place that the public podium then
// silently hides, leaving an unexplained gap.
test("a correction whose racer stops being ACTIVE after the roster read is refused by the batch", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);
  const publishedBefore = database.prepare(
    "SELECT id, race_entry_id, place, source_command_id FROM heat_results WHERE heat_id = 'heat-final' ORDER BY place",
  ).all().map((row) => ({ ...row }));
  const revisionBefore = database.prepare("SELECT revision FROM heats WHERE id = 'heat-final'").get().revision;

  // The second device: another director disqualifies the racer this correction
  // names, after `validateResultSet` accepted them and before the batch runs.
  env.DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-4'");
  };
  const raced = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "Photo review put the other finalist first.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(raced.status, 409);

  // Nothing at all was written: no command row, no superseded history, no new
  // podium, no revision bump, no audit event.
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CORRECT_HEAT_RESULT'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'HEAT_RESULT_CORRECTED'",
  ).get().count, 0);
  // Byte for byte the podium that was already published, including the row ids
  // and the command that wrote them: not one result row was replaced.
  assert.deepEqual(
    database.prepare(
      "SELECT id, race_entry_id, place, source_command_id FROM heat_results WHERE heat_id = 'heat-final' ORDER BY place",
    ).all().map((row) => ({ ...row })),
    publishedBefore,
  );
  assert.equal(
    database.prepare("SELECT revision FROM heats WHERE id = 'heat-final'").get().revision,
    revisionBefore,
  );
  // The specific corruption this guard exists to stop: no place is held by a
  // racer a *correction* wrote after they stopped being ACTIVE. The rows that
  // remain are the original publication, which deliberately keeps naming the
  // racer it named — that is the documented gap the public podium leaves.
  assert.equal(database.prepare(
    `SELECT COUNT(*) AS count
       FROM heat_results hr
       JOIN race_commands rc ON rc.id = hr.source_command_id
      WHERE rc.command_type = 'CORRECT_HEAT_RESULT'`,
  ).get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a round-one correction whose new winner leaves before the batch writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  seedFinalHeat(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-1';
  `);
  const DB = d1(database);
  const env = { DB };

  DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2'");
  };
  const raced = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-1/results/correct",
    "POST",
    {
      commandId: commandId(),
      revision: 0,
      reason: "The published winner was disqualified after the heat.",
      results: [{ raceEntryId: "entry-2", place: 1 }],
    },
  ), env, actor);
  assert.equal(raced.status, 409);
  assert.deepEqual(
    database.prepare(
      "SELECT race_entry_id, place FROM heat_results WHERE heat_id = 'heat-1' AND status = 'FINALIZED'",
    ).all().map((row) => ({ ...row })),
    [{ race_entry_id: "entry-1", place: 1 }],
  );
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-1'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CORRECT_HEAT_RESULT'",
  ).get().count, 0);
  // The finalist roster row the correction would have rewritten is untouched.
  assert.deepEqual(
    database.prepare(
      "SELECT id, race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-final' ORDER BY slot_number",
    ).all().map((row) => ({ ...row })),
    [
      { id: "final-entry-1", race_entry_id: "entry-1", slot_number: 1 },
      { id: "final-entry-2", race_entry_id: "entry-4", slot_number: 2 },
    ],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The same window, for the duck rather than the racer: a correction resolves a
// duck assignment, and that assignment is closed before the batch runs.
test("a correction whose duck assignment closes before the batch writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { env, revision } = await seedPublishedFinal(database);

  env.DB.beforeBatch = () => {
    database.exec(
      `UPDATE duck_assignments
          SET valid_to = '2026-07-26T13:00:00Z', end_reason = 'DUCK_DELETED'
        WHERE id = 'assignment-4'`,
    );
  };
  const raced = await handleHeatOperations(jsonRequest(
    "/api/v1/staff/events/event/heats/heat-final/results/correct",
    "POST",
    {
      commandId: commandId(), revision,
      reason: "Photo review put the other finalist first.",
      results: [{ raceEntryId: "entry-4", place: 1 }, { raceEntryId: "entry-1", place: 2 }],
    },
  ), env, actor);
  assert.equal(raced.status, 409);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CORRECT_HEAT_RESULT'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE heat_id = 'heat-final'",
  ).get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
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

  assert.deepEqual(Object.keys(body).sort(), ["heat", "podium", "results", "roster"]);
  // Round one has no provisional podium to report, so the field is null rather
  // than an empty podium a station might try to render.
  assert.equal(body.podium, null);
  const [entry] = body.roster;
  assert.deepEqual(Object.keys(entry).sort(), [
    "assignmentSource",
    "duck",
    // Staff rosters must show who left the race, because that duck is still in
    // the bag and the announcer must not call the name.
    "eligible",
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
    // Not narrower on this one point: the announcer is the person who must not
    // read out a withdrawn racer's name, so the status ships with the roster.
    "eligible",
    "raceEntryId",
    "registrationStatus",
    "slotNumber",
  ]);
  // Deliberate: the participant-chosen duck name is public on the board and the
  // duck pages, but it is never handed to the microphone. A name that slips past
  // the filter can be cleared from a screen; it cannot be unsaid over a PA at a
  // family event, and the announcer needs the number to line racers up anyway.
  assert.equal(Object.hasOwn(announcerBody.roster[0], "duckName"), false);
  assert.doesNotMatch(JSON.stringify(announcerBody), /duckName|duck_name/);

  // No contact detail, lookup code, private token, or staff note reaches either
  // projection, whatever identifiers they do carry.
  for (const payload of [JSON.stringify(body), JSON.stringify(announcerBody)]) {
    assert.doesNotMatch(payload, /email|phone|lookupCode|CODE000|private|token|notes/i);
  }
});

// A duck can be deleted at any point, including after a roster is locked. The
// participant keeps their place in the heat and holds nothing, so the heat must
// not go off without them. This is the rule that makes deleting a duck mid-race
// safe rather than quietly ruinous.
// The rule the round-start and the lock share, exercised at the heat station:
// withdrawn racers ride along, and only a heat nobody can win is refused.
test("a heat holding a withdrawn racer runs normally, and one nobody can win is refused", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedRace(database);
  seedRoundOneHeats(database);
  const DB = d1(database);
  const env = { DB };
  const handle = (request) => handleHeatOperations(request, env, actor);
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  // One racer in heat 1 and every racer in heat 2 leave before the round starts.
  database.exec(`
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2';
    UPDATE registrations SET status = 'WITHDRAWN' WHERE id IN ('registration-4', 'registration-5');
    UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-6';
  `);
  const entriesBefore = database.prepare(
    "SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id",
  ).all().map((row) => ({ ...row }));

  // Heat 2 has nobody who can win, so the whole round start is refused and
  // neither heat is locked.
  const blockedRound = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-round-one",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(blockedRound.status, 409);
  assert.deepEqual(
    database.prepare("SELECT roster_locked_at FROM heats ORDER BY heat_number").all()
      .map((row) => row.roster_locked_at),
    [null, null],
  );

  // Reactivating one racer in heat 2 is the remedy, and the round then starts
  // with three withdrawn racers still on their rosters.
  database.exec("UPDATE registrations SET status = 'ACTIVE' WHERE id = 'registration-4'");
  const started = await handleEvent(jsonRequest(
    "/api/v1/staff/events/event/start-round-one",
    "POST",
    { commandId: commandId() },
  ));
  assert.equal(started.status, 201, JSON.stringify(await started.clone().json()));
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row })),
    entriesBefore,
  );

  const move = async (heatId, operation, revision) => {
    const response = await handle(jsonRequest(
      `/api/v1/staff/events/event/heats/${heatId}/${operation}`,
      "POST",
      { commandId: commandId(), revision },
    ));
    return { status: response.status, body: await response.json() };
  };
  let revision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-1'").get().revision;
  for (const operation of ["ready", "call", "start"]) {
    const step = await move("heat-1", operation, revision);
    assert.equal(step.status, 201, `${operation}: ${JSON.stringify(step.body)}`);
    revision = step.body.heat.revision;
  }
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-1'").get().status, "RUNNING");
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row })),
    entriesBefore,
  );

  // Heat 2's last eligible racer leaves while it is loading. It cannot start,
  // and the refusal writes nothing.
  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-4'");
  let secondRevision = database.prepare("SELECT revision FROM heats WHERE id = 'heat-2'").get().revision;
  for (const operation of ["ready", "call"]) {
    const step = await move("heat-2", operation, secondRevision);
    assert.equal(step.status, 201, `heat-2 ${operation}: ${JSON.stringify(step.body)}`);
    secondRevision = step.body.heat.revision;
  }
  const refusedStart = await move("heat-2", "start", secondRevision);
  assert.equal(refusedStart.status, 409);
  assert.match(refusedStart.body.error, /cannot produce a winner.*Reactivate/is);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-2'").get().status, "CALLING");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_HEAT'",
  ).get().count, 1, "only heat 1 ever recorded a start command");

  // The guarded SQL, not just the preflight, holds the line: heat 2's last
  // eligible racer leaves between the preflight and the batch.
  database.exec("UPDATE registrations SET status = 'ACTIVE' WHERE id = 'registration-4'");
  // Heat 1 stops being the one running heat, so the concurrency guard is not
  // what refuses below.
  database.exec(`
    UPDATE heats
       SET status = 'FINALIZED', finished_at = '2026-07-26T11:20:00Z',
           finalized_at = '2026-07-26T11:25:00Z'
     WHERE id = 'heat-1';
  `);
  DB.beforeBatch = () => {
    database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-4'");
  };
  const racedStart = await move("heat-2", "start", secondRevision);
  assert.equal(racedStart.status, 409);
  assert.match(racedStart.body.error, /every racer left the race/i);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-2'").get().status, "CALLING");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_HEAT'",
  ).get().count, 1);

  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row })),
    entriesBefore,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a heat refuses to start while any racer in it holds no duck", async () => {
  const database = createDatabase();
  seedRace(database);
  seedRoundOneHeats(database);
  const env = { DB: d1(database) };
  const handle = (request) => handleHeatOperations(request, env, actor);
  const handleEvent = (request) => handleEventOperations(request, env, actor);

  await handleEvent(jsonRequest("/api/v1/staff/events/event/start-round-one", "POST", {
    commandId: commandId(),
  }));

  const detail = async (heatId) => (await (await handle(new Request(
    `https://quickducks.com/api/v1/staff/events/event/heats/${heatId}`,
  ))).json()).heat;
  const move = async (heatId, operation, revision) => {
    const response = await handle(jsonRequest(
      `/api/v1/staff/events/event/heats/${heatId}/${operation}`,
      "POST",
      { commandId: commandId(), revision },
    ));
    return { status: response.status, body: await response.json() };
  };

  let revision = (await detail("heat-1")).revision;
  revision = (await move("heat-1", "ready", revision)).body.heat.revision;
  revision = (await move("heat-1", "call", revision)).body.heat.revision;

  // Exactly what deleting a duck does to a paired participant: the assignment
  // closes and the roster entry is left untouched.
  database.exec(`
    UPDATE duck_assignments
       SET valid_to = '2026-07-26T11:00:00Z', end_reason = 'DUCK_DELETED'
     WHERE race_entry_id = 'entry-2'
  `);

  const blocked = await move("heat-1", "start", revision);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Every racer in this heat needs a duck/);
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-1'").get().status, "CALLING");
  // The racer is still in the heat: they are waiting for a duck, not removed.
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE race_entry_id = 'entry-2'").get().count,
    1,
  );

  // Another heat is unaffected, because the rule is about the heat being run.
  const otherRevision = (await detail("heat-2")).revision;
  const otherReady = await move("heat-2", "ready", otherRevision);
  assert.equal(otherReady.status, 201);

  // Pairing a replacement duck is the whole repair; the heat then starts.
  database.exec(`
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-replacement', 99, 'IN_USE', '2026-07-26T11:05:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-replacement', 'event', 'duck-replacement', '2026-07-26T11:05:00Z', 'staff');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
    VALUES ('replacement-command', 'event', 'ASSIGN_DUCK', 'assignment-replacement',
            '2026-07-26T11:05:00Z', '2026-07-26T11:05:00Z', 'staff');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES ('assignment-replacement', 'event', 'entry-2', 'event-duck-replacement', 'duck-replacement',
            '2026-07-26T11:05:00Z', 'staff', 'replacement-command');
  `);

  const started = await move("heat-1", "start", revision);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.heat.status, "RUNNING");
  // The roster reports the replacement duck, because the duck is resolved
  // through whichever assignment is open rather than stored on the entry.
  const roster = (await (await handle(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-1",
  ))).json()).roster;
  assert.equal(roster.find((entry) => entry.raceEntryId === "entry-2").duck.visibleNumber, 99);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

// A duck that has been paired is already inside a physical heat bag. If its
// racer then withdraws or is disqualified, nobody empties that bag on the bank
// to fish one duck out, so the duck keeps racing and can still reach the line
// first. The finish line must therefore treat scanning it as a normal, expected
// outcome — and must never move, renumber, or remove its heat entry to make the
// problem go away.
const seedAwaitingFinishHeat = (database) => {
  seedRace(database);
  seedRoundOneHeats(database);
  database.exec(`
    UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event';
    UPDATE heats
       SET status = 'AWAITING_RESULT', roster_locked_at = '2026-07-26T11:00:00Z',
           started_at = '2026-07-26T11:05:00Z', finished_at = '2026-07-26T11:10:00Z',
           revision = 5
     WHERE id = 'heat-1';
    UPDATE heats SET status = 'READY' WHERE id = 'heat-2';
  `);
  const tag = database.prepare(
    "INSERT INTO duck_tags (id, duck_id, token, status, activated_at) VALUES (?, ?, ?, 'ACTIVE', '2026-07-26T10:00:00Z')",
  );
  const tokens = {};
  for (let index = 1; index <= 6; index += 1) {
    tokens[`duck-${index}`] = String.fromCharCode(96 + index).repeat(32);
    tag.run(`tag-${index}`, `duck-${index}`, tokens[`duck-${index}`]);
  }
  return tokens;
};

const heatEntrySnapshot = (database) => database.prepare(
  `SELECT id, heat_id, race_entry_id, round, slot_number, assignment_source
     FROM heat_entries ORDER BY id`,
).all().map((row) => ({ ...row }));

const finishWriteSnapshot = (database) => ({
  results: database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count,
  commands: database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'FINALIZE_HEAT_RESULT'",
  ).get().count,
  heatRevision: database.prepare("SELECT revision, status FROM heats WHERE id = 'heat-1'").get().revision,
  heatStatus: database.prepare("SELECT status FROM heats WHERE id = 'heat-1'").get().status,
});

for (const status of ["WITHDRAWN", "DISQUALIFIED"]) {
  test(`the finish line reports a ${status} duck by tag URL and by number without touching its heat`, async (context) => {
    const database = createDatabase();
    context.after(() => database.close());
    const tokens = seedAwaitingFinishHeat(database);
    database.exec(`UPDATE registrations SET status = '${status}' WHERE id = 'registration-2'`);
    const env = { APP_ORIGIN: "https://quickducks.com", DB: d1(database) };
    const handle = (request) => handleHeatOperations(request, env, actor);

    const entriesBefore = heatEntrySnapshot(database);
    const writesBefore = finishWriteSnapshot(database);

    // Both resolution paths the station offers: the canonical tag URL a scan
    // produces, and the visible number a staffer can read off the duck.
    for (const value of [`https://quickducks.com/t/${tokens["duck-2"]}`, "2"]) {
      const response = await handle(new Request(
        "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value="
          + encodeURIComponent(value),
      ));
      assert.equal(response.status, 422, value);
      const body = await response.json();
      assert.equal(body.reason, FINISH_DUCK_INELIGIBLE_REASON, value);
      assert.deepEqual(body.ineligible, {
        raceEntryId: "entry-2",
        participantDisplayName: "Donald D.",
        visibleNumber: 2,
        registrationStatus: status,
      }, value);
      // Plain language: which duck, what it is, and what to do next.
      assert.match(body.error, /^Duck #2 · Donald D\. is (Withdrawn|Disqualified)/, value);
      assert.match(body.error, /scan the next duck to pass the finish line\.$/i, value);
      // No contact detail, lookup code, or tag token leaks into the refusal.
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes("CODE0002"), false, value);
      assert.equal(serialized.includes(tokens["duck-2"]), false, value);
    }

    // Confirming the same duck through the scanned-winner endpoint reports the
    // identical expected outcome instead of a bare "not the winner candidate".
    const confirmed = await handle(jsonRequest(
      `/api/v1/staff/ducks/${tokens["duck-2"]}/heat-winner`,
      "POST",
      {
        commandId: commandId(),
        eventId: "event",
        heatId: "heat-1",
        raceEntryId: "entry-2",
        revision: 5,
      },
    ));
    assert.equal(confirmed.status, 422);
    const confirmedBody = await confirmed.json();
    assert.equal(confirmedBody.reason, FINISH_DUCK_INELIGIBLE_REASON);
    assert.equal(confirmedBody.ineligible.registrationStatus, status);

    // Submitting them as the reviewed result names exactly which selection to
    // drop, with the same stable reason, so the station can stay armed.
    const submitted = await handle(jsonRequest(
      "/api/v1/staff/events/event/heats/heat-1/results/finalize",
      "POST",
      { commandId: commandId(), revision: 5, results: [{ raceEntryId: "entry-2", place: 1 }] },
    ));
    assert.equal(submitted.status, 422);
    const submittedBody = await submitted.json();
    assert.equal(submittedBody.reason, FINISH_DUCK_INELIGIBLE_REASON);
    assert.deepEqual(submittedBody.ineligibleRaceEntryIds, ["entry-2"]);

    // Nothing was written and, critically, no heat entry moved: the withdrawn
    // duck keeps its heat, its slot number, and its position among the others.
    assert.deepEqual(heatEntrySnapshot(database), entriesBefore);
    assert.deepEqual(finishWriteSnapshot(database), writesBefore);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

    // The station is not stuck: an ACTIVE duck in the same heat still resolves
    // and still records normally on the very next scan.
    const active = await handle(new Request(
      "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value="
        + encodeURIComponent(`https://quickducks.com/t/${tokens["duck-3"]}`),
    ));
    assert.equal(active.status, 200);
    assert.deepEqual((await active.json()).selection, {
      raceEntryId: "entry-3",
      participantDisplayName: "Della D.",
      visibleNumber: 3,
    });

    const recorded = await handle(jsonRequest(
      `/api/v1/staff/ducks/${tokens["duck-3"]}/heat-winner`,
      "POST",
      {
        commandId: commandId(),
        eventId: "event",
        heatId: "heat-1",
        raceEntryId: "entry-3",
        revision: 5,
      },
    ));
    assert.equal(recorded.status, 201, JSON.stringify(await recorded.clone().json()));
    assert.equal(
      database.prepare("SELECT race_entry_id FROM heat_results WHERE heat_id = 'heat-1'").get().race_entry_id,
      "entry-3",
    );
    // The withdrawn racer is still exactly where they were, in slot order,
    // after a winner was published around them.
    assert.deepEqual(
      database.prepare(
        "SELECT race_entry_id, slot_number FROM heat_entries WHERE heat_id = 'heat-1' ORDER BY slot_number",
      ).all().map((row) => ({ ...row })),
      [
        { race_entry_id: "entry-1", slot_number: 1 },
        { race_entry_id: "entry-2", slot_number: 2 },
        { race_entry_id: "entry-3", slot_number: 3 },
      ],
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("winnerByTagIneligible mirrors the candidate query and answers only for a real roster place", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const tokens = seedAwaitingFinishHeat(database);
  const env = { DB: d1(database) };

  // While the racer is ACTIVE, the duck is a candidate and never ineligible.
  assert.equal(await winnerByTagIneligible(env, tokens["duck-2"]), null, "active racer");
  assert.equal((await winnerByTagCandidate(env, tokens["duck-2"])).raceEntryId, "entry-2");

  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2'");
  assert.equal(await winnerByTagCandidate(env, tokens["duck-2"]), null, "withdrawn racer is no candidate");
  assert.deepEqual(await winnerByTagIneligible(env, tokens["duck-2"]), {
    eventId: "event",
    heatId: "heat-1",
    raceEntryId: "entry-2",
    heatNumber: 1,
    round: "ROUND_ONE",
    reason: FINISH_DUCK_INELIGIBLE_REASON,
    registrationStatus: "WITHDRAWN",
    visibleNumber: 2,
    participantDisplayName: "Donald D.",
  });

  // A withdrawn racer in a different heat, an unknown tag, and an unassigned
  // duck all stay null, exactly like the candidate query.
  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-5'");
  assert.equal(await winnerByTagIneligible(env, tokens["duck-5"]), null, "duck outside the awaiting heat");
  assert.equal(await winnerByTagIneligible(env, "z".repeat(32)), null, "unknown tag");
  assert.equal(await winnerByTagIneligible(env, "short"), null, "malformed token");
  database.exec(
    "UPDATE duck_assignments SET valid_to = '2026-07-26T11:20:00Z', end_reason = 'UNASSIGNED' WHERE id = 'assignment-2'",
  );
  assert.equal(await winnerByTagIneligible(env, tokens["duck-2"]), null, "duck no longer assigned");
});

// "Not eligible to win" and "left the race" are different sets, and only the
// second has a status word a staffer can act on. SUBMITTED is the state a racer
// is left in when their duck is deleted mid-race: they are waiting to be paired
// again, they were never withdrawn, and telling the finish line their duck
// cannot win because they are "Submitted" describes something that never
// happened. The strict candidate guard is unchanged — it still admits only
// ACTIVE — so nothing about who may be recorded as a winner moves here.
test("a racer who never left the race is not reported as withdrawn or disqualified", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const tokens = seedAwaitingFinishHeat(database);
  const env = { APP_ORIGIN: "https://quickducks.com", DB: d1(database) };

  database.exec("UPDATE registrations SET status = 'SUBMITTED' WHERE id = 'registration-2'");
  // Still not a winner candidate: winning requires ACTIVE and always will.
  assert.equal(await winnerByTagCandidate(env, tokens["duck-2"]), null, "SUBMITTED is no candidate");
  // But the "this racer left the race" projection does not claim them, so the
  // duck inspection page falls through to its generic refusal rather than
  // announcing a status word that is not theirs.
  assert.equal(await winnerByTagIneligible(env, tokens["duck-2"]), null, "SUBMITTED never left the race");

  const confirmed = await handleHeatOperations(jsonRequest(
    `/api/v1/staff/ducks/${tokens["duck-2"]}/heat-winner`,
    "POST",
    { commandId: commandId(), eventId: "event", heatId: "heat-1", raceEntryId: "entry-2", revision: 5 },
  ), env, actor);
  assert.equal(confirmed.status, 409, "the generic refusal, not the withdrawal outcome");
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.reason, undefined);
  assert.match(confirmedBody.error, /not the current winner candidate/);

  // The two statuses that do mean "left the race" are matched exactly as before.
  for (const status of ["WITHDRAWN", "DISQUALIFIED"]) {
    database.exec(`UPDATE registrations SET status = '${status}' WHERE id = 'registration-2'`);
    const ineligible = await winnerByTagIneligible(env, tokens["duck-2"]);
    assert.equal(ineligible?.registrationStatus, status, status);
    assert.equal(ineligible.reason, FINISH_DUCK_INELIGIBLE_REASON, status);
  }

  // The scan station still refuses every non-ACTIVE duck, because none of them
  // may be recorded — but the sentence names a status only when there is a true
  // one to name, rather than humanising whatever it was handed.
  database.exec("UPDATE registrations SET status = 'SUBMITTED' WHERE id = 'registration-2'");
  const scan = await handleHeatOperations(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value=2",
  ), env, actor);
  assert.equal(scan.status, 422);
  const scanBody = await scan.json();
  assert.equal(scanBody.reason, FINISH_DUCK_INELIGIBLE_REASON);
  assert.equal(scanBody.error.includes("Submitted"), false, "no invented status word");
  assert.match(scanBody.error, /^Duck #2 · Donald D\. is not an active racer and cannot be recorded as the winner\./);
  assert.match(scanBody.error, /scan the next duck to pass the finish line\.$/i);

  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2'");
  const withdrawnScan = await handleHeatOperations(new Request(
    "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value=2",
  ), env, actor);
  assert.match((await withdrawnScan.json()).error, /^Duck #2 · Donald D\. is Withdrawn and cannot be recorded/);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
});

test("the finish-line ineligible outcome is refused to roles that may not take results", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const tokens = seedAwaitingFinishHeat(database);
  database.exec("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = 'registration-2'");
  const env = { APP_ORIGIN: "https://quickducks.com", DB: d1(database) };

  for (const roles of [["ANNOUNCER"], ["HEAT_RUNNER"], ["REGISTRATION"], ["DUCK_MANAGER"], []]) {
    const reader = { ...actor, isSystemAdmin: false, roles };
    const scan = await handleHeatOperations(new Request(
      "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value=2",
    ), env, reader);
    assert.equal(scan.status, 403, roles.join(",") || "no roles");
    const confirm = await handleHeatOperations(jsonRequest(
      `/api/v1/staff/ducks/${tokens["duck-2"]}/heat-winner`,
      "POST",
      { commandId: commandId(), eventId: "event", heatId: "heat-1", raceEntryId: "entry-2", revision: 5 },
    ), env, reader);
    assert.equal(confirm.status, 403, roles.join(",") || "no roles");
  }

  // A result taker gets the expected-outcome answer, and an administrator
  // passes the same check implicitly.
  for (const permitted of [
    { ...actor, isSystemAdmin: false, roles: ["RESULT_TAKER"] },
    { ...actor, isSystemAdmin: true, roles: [] },
  ]) {
    const scan = await handleHeatOperations(new Request(
      "https://quickducks.com/api/v1/staff/events/event/heats/heat-1/finish-scan?value=2",
    ), env, permitted);
    assert.equal(scan.status, 422);
    assert.equal((await scan.json()).reason, FINISH_DUCK_INELIGIBLE_REASON);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
});
