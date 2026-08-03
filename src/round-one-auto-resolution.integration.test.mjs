// Automatic settling of Round One heats that can no longer be a contest,
// against the real migrated schema and the real Worker handlers.
//
// Every state these tests act on is reached the way race day reaches it: nine
// participants are paired through the real pairing route, registration closes
// and round one starts through the real lifecycle route, and racers leave
// through the real withdraw/disqualify routes with their real revisions. The
// only direct write is the one that models a *lost request* — a withdrawal that
// committed while the client that issued it never came back — because there is
// no other way to hold the application still in the middle of an interrupted
// mutation. That write is exactly the three columns the committed withdrawal
// batch writes, so the fixture is a state the application really produces.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";
import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";
import { handleParticipantOperations } from "./participant-operations.ts";
import { getPublicRaceBoard } from "./race-board.ts";
import { publicHeatStatusLabel } from "./race-status.ts";
import { handleStaffApi } from "./staff-api.ts";

const migrationNames = readdirSync(new URL("../db/migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const sqliteD1 = (database) => ({
  prepare(sql) {
    return {
      sql,
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        return database.prepare(this.sql).get(...this.args) ?? null;
      },
      async all() {
        return { results: database.prepare(this.sql).all(...this.args) };
      },
    };
  },
  async batch(items) {
    database.exec("BEGIN");
    try {
      const results = items.map((item) => {
        const result = database.prepare(item.sql).run(...item.args);
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

const director = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Race Director",
  isSystemAdmin: true,
  roles: ["RACE_DIRECTOR", "REGISTRATION", "HEAT_RUNNER", "RESULT_TAKER"],
  authentication: "bearer",
};

// Least privilege for the denial case: a real staff member with a real
// operational role that simply is not the one disqualification requires.
const announcer = {
  id: "staff_announcer",
  cognitoSub: "announcer-sub",
  email: "announcer@example.com",
  displayName: "Announcer",
  isSystemAdmin: false,
  roles: ["ANNOUNCER"],
  authentication: "bearer",
};

const LOOKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const lookupCodeFor = (index) => {
  let code = "";
  for (let position = 0; position < 8; position += 1) {
    code = LOOKUP_ALPHABET[(index >> (position * 2)) % LOOKUP_ALPHABET.length] + code;
  }
  return code;
};

const seed = (database, { ducksPerHeat = 3, participantCount = 9, optInIndexes = [] } = {}) => {
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('staff_test', 'staff-sub', 'staff@example.com', 'Race Director', 1, 1),
      ('staff_announcer', 'announcer-sub', 'announcer@example.com', 'Announcer', 0, 1);
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity)
    VALUES
      ('event_test', 'test-race', 'Test Duck Race', '2026-08-30', 'UTC',
       'REGISTRATION_OPEN', 'IMMEDIATE_FIXED', ${ducksPerHeat}, 50);
  `);
  const participants = [];
  const optedIn = new Set(optInIndexes);
  for (let index = 1; index <= participantCount; index += 1) {
    const lookupCode = lookupCodeFor(index);
    const token = `tag-token-${String(index).padStart(16, "0")}`;
    database.exec(`
      INSERT INTO registrations
        (id, event_id, first_name, last_name, email, email_notifications_enabled,
         status, lookup_code, private_token_hash, submitted_at, status_changed_at)
      VALUES
        ('registration-${index}', 'event_test', 'Racer', 'Number${index}',
         ${optedIn.has(index) ? `'racer${index}@example.test', 1` : "NULL, 0"}, 'SUBMITTED',
         '${lookupCode}', 'private-hash-${index}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
      INSERT INTO race_entries (id, event_id, registration_id)
      VALUES ('entry-${index}', 'event_test', 'registration-${index}');
      INSERT INTO ducks
        (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
      VALUES ('duck-${index}', ${100 + index}, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
      INSERT INTO duck_tags (id, duck_id, token, status)
      VALUES ('tag-${index}', 'duck-${index}', '${token}', 'ACTIVE');
    `);
    participants.push({
      index,
      lookupCode,
      token,
      registrationId: `registration-${index}`,
      raceEntryId: `entry-${index}`,
    });
  }
  return participants;
};

const pair = async (env, participant) => {
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${participant.token}/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        lookupCode: participant.lookupCode,
      }),
    }),
    env,
    director,
  );
  assert.equal(response.status, 201, `pair ${participant.lookupCode}: ${await response.clone().text()}`);
};

const lifecycle = (env, action, actor = director) => handleEventOperations(
  new Request(`https://quickducks.com/api/v1/staff/events/event_test/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID() }),
  }),
  env,
  actor,
);

const readiness = async (env) => {
  const response = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    env,
    director,
  );
  assert.equal(response.status, 200);
  return (await response.json()).readiness;
};

const registrationRevision = (database, registrationId) =>
  database.prepare("SELECT revision FROM registrations WHERE id = ?").get(registrationId).revision;

const changeStatus = (env, registrationId, operation, options = {}) => handleParticipantOperations(
  new Request(`https://quickducks.com/api/v1/staff/registrations/${registrationId}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: options.commandId ?? crypto.randomUUID(),
      expectedRevision: options.expectedRevision,
    }),
  }),
  env,
  options.actor ?? director,
);

const withdraw = async (env, database, registrationId, options = {}) => {
  const expectedRevision = options.expectedRevision
    ?? registrationRevision(database, registrationId);
  return changeStatus(env, registrationId, "withdraw", { ...options, expectedRevision });
};

// A withdrawal whose client never came back. The command, status, revision, and
// audit are exactly what the committed handler batch writes; what is missing is
// only the reconciliation that normally follows that batch in the same request.
const withdrawWithLostReconciliation = (database, registrationId) => {
  const now = "2026-08-30T12:00:00.000Z";
  const current = database.prepare(
    "SELECT event_id, status, revision FROM registrations WHERE id = ?",
  ).get(registrationId);
  assert.equal(current.status, "ACTIVE");
  const commandId = crypto.randomUUID();
  database.exec("BEGIN");
  try {
    database.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
       VALUES (?, ?, 'WITHDRAW_REGISTRATION', ?, ?, ?)`,
    ).run(commandId, current.event_id, registrationId, now, now);
    const changed = database.prepare(
      `UPDATE registrations
          SET status = 'WITHDRAWN', status_changed_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND status = 'ACTIVE'`,
    ).run(now, now, registrationId, current.revision);
    assert.equal(changed.changes, 1);
    database.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       VALUES (?, ?, ?, 'REGISTRATION_WITHDRAWN', 'REGISTRATION', ?, 'STAFF', ?, ?)`,
    ).run(
      crypto.randomUUID(),
      current.event_id,
      commandId,
      registrationId,
      now,
      JSON.stringify({
        staff_profile_id: director.id,
        previous_status: current.status,
        status: "WITHDRAWN",
        previous_revision: current.revision,
        revision: current.revision + 1,
      }),
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  assert.equal(
    database.prepare("SELECT status FROM registrations WHERE id = ?").get(registrationId).status,
    "WITHDRAWN",
  );
  return { commandId, expectedRevision: current.revision };
};

const heatRow = (database, heatNumber, round = "ROUND_ONE") => database.prepare(
  `SELECT id, status, revision, finalized_at,
          (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS entry_count
     FROM heats h
    WHERE h.event_id = 'event_test' AND h.round = ? AND h.heat_number = ?`,
).get(round, heatNumber);

const finalHeat = (database) => database.prepare(
  "SELECT id, status, heat_number FROM heats WHERE event_id = 'event_test' AND round = 'FINAL'",
).get() ?? null;

const finalRoster = (database) => database.prepare(
  `SELECT he.race_entry_id, he.slot_number, he.assignment_source
     FROM heat_entries he JOIN heats h ON h.id = he.heat_id
    WHERE he.event_id = 'event_test' AND h.round = 'FINAL'
    ORDER BY he.slot_number`,
).all().map((row) => ({
  raceEntryId: row.race_entry_id,
  slot: row.slot_number,
  source: row.assignment_source,
}));

const rosterOf = (database, heatNumber) => database.prepare(
  `SELECT he.race_entry_id, he.slot_number
     FROM heat_entries he JOIN heats h ON h.id = he.heat_id
    WHERE h.event_id = 'event_test' AND h.round = 'ROUND_ONE' AND h.heat_number = ?
    ORDER BY he.slot_number`,
).all(heatNumber).map((row) => `${row.slot_number}|${row.race_entry_id}`);

const resultsOf = (database, heatId) => database.prepare(
  `SELECT race_entry_id, place, status, revision
     FROM heat_results WHERE heat_id = ? ORDER BY place`,
).all(heatId);

const auditActions = (database, action) => database.prepare(
  "SELECT subject_id, details_json FROM audit_events WHERE action = ? ORDER BY occurred_at, id",
).all(action);

const notificationsFor = (database, registrationId) => database.prepare(
  `SELECT n.notification_type, n.lifecycle_key, n.result_revision, n.result_place,
          n.status, h.round, h.heat_number
     FROM email_notifications n LEFT JOIN heats h ON h.id = n.heat_id
    WHERE n.registration_id = ?
    ORDER BY n.notification_type, n.lifecycle_key`,
).all(registrationId).map((row) => ({ ...row }));

const eventStatus = (database) =>
  database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status;

const assertStructurallySound = (database) => {
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], "foreign keys stay clean");
  const duplicateFinalists = database.prepare(
    `SELECT event_id, round, race_entry_id, COUNT(*) AS count FROM heat_entries
      GROUP BY event_id, round, race_entry_id HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateFinalists, [], "a race entry is promoted into the final at most once");
  const duplicateSlots = database.prepare(
    `SELECT heat_id, slot_number, COUNT(*) AS count FROM heat_entries
      GROUP BY heat_id, slot_number HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateSlots, [], "slot numbers stay unique per heat");
  const duplicateWinners = database.prepare(
    `SELECT heat_id, place, COUNT(*) AS count FROM heat_results
      GROUP BY heat_id, place HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateWinners, [], "a heat publishes one duck per place");
};

// Runs a heat the ordinary way, end to end, so a test that needs the rest of
// round one settled never has to fake it.
const runHeatManually = async (env, database, heatNumber) => {
  for (const operation of ["ready", "call", "start", "finish"]) {
    const heat = heatRow(database, heatNumber);
    const response = await handleHeatOperations(
      new Request(`https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), revision: heat.revision }),
      }),
      env,
      director,
    );
    assert.equal(response.status, 201, `${operation} heat ${heatNumber}: ${await response.clone().text()}`);
  }
  const heat = heatRow(database, heatNumber);
  const winner = database.prepare(
    `SELECT he.race_entry_id
       FROM heat_entries he
       JOIN race_entries re ON re.id = he.race_entry_id
       JOIN registrations r ON r.id = re.registration_id AND r.status = 'ACTIVE'
      WHERE he.heat_id = ? ORDER BY he.slot_number LIMIT 1`,
  ).get(heat.id);
  const response = await handleHeatOperations(
    new Request(`https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/results/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        revision: heat.revision,
        results: [{ raceEntryId: winner.race_entry_id, place: 1 }],
      }),
    }),
    env,
    director,
  );
  assert.equal(response.status, 201, `finalize heat ${heatNumber}: ${await response.clone().text()}`);
  const recorded = await response.json();
  const confirmed = await handleHeatOperations(
    new Request(`https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/winner-announced`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), revision: recorded.heat.revision }),
    }),
    env,
    director,
  );
  assert.equal(
    confirmed.status,
    201,
    `confirm heat ${heatNumber} winner announced: ${await confirmed.clone().text()}`,
  );
  return winner.race_entry_id;
};

