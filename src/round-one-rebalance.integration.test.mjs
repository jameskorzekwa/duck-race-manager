// Round-one heat rebalancing against the real migrated schema.
//
// Heats are built as participants are paired, and pairing keeps running while
// registration is closed, so a close/reopen cycle can leave more than one short
// heat. These tests drive the real pairing handler and the real lifecycle
// handler so the merge on close, the split on reopen, the automatic roster
// lock, and the minimum-heat-size blocker are all exercised against the
// production triggers, foreign keys, and uniqueness constraints.
//
// Every rebalance case ends by proving the layout it produced can actually
// race: `assertRoundOneStarts` requires readiness to report no blocker and the
// guarded start command to commit. A rebalance that merely moves rows around
// but strands an unrunnable heat fails there.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";
import { handleParticipantOperations } from "./participant-operations.ts";
import { handleStaffApi } from "./staff-api.ts";

const migrationNames = readdirSync(new URL("../db/migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const sqliteD1 = (database, beforeBatch = () => {}) => ({
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
    beforeBatch();
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

// Lookup codes use the ambiguity-free alphabet the pairing route enforces.
const LOOKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LATE_LOOKUP_CODE = "LATEDUCK";
const LATE_TOKEN = "tag-token-late-signup";
const lookupCodeFor = (index) => {
  let code = "";
  for (let position = 0; position < 8; position += 1) {
    code = LOOKUP_ALPHABET[(index >> (position * 2)) % LOOKUP_ALPHABET.length] + code;
  }
  return code;
};

const seed = (database, { ducksPerHeat, participantCount, finalHeatCapacity = 50 }) => {
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES ('staff_test', 'staff-sub', 'staff@example.com', 'Race Director', 1, 1);
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity)
    VALUES
      ('event_test', 'test-race', 'Test Duck Race', '2026-08-30', 'UTC',
       'REGISTRATION_OPEN', 'IMMEDIATE_FIXED', ${ducksPerHeat}, ${finalHeatCapacity});
  `);
  const participants = [];
  for (let index = 1; index <= participantCount; index += 1) {
    const lookupCode = lookupCodeFor(index);
    const token = `tag-token-${String(index).padStart(16, "0")}`;
    database.exec(`
      INSERT INTO registrations
        (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
         submitted_at, status_changed_at)
      VALUES
        ('registration-${index}', 'event_test', 'Racer', 'Number${index}', 'SUBMITTED',
         '${lookupCode}', 'private-hash-${index}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
      INSERT INTO race_entries (id, event_id, registration_id)
      VALUES ('entry-${index}', 'event_test', 'registration-${index}');
      INSERT INTO ducks
        (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
      VALUES ('duck-${index}', ${index}, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
      INSERT INTO duck_tags (id, duck_id, token, status)
      VALUES ('tag-${index}', 'duck-${index}', '${token}', 'ACTIVE');
    `);
    participants.push({ lookupCode, token, raceEntryId: `entry-${index}` });
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
  return response.json();
};

const lifecycle = (env, action) => handleEventOperations(
  new Request(`https://quickducks.com/api/v1/staff/events/event_test/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID() }),
  }),
  env,
  director,
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

const heatLayout = (database) => database.prepare(
  `SELECT h.heat_number, h.status, h.target_size, h.roster_locked_at,
          (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS entry_count
     FROM heats h
    WHERE h.event_id = 'event_test' AND h.round = 'ROUND_ONE'
    ORDER BY h.heat_number`,
).all().map((row) => ({
  number: row.heat_number,
  status: row.status,
  targetSize: row.target_size,
  locked: row.roster_locked_at !== null,
  size: row.entry_count,
}));

const rosterOf = (database, heatNumber) => database.prepare(
  `SELECT he.race_entry_id, he.slot_number
     FROM heat_entries he JOIN heats h ON h.id = he.heat_id
    WHERE h.event_id = 'event_test' AND h.round = 'ROUND_ONE' AND h.heat_number = ?
    ORDER BY he.slot_number`,
).all(heatNumber).map((row) => ({ raceEntryId: row.race_entry_id, slot: row.slot_number }));

// Slot numbers must stay contiguous from one in every heat, because pairing
// computes the next slot as COUNT(*) + 1 and would otherwise collide with
// UNIQUE (heat_id, slot_number).
const assertStructurallySound = (database) => {
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], "foreign keys stay clean");
  const duplicateSlots = database.prepare(
    `SELECT heat_id, slot_number, COUNT(*) AS count FROM heat_entries
      GROUP BY heat_id, slot_number HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateSlots, [], "slot numbers stay unique per heat");
  const duplicateEntries = database.prepare(
    `SELECT event_id, round, race_entry_id, COUNT(*) AS count FROM heat_entries
      GROUP BY event_id, round, race_entry_id HAVING COUNT(*) > 1`,
  ).all();
  assert.deepEqual(duplicateEntries, [], "a race entry appears in one heat per round");
  const gaps = database.prepare(
    `SELECT heat_id FROM heat_entries GROUP BY heat_id
      HAVING MIN(slot_number) != 1 OR MAX(slot_number) != COUNT(*)`,
  ).all();
  assert.deepEqual(gaps, [], "slot numbers stay contiguous from one");
};

const eventStatus = (database) =>
  database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status;

// A late sign-up, seeded the same way `seed` does, so a test can pair one more
// participant part way through a lifecycle cycle. Lookup codes stay inside the
// ambiguity-free alphabet the pairing route enforces.
const addLateParticipant = (database, index) => {
  const lookupCode = `LATEDUC${LOOKUP_ALPHABET[index]}`;
  const token = `tag-token-late-${index}`;
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration-late-${index}', 'event_test', 'Late', 'Duck${index}', 'SUBMITTED',
            '${lookupCode}', 'private-hash-late-${index}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-late-${index}', 'event_test', 'registration-late-${index}');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck-late-${index}', ${900 + index}, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO duck_tags (id, duck_id, token, status)
    VALUES ('tag-late-${index}', 'duck-late-${index}', '${token}', 'ACTIVE');
  `);
  return { lookupCode, token, raceEntryId: `entry-late-${index}` };
};

const withdraw = (env, registrationId, revision) => handleParticipantOperations(
  new Request(`https://quickducks.com/api/v1/staff/registrations/${registrationId}/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision: revision }),
  }),
  env,
  director,
);

const replaceRoster = (env, heatId, revision, raceEntryIds) => handleHeatOperations(
  new Request(`https://quickducks.com/api/v1/staff/events/event_test/heats/${heatId}/roster`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), revision, raceEntryIds }),
  }),
  env,
  director,
);

