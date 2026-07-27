// Round-one heat rebalancing against the real migrated schema.
//
// Heats are built as participants are paired, so the last heat is the only one
// that can be short. These tests drive the real pairing handler and the real
// lifecycle handler so the merge on close, the split on reopen, the automatic
// roster lock, and the minimum-heat-size blocker are all exercised against the
// production triggers, foreign keys, and uniqueness constraints.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";
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

  const gate = await readiness(env);
  assert.equal(gate["start-round-one"].allowed, true, JSON.stringify(gate["start-round-one"].blockers));
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
});

test("reopening registration is allowed with heats present and refused once round one starts", async (context) => {
  const { database, env } = await setup(context, { ducksPerHeat: 3, participantCount: 6 });
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [3, 3]);

  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  const closedGate = await readiness(env);
  assert.equal(closedGate["reopen-registration"].allowed, true, "heats existing never blocks a reopen");
  assert.deepEqual(closedGate["reopen-registration"].blockers, []);

  assert.equal((await lifecycle(env, "reopen-registration")).status, 201);
  assert.equal((await lifecycle(env, "close-registration")).status, 201);

  assert.equal((await lifecycle(env, "start-round-one")).status, 201);
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

  // Closing again merges the new tail into the heat before it, and the totals
  // are preserved across the whole cycle.
  assert.equal((await lifecycle(env, "close-registration")).status, 201);
  assert.deepEqual(heatLayout(database).map((heat) => heat.size), [4, 2]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM heat_entries WHERE event_id = 'event_test'").get().count,
    6,
  );
  assertStructurallySound(database);
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
});