// Nine racers, three heats of three, round one under way and every heat still
// unstarted. Participants 1-3 are heat 1, 4-6 heat 2, 7-9 heat 3.
const setup = async (context, options) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const participants = seed(database, options);
  const queuedNotifications = [];
  const env = {
    DB: sqliteD1(database),
    EMAIL_QUEUE: { async send(notificationId) { queuedNotifications.push(notificationId); } },
  };
  for (const participant of participants) await pair(env, participant);
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  const started = await lifecycle(env, "start-round-one");
  assert.equal(started.status, 201, await started.clone().text());
  assert.equal(eventStatus(database), "ROUND_ONE");
  assert.equal(heatRow(database, 3).status, "LOADING");
  return { database, env, participants, queuedNotifications };
};

const heatThree = (participants) => participants.filter((participant) => participant.index >= 7);

test("two eligible racers left keeps the existing heat-running workflow", async (context) => {
  const { database, env, participants } = await setup(context);
  const roster = rosterOf(database, 3);
  const [first] = heatThree(participants);

  const response = await withdraw(env, database, first.registrationId);
  assert.equal(response.status, 201, await response.clone().text());

  const heat = heatRow(database, 3);
  assert.equal(heat.status, "LOADING", "a contest of two is still a race staff run themselves");
  assert.deepEqual(resultsOf(database, heat.id), []);
  assert.equal(finalHeat(database), null, "nobody is promoted while the heat can still be raced");
  // The withdrawal moved no roster row, exactly as before: the duck is sealed in
  // the heat 3 bag and stays there.
  assert.deepEqual(rosterOf(database, 3), roster);
  assert.deepEqual(auditActions(database, "ROUND_ONE_HEAT_SKIPPED"), []);
  assert.deepEqual(auditActions(database, "ROUND_ONE_HEAT_RESOLVED_UNCONTESTED"), []);
  assertStructurallySound(database);
});