const heatRow = (database, heatNumber) => database.prepare(
  `SELECT id, revision FROM heats
    WHERE event_id = 'event_test' AND round = 'ROUND_ONE' AND heat_number = ?`,
).get(heatNumber);

// The point of rebalancing is a layout round one can actually run, so every
// rebalance case ends here: readiness reports no blocker AND the guarded start
// command commits. A layout that merely looks balanced but leaves a heat below
// the minimum fails this, which is exactly what a single-pass merge produced.
const assertRoundOneStarts = async (env, database) => {
  if (eventStatus(database) === "REGISTRATION_OPEN") {
    assert.equal((await lifecycle(env, "close-registration")).status, 201);
  }
  const gate = await readiness(env);
  assert.equal(
    gate["start-round-one"].allowed,
    true,
    `start-round-one blocked: ${JSON.stringify(gate["start-round-one"].blockers)}`,
  );
  const started = await lifecycle(env, "start-round-one");
  assert.equal(started.status, 201, await started.clone().text());
  assert.equal(eventStatus(database), "ROUND_ONE");
  // Every round-one heat is raceable and locked, with no leftover short heat.
  for (const heat of heatLayout(database)) {
    assert.ok(heat.size >= 3, `heat ${heat.number} raced with ${heat.size} ducks`);
    assert.equal(heat.locked, true);
    assert.equal(heat.status, "LOADING");
  }
  assertStructurallySound(database);
};

const setup = async (context, options, beforeBatch) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const participants = seed(database, options);
  const pairingEnv = { DB: sqliteD1(database) };
  for (const participant of participants) await pair(pairingEnv, participant);
  const env = beforeBatch === undefined ? pairingEnv : { DB: sqliteD1(database, beforeBatch) };
  return { database, env, participants };
};

test("closing registration merges a one-duck tail heat into the heat before it", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 5 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 1]);

  const closed = await lifecycle(env, "close-registration");
  assert.equal(closed.status, 201, await closed.clone().text());

  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 4, locked: false, size: 5 },
  ]);
  assert.deepEqual(rosterOf(database, 1).map((entry) => entry.slot), [1, 2, 3, 4, 5]);
  assertStructurallySound(database);

  const audit = database.prepare(
    "SELECT action, details_json FROM audit_events WHERE action = 'ROUND_ONE_TAIL_MERGED'",
  ).all();
  assert.equal(audit.length, 1);
  const details = JSON.parse(audit[0].details_json);
  assert.deepEqual(
    { ...details, command_id: typeof details.command_id },
    {
      staff_profile_id: "staff_test",
      command_id: "string",
      merged_heat_number: 2,
      into_heat_number: 1,
      moved_entry_count: 1,
      resulting_roster_size: 5,
    },
  );
  // Audit details carry heat numbers and counts only, never participant data.
  assert.doesNotMatch(audit[0].details_json, /Racer|Number|DUCK000|entry-/);
  await assertRoundOneStarts(env, database);
});