test("one eligible racer left resolves the heat and promotes them to the final", async (context) => {
  const { database, env, participants } = await setup(context, { optInIndexes: [9] });
  const roster = rosterOf(database, 3);
  const [first, second, sole] = heatThree(participants);

  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);
  const response = await withdraw(env, database, second.registrationId);
  assert.equal(response.status, 201, await response.clone().text());

  const heat = heatRow(database, 3);
  assert.equal(heat.status, "FINALIZED");
  assert.notEqual(heat.finalized_at, null);
  assert.deepEqual(
    resultsOf(database, heat.id).map((row) => ({ raceEntryId: row.race_entry_id, place: row.place })),
    [{ raceEntryId: sole.raceEntryId, place: 1 }],
    "the only racer who could win is the winner, with no finish-line scan",
  );
  assert.equal(resultsOf(database, heat.id)[0].revision, 1);
  assert.deepEqual(notificationsFor(database, sole.registrationId).filter((row) =>
    ["FINAL_ASSIGNED", "ROUND_RESULT"].includes(row.notification_type)), [
    {
      notification_type: "FINAL_ASSIGNED",
      lifecycle_key: `assignment:${finalHeat(database).id}`,
      result_revision: null,
      result_place: null,
      status: "QUEUED",
      round: "FINAL",
      heat_number: 1,
    },
    {
      notification_type: "ROUND_RESULT",
      lifecycle_key: `result:${heat.id}:1`,
      result_revision: 1,
      result_place: 1,
      status: "QUEUED",
      round: "ROUND_ONE",
      heat_number: 3,
    },
  ]);
  // Promotion happened in the same settlement, into a final created for it.
  assert.equal(finalHeat(database).status, "PLANNED");
  assert.deepEqual(finalRoster(database), [
    { raceEntryId: sole.raceEntryId, slot: 1, source: "WINNER_PROMOTION" },
  ]);
  // The heat 3 bag is untouched: same entries, same slots, withdrawn racers and
  // their ducks still in it.
  assert.deepEqual(rosterOf(database, 3), roster);
  assert.equal(heatRow(database, 3).entry_count, 3);

  const audit = auditActions(database, "ROUND_ONE_HEAT_RESOLVED_UNCONTESTED");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, heat.id);
  assert.deepEqual(JSON.parse(audit[0].details_json), {
    staff_profile_id: "staff_test",
    heat_number: 3,
    race_entry_id: sole.raceEntryId,
    place: 1,
  });
  // Audit details carry identifiers and counts only, never participant data.
  assert.doesNotMatch(audit[0].details_json, /Racer|Number\d|tag-token/);
  assertStructurallySound(database);
});

test("a disqualification settles the heat exactly as a withdrawal does", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second, sole] = heatThree(participants);

  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);
  const response = await changeStatus(env, second.registrationId, "disqualify", {
    expectedRevision: registrationRevision(database, second.registrationId),
  });
  assert.equal(response.status, 201, await response.clone().text());

  assert.equal(heatRow(database, 3).status, "FINALIZED");
  assert.deepEqual(finalRoster(database).map((entry) => entry.raceEntryId), [sole.raceEntryId]);
  assertStructurallySound(database);
});

test("a retried withdrawal replays and cannot promote the same racer twice", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second, sole] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);

  const commandId = crypto.randomUUID();
  const expectedRevision = registrationRevision(database, second.registrationId);
  const original = await withdraw(env, database, second.registrationId, { commandId, expectedRevision });
  assert.equal(original.status, 201);

  // The same command, sent again by a client that never saw the first answer.
  const retry = await withdraw(env, database, second.registrationId, { commandId, expectedRevision });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).replayed, true);

  assert.deepEqual(finalRoster(database), [
    { raceEntryId: sole.raceEntryId, slot: 1, source: "WINNER_PROMOTION" },
  ]);
  assert.equal(resultsOf(database, heatRow(database, 3).id).length, 1);
  assert.equal(auditActions(database, "ROUND_ONE_HEAT_RESOLVED_UNCONTESTED").length, 1);
  // A third, unrelated reconciliation pass over an already settled heat is a
  // no-op rather than a second promotion.
  assert.equal((await lifecycle(env, "start-final")).status, 409);
  assert.deepEqual(finalRoster(database), [
    { raceEntryId: sole.raceEntryId, slot: 1, source: "WINNER_PROMOTION" },
  ]);
  assertStructurallySound(database);
});