test("closing registration merges a two-duck tail heat and reopening splits it back out", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 12 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 2]);
  const tailBefore = rosterOf(database, 2);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 10, locked: false, size: 12 },
  ]);
  assert.deepEqual(rosterOf(database, 1).slice(10), [
    { raceEntryId: tailBefore[0].raceEntryId, slot: 11 },
    { raceEntryId: tailBefore[1].raceEntryId, slot: 12 },
  ]);
  assertStructurallySound(database);

  // Reopening restores exactly the pre-close layout, including the tail roster.
  const reopened = await lifecycle(env, "reopen-registration");
  assert.equal(reopened.status, 201, await reopened.clone().text());
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 10, locked: false, size: 10 },
    { number: 2, status: "PLANNED", targetSize: 10, locked: false, size: 2 },
  ]);
  assert.deepEqual(rosterOf(database, 2), tailBefore);
  assertStructurallySound(database);

  // The restored layout closes back down to a runnable one.
  await assertRoundOneStarts(env, database);
});

test("a close, reopen, one more registration, and close cycle converges on a three-duck heat", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 12 });

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [12]);
  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 2]);

  // One late sign-up joins the split-out tail rather than opening a new heat.
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration-late', 'event_test', 'Late', 'Duck', 'SUBMITTED',
            '${LATE_LOOKUP_CODE}', 'private-hash-late', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-late', 'event_test', 'registration-late');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck-late', 900, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO duck_tags (id, duck_id, token, status)
    VALUES ('tag-late', 'duck-late', '${LATE_TOKEN}', 'ACTIVE');
  `);
  const paired = await pair(env, { lookupCode: LATE_LOOKUP_CODE, token: LATE_TOKEN });
  assert.equal(paired.heat.number, 2);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 3]);

  // A three-duck tail is raceable, so the second close leaves it alone.
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 10, locked: false, size: 10 },
    { number: 2, status: "PLANNED", targetSize: 10, locked: false, size: 3 },
  ]);
  assertStructurallySound(database);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ROUND_ONE_TAIL_MERGED'").get().count,
    1,
  );

  await assertRoundOneStarts(env, database);
});

test("a lone short heat cannot merge and blocks round one until registration reopens", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 2 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [2]);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  // There is no earlier heat to merge into, so the single heat is untouched.
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 10, locked: false, size: 2 },
  ]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ROUND_ONE_TAIL_MERGED'").get().count,
    0,
  );
  assertStructurallySound(database);

  const gate = await readiness(env);
  assert.equal(gate["start-round-one"].allowed, false);
  assert.deepEqual(gate["start-round-one"].blockers, [
    "A heat cannot be raced with fewer than 3 ducks. Reopen registration and sign up more participants.",
  ]);
  // The remedy the blocker names is available.
  assert.equal(gate["reopen-registration"].allowed, true);

  const blocked = await lifecycle(env, "start-round-one");
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).readiness.blockers[0], /fewer than 3 ducks/);
  assert.equal(
    database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status,
    "REGISTRATION_CLOSED",
  );

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.equal(
    database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status,
    "REGISTRATION_OPEN",
  );

  // Taking the remedy makes the race runnable: one more sign-up fills the lone
  // heat to the minimum, and the next close leaves it exactly there.
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration-late', 'event_test', 'Late', 'Duck', 'SUBMITTED',
            '${LATE_LOOKUP_CODE}', 'private-hash-late', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-late', 'event_test', 'registration-late');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck-late', 900, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO duck_tags (id, duck_id, token, status)
    VALUES ('tag-late', 'duck-late', '${LATE_TOKEN}', 'ACTIVE');
  `);
  await pair(env, { lookupCode: LATE_LOOKUP_CODE, token: LATE_TOKEN });
  await assertRoundOneStarts(env, database);
});

test("reopening registration is allowed with heats present and refused once round one starts", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  const closedGate = await readiness(env);
  assert.equal(closedGate["reopen-registration"].allowed, true, "heats existing never blocks a reopen");
  assert.deepEqual(closedGate["reopen-registration"].blockers, []);

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  await assertRoundOneStarts(env, database);
  const startedGate = await readiness(env);
  assert.equal(startedGate["reopen-registration"].allowed, false);
  assert.deepEqual(startedGate["reopen-registration"].blockers, [
    "Event status must be REGISTRATION_CLOSED.",
    "Heat rosters are already locked for racing, so registration can no longer reopen.",
  ]);
  const refused = await lifecycle(env, "reopen-registration");
  assert.equal(refused.status, 409);
  assert.equal(
    database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status,
    "ROUND_ONE",
  );
});