test("a matching retry repairs a withdrawal committed before reconciliation", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, interrupted, sole] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);

  const committed = withdrawWithLostReconciliation(database, interrupted.registrationId);
  assert.equal(heatRow(database, 3).status, "LOADING", "the interrupted request has not settled the heat");
  assert.equal(finalHeat(database), null);

  const retry = await withdraw(env, database, interrupted.registrationId, committed);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).replayed, true);

  const heat = heatRow(database, 3);
  assert.equal(heat.status, "FINALIZED");
  assert.deepEqual(
    resultsOf(database, heat.id).map((row) => ({ raceEntryId: row.race_entry_id, place: row.place })),
    [{ raceEntryId: sole.raceEntryId, place: 1 }],
  );
  assert.deepEqual(finalRoster(database), [
    { raceEntryId: sole.raceEntryId, slot: 1, source: "WINNER_PROMOTION" },
  ]);
  assert.equal(auditActions(database, "ROUND_ONE_HEAT_RESOLVED_UNCONTESTED").length, 1);
  assertStructurallySound(database);
});

test("a stale revision changes nothing at all", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);

  const response = await withdraw(env, database, second.registrationId, { expectedRevision: 99 });
  assert.equal(response.status, 409);
  assert.equal(heatRow(database, 3).status, "LOADING");
  assert.equal(finalHeat(database), null);
  assert.deepEqual(resultsOf(database, heatRow(database, 3).id), []);
  assertStructurallySound(database);
});

test("a denied role settles nothing", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);

  const response = await changeStatus(env, second.registrationId, "disqualify", {
    actor: announcer,
    expectedRevision: registrationRevision(database, second.registrationId),
  });
  assert.equal(response.status, 403);
  assert.equal(
    database.prepare("SELECT status FROM registrations WHERE id = ?").get(second.registrationId).status,
    "ACTIVE",
  );
  assert.equal(heatRow(database, 3).status, "LOADING");
  assert.equal(finalHeat(database), null);
  assertStructurallySound(database);
});

test("cookie-authenticated wrong and missing origins cannot change status or settle a heat", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, target] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);
  const expectedRevision = registrationRevision(database, target.registrationId);
  const heat = heatRow(database, 3);
  const commandIds = [];
  const cookieDirector = { ...director, authentication: "cookie" };

  for (const origin of ["https://attacker.invalid", null]) {
    const commandId = crypto.randomUUID();
    commandIds.push(commandId);
    const headers = new Headers({ "content-type": "application/json" });
    if (origin !== null) headers.set("origin", origin);
    const response = await handleApi(
      new Request(`https://quickducks.com/api/v1/staff/registrations/${target.registrationId}/withdraw`, {
        method: "POST",
        headers,
        body: JSON.stringify({ commandId, expectedRevision }),
      }),
      { ...env, APP_ORIGIN: "https://quickducks.com" },
      async () => cookieDirector,
    );
    assert.equal(response.status, 403, origin ?? "missing Origin");
  }

  assert.equal(
    database.prepare("SELECT status FROM registrations WHERE id = ?").get(target.registrationId).status,
    "ACTIVE",
  );
  assert.equal(heatRow(database, 3).status, heat.status);
  assert.deepEqual(resultsOf(database, heat.id), []);
  assert.equal(finalHeat(database), null);
  for (const commandId of commandIds) {
    assert.equal(database.prepare("SELECT id FROM race_commands WHERE id = ?").get(commandId), undefined);
  }
  assert.deepEqual(auditActions(database, "ROUND_ONE_HEAT_SKIPPED"), []);
  assert.deepEqual(auditActions(database, "ROUND_ONE_HEAT_RESOLVED_UNCONTESTED"), []);
  assertStructurallySound(database);
});

test("no eligible racers left skips the heat, records no winner, and promotes nobody", async (context) => {
  const { database, env, participants } = await setup(context);
  const roster = rosterOf(database, 3);
  const [first, second, last] = heatThree(participants);

  // Two racers leave through requests whose clients never came back, so the heat
  // is standing at one eligible racer with nothing having settled it.
  withdrawWithLostReconciliation(database, first.registrationId);
  withdrawWithLostReconciliation(database, second.registrationId);
  assert.equal(heatRow(database, 3).status, "LOADING");

  // The third withdrawal is a normal request, and it is the one that discovers
  // there is nobody left who could win.
  const response = await withdraw(env, database, last.registrationId);
  assert.equal(response.status, 201, await response.clone().text());

  const heat = heatRow(database, 3);
  assert.equal(heat.status, "CANCELLED");
  assert.equal(heat.finalized_at, null);
  assert.deepEqual(resultsOf(database, heat.id), [], "a skipped heat records no winner");
  assert.equal(finalHeat(database), null, "a skipped heat promotes nobody");
  assert.deepEqual(rosterOf(database, 3), roster, "every duck stays in its bag, in its slot");

  const audit = auditActions(database, "ROUND_ONE_HEAT_SKIPPED");
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].details_json), {
    staff_profile_id: "staff_test",
    heat_number: 3,
    reason: "NO_ELIGIBLE_RACER",
  });
  assert.doesNotMatch(audit[0].details_json, /Racer|Number\d|tag-token/);
  assertStructurallySound(database);
});

test("skipping an empty first heat atomically marks the next heat upcoming", async (context) => {
  const { database, env, participants } = await setup(context, { optInIndexes: [4] });
  withdrawWithLostReconciliation(database, participants[0].registrationId);
  withdrawWithLostReconciliation(database, participants[1].registrationId);
  const response = await withdraw(env, database, participants[2].registrationId);
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(heatRow(database, 1).status, "CANCELLED");
  assert.deepEqual(notificationsFor(database, participants[3].registrationId).filter((row) =>
    row.notification_type === "HEAT_UPCOMING"), [{
    notification_type: "HEAT_UPCOMING",
    lifecycle_key: "run:1",
    result_revision: null,
    result_place: null,
    status: "QUEUED",
    round: "ROUND_ONE",
    heat_number: 2,
  }]);
  assertStructurallySound(database);
});