test("starting round one locks every roster without a manual lock step", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 7 });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  // 3 + 3 + 1 merges to 3 + 4.
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 4]);

  assert.equal((await lifecycle(env, "start-round-one")).status, 201);
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "LOADING", targetSize: 3, locked: true, size: 3 },
    { number: 2, status: "LOADING", targetSize: 3, locked: true, size: 4 },
  ]);
  assert.deepEqual(
    database.prepare(
      "SELECT DISTINCT roster_locked_by_staff_profile_id AS staff FROM heats WHERE event_id = 'event_test'",
    ).all().map((row) => row.staff),
    ["staff_test"],
  );
  assertStructurallySound(database);

  // A locked roster is immovable: the schema trigger, not just the handler,
  // refuses further roster edits.
  const heatId = database.prepare(
    "SELECT id FROM heats WHERE event_id = 'event_test' AND heat_number = 1",
  ).get().id;
  assert.throws(
    () => database.prepare("DELETE FROM heat_entries WHERE heat_id = ?").run(heatId),
    /heat roster is locked/,
  );

  const audit = database.prepare(
    "SELECT details_json FROM audit_events WHERE action = 'HEAT_ROSTERS_LOCKED'",
  ).all();
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].details_json).round, "ROUND_ONE");

  // The heats are already past PLANNED, so the round is ready to run straight
  // from LOADING without any operator lock action.
  const heats = await handleHeatOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/heats"),
    env,
    director,
  );
  assert.equal(heats.status, 200);
  const listed = (await heats.json()).heats.filter((heat) => heat.round === "ROUND_ONE");
  assert.deepEqual(listed.map((heat) => heat.status), ["LOADING", "LOADING"]);
  assert.deepEqual(listed.map((heat) => heat.rosterLocked), [true, true]);
  // Every locked heat is one the round could legally start with.
  for (const heat of listed) assert.ok(heat.rosterSize >= 3);
});