test("a skipped heat no longer blocks the final, and the race runs to completion", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second, last] = heatThree(participants);
  for (const participant of [first, second, last]) {
    withdrawWithLostReconciliation(database, participant.registrationId);
  }

  const heatOneWinner = await runHeatManually(env, database, 1);
  const heatTwoWinner = await runHeatManually(env, database, 2);

  // Round one is reported as ready to hand over even though heat 3 has not been
  // settled yet, with the settlement stated as a note rather than a blocker.
  const gate = await readiness(env);
  assert.equal(
    gate["start-final"].allowed,
    true,
    `start-final blocked: ${JSON.stringify(gate["start-final"].blockers)}`,
  );
  assert.deepEqual(gate["start-final"].notes, [
    "1 round-one heat can no longer be a contest. Starting the final settles it automatically: "
    + "a heat with nobody left to win is skipped with no winner, and a heat with one racer left "
    + "sends that duck straight to the final. Every duck stays in its bag.",
  ]);

  const started = await lifecycle(env, "start-final");
  assert.equal(started.status, 201, await started.clone().text());
  assert.equal(eventStatus(database), "FINAL");
  assert.equal(heatRow(database, 3).status, "CANCELLED");
  assert.deepEqual(resultsOf(database, heatRow(database, 3).id), []);
  assert.deepEqual(
    finalRoster(database).map((entry) => entry.raceEntryId),
    [heatOneWinner, heatTwoWinner],
  );
  assert.equal(finalHeat(database).status, "LOADING", "starting the final locked its roster");

  // The public projection contains the actual skipped heat (not merely a static
  // label assertion), keeps its authoritative CANCELLED state, and omits every
  // participant who left without making the heat itself disappear.
  const board = await getPublicRaceBoard(env);
  const skipped = board.event.roundOneHeats.find((candidate) => candidate.number === 3);
  assert.equal(skipped.status, "CANCELLED");
  assert.deepEqual(skipped.roster, []);
  assert.equal(publicHeatStatusLabel(skipped.status), "Not running");

  // The staff verification projection counts a skipped heat as settled rather
  // than as a round that never finished.
  const verification = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/finalists/verification"),
    env,
    director,
  );
  assert.equal(verification.status, 200);
  const summary = (await verification.json()).verification;
  assert.equal(summary.verified, true, "a skipped heat counts as settled, not as a round that never finished");
  assert.equal(summary.roundOneHeats, 3);
  assert.equal(summary.finalizedRoundOneHeats, 2);
  assert.equal(summary.publishedWinners, 2);
  assert.equal(summary.finalists, 2);
  assertStructurallySound(database);
});

test("an uncontested heat left unsettled is resolved when the final is started", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second, sole] = heatThree(participants);
  withdrawWithLostReconciliation(database, first.registrationId);
  withdrawWithLostReconciliation(database, second.registrationId);

  const heatOneWinner = await runHeatManually(env, database, 1);
  const heatTwoWinner = await runHeatManually(env, database, 2);
  assert.equal(heatRow(database, 3).status, "LOADING", "the lost request settled nothing");

  const started = await lifecycle(env, "start-final");
  assert.equal(started.status, 201, await started.clone().text());
  assert.equal(heatRow(database, 3).status, "FINALIZED");
  assert.deepEqual(
    resultsOf(database, heatRow(database, 3).id).map((row) => row.race_entry_id),
    [sole.raceEntryId],
  );
  assert.deepEqual(
    finalRoster(database).map((entry) => entry.raceEntryId),
    [heatOneWinner, heatTwoWinner, sole.raceEntryId],
  );
  assertStructurallySound(database);
});

test("the public race board publishes an uncontested winner", async (context) => {
  const { database, env, participants } = await setup(context);
  const [first, second, sole] = heatThree(participants);
  assert.equal((await withdraw(env, database, first.registrationId)).status, 201);
  assert.equal((await withdraw(env, database, second.registrationId)).status, 201);

  const board = await getPublicRaceBoard(env);
  const settled = board.event.roundOneHeats.find((heat) => heat.number === 3);
  assert.equal(settled.status, "FINALIZED");
  // The two racers who left are publicly absent; the winner is published with
  // their place, exactly as a scanned winner would have been.
  assert.deepEqual(settled.roster.map((entry) => entry.place), [1]);
  assert.equal(board.event.finalHeats.length, 1);
  assert.equal(board.event.finalHeats[0].roster.length, 1);

  assert.equal(publicHeatStatusLabel("CANCELLED"), "Not running");
  assert.equal(publicHeatStatusLabel("FINALIZED"), "Result official");
  assertStructurallySound(database);
});