test("a merged tail splits back out even when pairing opened a new heat after the close", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 5 });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5]);

  // Pairing stays open through REGISTRATION_CLOSED, and heat one is full, so a
  // late pairing opens a fresh heat behind the merged one. The merge marker is
  // the heat's own target_size, so it survives that.
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('registration-late', 'event_test', 'Late', 'Duck', 'SUBMITTED',
            '${LATE_LOOKUP_CODE}', 'private-hash-late', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-late', 'event_test', 'registration-late');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck-late', 900, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO duck_tags (id, duck_id, token, status)
    VALUES ('tag-late', 'duck-late', '${LATE_TOKEN}', 'ACTIVE');
  `);
  await pair(env, { lookupCode: LATE_LOOKUP_CODE, token: LATE_TOKEN });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5, 1]);

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.deepEqual(heatLayout(database), [
    { number: 1, status: "PLANNED", targetSize: 4, locked: false, size: 4 },
    { number: 2, status: "PLANNED", targetSize: 4, locked: false, size: 1 },
    { number: 3, status: "PLANNED", targetSize: 4, locked: false, size: 1 },
  ]);
  assertStructurallySound(database);

  // Closing again folds the tail into the heat before it, and because that
  // leaves a two-duck heat the loop folds once more rather than stopping on a
  // layout round one would refuse forever. The totals survive the whole cycle.
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [6]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE event_id = 'event_test'").get().count,
    6,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ROUND_ONE_TAIL_MERGED'",
    ).get().count,
    3,
    "each fold is audited on its own",
  );
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

test("a merge and a split replay their lifecycle command without moving entries twice", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 5 });
  const commandId = crypto.randomUUID();
  const close = () => handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/close-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId }),
    }),
    env,
    director,
  );

  assert.equal((await close()).status, 201);
  const merged = heatLayout(database);
  assert.deepEqual(merged.map((heat) => heat.size), [5]);

  const replay = await close();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.deepEqual(heatLayout(database), merged, "a replayed close moves nothing again");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ROUND_ONE_TAIL_MERGED'").get().count,
    1,
  );
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

// ---------------------------------------------------------------------------
// The transition reports what has to happen to the physical bags
// ---------------------------------------------------------------------------
//
// The pairing screen names a bag in the largest type on the page. A fold moves
// an already-paired duck's entry into a different heat, so if the transition
// said nothing the bags on the table would quietly stop matching the rosters.
// The response therefore reports which heat was folded into which, with the
// numbers printed on the ducks that moved, and the reverse for a split.

test("closing registration reports the fold, and reopening reports the split, in bag terms", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 5 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 1]);
  // Duck 5 is the one duck in the tail heat, so it is the one that moves.
  assert.deepEqual(rosterOf(database, 2).map((entry) => entry.raceEntryId), ["entry-5"]);

  const closed = await lifecycle(env, "close-registration");
  assert.equal(closed.status, 201);
  const closedBody = await closed.json();
  assert.deepEqual(closedBody.bagMoves, [{
    action: "MERGE",
    fromHeatNumber: 2,
    intoHeatNumber: 1,
    duckNumbers: [5],
    movedEntryCount: 1,
  }]);
  // The move it reports is the move it made.
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5]);

  const reopened = await lifecycle(env, "reopen-registration");
  assert.equal(reopened.status, 201);
  assert.deepEqual((await reopened.json()).bagMoves, [{
    action: "SPLIT",
    fromHeatNumber: 1,
    intoHeatNumber: 2,
    duckNumbers: [5],
    movedEntryCount: 1,
  }]);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 1]);
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

test("a two-pass fold reports both bag moves, in the order the staff must perform them", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 11 });

  const firstClose = await lifecycle(env, "close-registration");
  assert.equal(firstClose.status, 201);
  assert.deepEqual((await firstClose.json()).bagMoves, [{
    action: "MERGE",
    fromHeatNumber: 2,
    intoHeatNumber: 1,
    duckNumbers: [11],
    movedEntryCount: 1,
  }]);

  // A late pairing opens a fresh heat behind the merged one, so the reopen
  // leaves 10 + 1 + 1 and the next close has to fold twice.
  const late = addLateParticipant(database, 1);
  assert.equal((await pair(env, late)).heat.number, 2);
  const reopened = await lifecycle(env, "reopen-registration");
  assert.equal(reopened.status, 201);
  assert.deepEqual((await reopened.json()).bagMoves, [{
    action: "SPLIT",
    fromHeatNumber: 1,
    intoHeatNumber: 3,
    duckNumbers: [11],
    movedEntryCount: 1,
  }]);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 1, 1]);

  // Heat 3 is poured into heat 2 first, then heat 2 into heat 1. Following the
  // list in the other order would put the wrong ducks in the wrong bag.
  const secondClose = await lifecycle(env, "close-registration");
  assert.equal(secondClose.status, 201);
  assert.deepEqual((await secondClose.json()).bagMoves, [
    { action: "MERGE", fromHeatNumber: 3, intoHeatNumber: 2, duckNumbers: [11], movedEntryCount: 1 },
    { action: "MERGE", fromHeatNumber: 2, intoHeatNumber: 1, duckNumbers: [901, 11], movedEntryCount: 2 },
  ]);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [12]);
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

test("a transition that moves no duck between bags reports no bag move at all", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 });

  const closed = await lifecycle(env, "close-registration");
  assert.equal(closed.status, 201);
  assert.deepEqual((await closed.json()).bagMoves, []);

  const reopened = await lifecycle(env, "reopen-registration");
  assert.equal(reopened.status, 201);
  assert.deepEqual((await reopened.json()).bagMoves, []);

  const opened = await lifecycle(env, "close-registration");
  assert.equal(opened.status, 201);
  assert.deepEqual((await opened.json()).bagMoves, []);

  const started = await lifecycle(env, "start-round-one");
  assert.equal(started.status, 201);
  assert.deepEqual((await started.json()).bagMoves, []);
  assertStructurallySound(database);
});

test("a replayed close reports no bag move, because the bags were already moved once", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 5 });
  const commandId = crypto.randomUUID();
  const close = () => handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/close-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId }),
    }),
    env,
    director,
  );

  const first = await close();
  assert.equal(first.status, 201);
  assert.equal((await first.json()).bagMoves.length, 1);

  const replay = await close();
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  // The instruction is a physical task, and it was already given. Reporting it
  // again on a retry would ask a staffer to pour an already-poured bag.
  assert.deepEqual(replayBody.bagMoves, []);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5]);
  assertStructurallySound(database);
});

test("reopening a close that merged nothing leaves every heat untouched", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  const closed = heatLayout(database);

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.deepEqual(heatLayout(database), closed);
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action IN ('ROUND_ONE_TAIL_MERGED', 'ROUND_ONE_TAIL_SPLIT')",
    ).get().count,
    0,
  );
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

test("the atomic round-one start refuses a heat that drops below the minimum after preflight", async (context) => {
  let shrunk = false;
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 }, () => {
    // Fire once, on the round-one start batch, after its readiness preflight
    // has already passed, so only the guarded SQL inside the batch can still
    // catch the short heat.
    if (shrunk) return;
    if (database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status !== "REGISTRATION_CLOSED") return;
    shrunk = true;
    database.exec(`
      DELETE FROM heat_entries
       WHERE id = (
         SELECT he.id FROM heat_entries he JOIN heats h ON h.id = he.heat_id
          WHERE h.event_id = 'event_test' AND h.heat_number = 2
          ORDER BY he.slot_number DESC LIMIT 1
       );
    `);
  });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);

  const blocked = await lifecycle(env, "start-round-one");
  assert.equal(blocked.status, 409);
  assert.equal(
    database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status,
    "REGISTRATION_CLOSED",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_ROUND_ONE'").get().count,
    0,
  );
  // Nothing was locked, so registration can still reopen as the remedy.
  assert.deepEqual(heatLayout(database).map((heat) => heat.locked), [false, false]);
  assertStructurallySound(database);

  // The remedy is reachable in this very state: registration is closed and the
  // heats are still unlocked plans, which is exactly the window the roster
  // editor accepts, so putting the dropped racer back makes the round start.
  const orphaned = database.prepare(
    `SELECT re.id FROM race_entries re
       JOIN registrations r ON r.id = re.registration_id
      WHERE re.event_id = 'event_test' AND r.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM heat_entries he
           WHERE he.race_entry_id = re.id AND he.round = 'ROUND_ONE'
        )`,
  ).all().map((row) => row.id);
  assert.equal(orphaned.length, 1);
  const heat = heatRow(database, 2);
  const repaired = await replaceRoster(
    env,
    heat.id,
    heat.revision,
    [...rosterOf(database, 2).map((entry) => entry.raceEntryId), ...orphaned],
  );
  assert.equal(repaired.status, 200, await repaired.clone().text());
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);
  await assertRoundOneStarts(env, database);
});

// ---------------------------------------------------------------------------
// Close/reopen cycles
// ---------------------------------------------------------------------------

// The exact sequence that used to strand a race: pairing continues while
// registration is closed, so the reopen's split lands a heat behind a heat that
// is already short, and a single-pass merge then converges on 10 + 2 forever.
test("a close, late pairing, and reopen cycle still converges on a runnable layout", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 11 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 1]);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [11]);

  // Pairing stays open through REGISTRATION_CLOSED, and heat one is full at
  // capacity, so this opens a fresh short heat behind the merged one.
  const late = addLateParticipant(database, 1);
  assert.equal((await pair(env, late)).heat.number, 2);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [11, 1]);

  // The reopen gives heat one its borrowed slot back, which leaves two short
  // heats in a row: 10 + 1 + 1.
  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [10, 1, 1]);
  assertStructurallySound(database);

  // Closing again folds twice, not once, so no heat is left below the minimum.
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [12]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE event_id = 'event_test'").get().count,
    12,
  );
  assertStructurallySound(database);
  await assertRoundOneStarts(env, database);
});

test("repeated close and reopen cycles never strand an unrunnable layout", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 10, participantCount: 11 });

  // Three full cycles, each adding one late pairing while registration is
  // closed, which is the state that produced a new short heat every time.
  for (const index of [1, 2, 3]) {
    assert.equal((await lifecycle(env, "close-registration")).status, 201);
    await pair(env, addLateParticipant(database, index));
    assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
    assertStructurallySound(database);
    // No entry is ever lost or duplicated across a cycle.
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE event_id = 'event_test'").get().count,
      11 + index,
    );
  }

  await assertRoundOneStarts(env, database);
});

// ---------------------------------------------------------------------------
// A withdrawn racer rides along; only a heat nobody can win still blocks
// ---------------------------------------------------------------------------

test("a participant withdrawn while registration is closed does not block the round or move a slot", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 4, participantCount: 8 });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 4]);
  const rosterBefore = rosterOf(database, 2);

  // Withdrawal leaves the heat_entries row exactly where it was: the duck is
  // already sealed in heat 2's bag and nobody unpacks a bag to fish it out.
  const withdrawn = await withdraw(env, "registration-5", 1);
  assert.equal(withdrawn.status, 201, await withdrawn.clone().text());
  assert.equal(
    database.prepare("SELECT status FROM registrations WHERE id = 'registration-5'").get().status,
    "WITHDRAWN",
  );
  assert.deepEqual(rosterOf(database, 2), rosterBefore);

  // Readiness reports it and lets the race start.
  const gate = await readiness(env);
  assert.equal(gate["start-round-one"].allowed, true);
  assert.deepEqual(gate["start-round-one"].blockers, []);
  assert.deepEqual(gate["start-round-one"].notes, [
    "1 racer on a round-one roster is withdrawn or disqualified. That duck stays in its heat bag "
    + "and races as normal, but cannot be recorded as a winner.",
  ]);

  await assertRoundOneStarts(env, database);
  // The lock ran over the withdrawn racer without touching their place.
  assert.deepEqual(rosterOf(database, 2), rosterBefore);
  assertStructurallySound(database);

  // The announcer still sees them, marked, because their duck is in the bag the
  // staff are physically holding. This is where the announcer learns not to
  // call that name.
  const heat = heatRow(database, 2);
  const announcer = await handleHeatOperations(
    new Request(`https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/announcer-roster`),
    env,
    director,
  );
  assert.equal(announcer.status, 200);
  const announced = (await announcer.json()).roster;
  assert.equal(announced.length, 4);
  const marked = announced.find((entry) => entry.displayName.includes("Number5"));
  assert.ok(marked, "the withdrawn racer stays on the staff roster");
  assert.equal(marked.eligible, false);
  assert.equal(marked.registrationStatus, "WITHDRAWN");
  assert.ok(announced.filter((entry) => entry.eligible).length, 3);
});

test("the guarded start refuses a heat that loses its last eligible racer between preflight and commit", async (context) => {
  let withdrawn = false;
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 }, () => {
    // Fires once, on the round-one start batch, after readiness already passed,
    // so only the guarded SQL inside the batch can still catch it. Every racer
    // in heat 2 leaves at once, which is the one roster state that cannot
    // produce a result.
    if (withdrawn) return;
    if (eventStatus(database) !== "REGISTRATION_CLOSED") return;
    withdrawn = true;
    database.exec(
      "UPDATE registrations SET status = 'WITHDRAWN' WHERE id IN ('registration-4', 'registration-5', 'registration-6')",
    );
  });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);

  const blocked = await lifecycle(env, "start-round-one");
  assert.equal(blocked.status, 409);
  assert.equal(eventStatus(database), "REGISTRATION_CLOSED");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_ROUND_ONE'").get().count,
    0,
  );
  assert.deepEqual(heatLayout(database).map((heat) => heat.locked), [false, false]);
  assert.deepEqual(heatLayout(database).map((heat) => heat.status), ["PLANNED", "PLANNED"]);
  assertStructurallySound(database);

  // Readiness now names the same refusal, and reactivation — not a roster
  // replacement — is the remedy, because the bags cannot be re-sorted.
  const gate = await readiness(env);
  assert.equal(gate["start-round-one"].allowed, false);
  assert.deepEqual(gate["start-round-one"].blockers, [
    "A heat in round one has no racer left who can win: every racer on that roster is "
    + "withdrawn or disqualified, so the heat could not produce a result. Reactivate a racer "
    + "before starting. The roster, the slot numbers, and the ducks in the bag stay exactly as they are.",
  ]);
  const rosterBefore = rosterOf(database, 2);
  const reactivated = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/registrations/registration-4/reactivate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        expectedRevision: database.prepare("SELECT revision FROM registrations WHERE id = 'registration-4'").get().revision,
      }),
    }),
    env,
    director,
  );
  assert.equal(reactivated.status, 201, await reactivated.clone().text());
  await assertRoundOneStarts(env, database);
  assert.deepEqual(rosterOf(database, 2), rosterBefore);
  assertStructurallySound(database);
});

// ---------------------------------------------------------------------------
// The split never outgrows the final
// ---------------------------------------------------------------------------

test("a split never creates more round-one heats than the final can hold", async (context) => {
  const { database, env } = await setup(context, {
    ducksPerHeat: 4,
    participantCount: 5,
    finalHeatCapacity: 2,
  });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 1]);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5]);

  // A late pairing takes round one back up to the final's capacity, so the
  // borrowed slot has nowhere to split out to.
  await pair(env, addLateParticipant(database, 1));
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5, 1]);

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.equal(eventStatus(database), "REGISTRATION_OPEN");
  // No third heat was created, so the invariant round-one heats never exceed
  // final capacity holds throughout, and the reopen still succeeded.
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5, 1]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE'").get().count,
    2,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ROUND_ONE_TAIL_SPLIT'").get().count,
    0,
  );
  assertStructurallySound(database);

  await assertRoundOneStarts(env, database);
});

test("the guarded split insert refuses a heat that would exceed final capacity mid-batch", async (context) => {
  let filled = false;
  const { database, env } = await setup(context, {
    ducksPerHeat: 4,
    participantCount: 5,
    finalHeatCapacity: 3,
  }, () => {
    // Fires on the reopen batch only, after its plan already measured two
    // heats, so nothing but the guard inside the insert can refuse the third
    // heat. The late pairing runs while only one heat exists, so it is skipped.
    if (filled) return;
    if (eventStatus(database) !== "REGISTRATION_CLOSED") return;
    const heats = database.prepare(
      "SELECT COUNT(*) AS count FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE'",
    ).get().count;
    if (heats !== 2) return;
    filled = true;
    database.exec(`
      INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
      VALUES ('heat-race', 'event_test', 'ROUND_ONE', 9, 'PLANNED', 4);
    `);
  });
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5]);
  await pair(env, addLateParticipant(database, 1));

  const refused = await lifecycle(env, "reopen-registration");
  assert.equal(refused.status, 409);
  assert.equal(eventStatus(database), "REGISTRATION_CLOSED");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'REOPEN_REGISTRATION'").get().count,
    0,
  );
  // The split wrote nothing at all: the merged heat still holds its borrowed
  // slots and round one never gained a fourth heat.
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [5, 1, 0]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE'").get().count,
    3,
  );
  assertStructurallySound(database);
});

// A paired duck is already inside a physical heat bag. If its racer leaves the
// race, nobody empties that bag on the bank to fish one duck out, and the heat
// entries can never be reordered either, because the ducks inside a bag are
// indistinguishable without scanning every one of them. So the finish line's
// answer for that duck must move nothing at all.
test("a duck whose racer left the race is reported at the finish line without moving one heat entry", async (context) => {
  const { database, env, participants } = await setup(context, { ducksPerHeat: 3, participantCount: 6 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);
  await assertRoundOneStarts(env, database);

  const heat = heatRow(database, 1);
  const move = async (operation, revision) => {
    const response = await handleHeatOperations(new Request(
      `https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/${operation}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: crypto.randomUUID(), revision }),
      },
    ), env, director);
    assert.equal(response.status, 201, `${operation}: ${await response.clone().text()}`);
    return (await response.json()).heat.revision;
  };
  let revision = heat.revision;
  for (const operation of ["ready", "call", "start", "finish"]) revision = await move(operation, revision);

  // Whatever route puts a racer in this state, the finish line has to answer it.
  const stranded = participants[1];
  database.exec("UPDATE registrations SET status = 'DISQUALIFIED' WHERE id = 'registration-2'");

  const layoutBefore = heatLayout(database);
  const rostersBefore = [rosterOf(database, 1), rosterOf(database, 2)];
  const entriesBefore = database.prepare(
    "SELECT id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source FROM heat_entries ORDER BY id",
  ).all().map((row) => ({ ...row }));

  const scanned = await handleHeatOperations(new Request(
    `https://quickducks.com/api/v1/staff/events/event_test/heats/${heat.id}/finish-scan?value=`
      + encodeURIComponent(`https://quickducks.com/t/${stranded.token}`),
  ), { ...env, APP_ORIGIN: "https://quickducks.com" }, director);
  assert.equal(scanned.status, 422);
  const scannedBody = await scanned.json();
  assert.equal(scannedBody.reason, "DUCK_NOT_ELIGIBLE");
  assert.equal(scannedBody.ineligible.registrationStatus, "DISQUALIFIED");
  assert.equal(scannedBody.ineligible.raceEntryId, stranded.raceEntryId);

  const confirmed = await handleHeatOperations(new Request(
    `https://quickducks.com/api/v1/staff/ducks/${stranded.token}/heat-winner`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        heatId: heat.id,
        raceEntryId: stranded.raceEntryId,
        revision,
      }),
    },
  ), env, director);
  assert.equal(confirmed.status, 422);
  assert.equal((await confirmed.json()).reason, "DUCK_NOT_ELIGIBLE");

  // Not one entry moved, no heat was renumbered, rebalanced, or emptied, and no
  // result or command was written.
  assert.deepEqual(heatLayout(database), layoutBefore);
  assert.deepEqual([rosterOf(database, 1), rosterOf(database, 2)], rostersBefore);
  assert.deepEqual(
    database.prepare(
      "SELECT id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source FROM heat_entries ORDER BY id",
    ).all().map((row) => ({ ...row })),
    entriesBefore,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'FINALIZE_HEAT_RESULT'",
  ).get().count, 0);
  assertStructurallySound(database);

  // The next duck to pass the line still records normally, and the disqualified
  // racer is still sitting in the same slot afterwards.
  const winner = participants[2];
  const recorded = await handleHeatOperations(new Request(
    `https://quickducks.com/api/v1/staff/ducks/${winner.token}/heat-winner`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        heatId: heat.id,
        raceEntryId: winner.raceEntryId,
        revision,
      }),
    },
  ), env, director);
  assert.equal(recorded.status, 201, await recorded.clone().text());
  assert.deepEqual(rosterOf(database, 1), rostersBefore[0]);
  assert.deepEqual(rosterOf(database, 2), rostersBefore[1]);
  assertStructurallySound(database);
});
