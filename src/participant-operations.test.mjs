import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleParticipantOperations } from "./participant-operations.ts";

// The full ordered migration set, so this file exercises the participant
// operations against the same schema production runs. It stopped at 0009 while
// the schema kept moving, which hid later columns — `race_entries.duck_name`
// among them — from every assertion here.
const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const staffActor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Registration Staff",
  isSystemAdmin: false,
  roles: ["REGISTRATION"],
  authentication: "bearer",
};

const adminActor = {
  ...staffActor,
  id: "admin",
  cognitoSub: "admin-sub",
  email: "admin@example.com",
  displayName: "Race Administrator",
  isSystemAdmin: true,
  roles: [],
};

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const createD1 = (database) => {
  const statements = [];
  const prepare = (sql) => {
    const bound = {
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
      run() {
        return database.prepare(this.sql).run(...this.args);
      },
    };
    statements.push(bound);
    return bound;
  };
  const api = {
    statements,
    prepare,
    beforeBatch: null,
    async batch(items) {
      if (this.beforeBatch) {
        const hook = this.beforeBatch;
        this.beforeBatch = null;
        await hook(items);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = items.map((item) => item.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return api;
};

const seed = (database) => {
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin)
    VALUES
      ('staff', 'staff-sub', 'staff@example.com', 'Registration Staff', 0),
      ('admin', 'admin-sub', 'admin@example.com', 'Race Administrator', 1);
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, email_required)
    VALUES
      ('event-open', 'open-race', 'Open Race', '2026-08-01', 'America/Denver', 'REGISTRATION_OPEN', 0),
      ('event-complete', 'complete-race', 'Complete Race', '2026-07-01', 'America/Denver', 'COMPLETED', 0);
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, phone, status, lookup_code,
       private_token_hash, email_notifications_enabled, created_via, staff_notes,
       submitted_at, status_changed_at)
    VALUES
      ('registration-one', 'event-open', 'Daisy', 'Duck', 'daisy@example.com',
       '555-0100', 'ACTIVE', 'DAASY234', 'hash-one', 1, 'PUBLIC', 'Needs a wide lane',
       '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z'),
      ('registration-two', 'event-open', 'Donald', 'Duck', NULL,
       NULL, 'SUBMITTED', 'DNNALD23', 'hash-two', 0, 'STAFF', NULL,
       '2026-07-25T00:01:00Z', '2026-07-25T00:01:00Z'),
      ('registration-complete', 'event-complete', 'Finished', 'Racer', NULL,
       NULL, 'ACTIVE', 'FNSHED23', 'hash-three', 0, 'PUBLIC', NULL,
       '2026-06-25T00:00:00Z', '2026-06-25T00:00:00Z');
    INSERT INTO race_entries
      (id, event_id, registration_id, duck_keep_preference)
    VALUES
      ('entry-one', 'event-open', 'registration-one', 'KEEP'),
      ('entry-two', 'event-open', 'registration-two', 'UNDECIDED'),
      ('entry-complete', 'event-complete', 'registration-complete', 'RETURN');
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-one', 41, 'IN_USE', '2026-07-25T00:00:00Z');
    INSERT INTO event_ducks
      (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck-one', 'event-open', 'duck-one', '2026-07-25T00:00:00Z', 'staff');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES
      ('seed-assignment-command', 'event-open', 'ASSIGN_DUCK', 'assignment-one',
       '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES
      ('assignment-one', 'event-open', 'entry-one', 'event-duck-one', 'duck-one',
       '2026-07-25T00:00:00Z', 'staff', 'seed-assignment-command');
  `);
};

const makeContext = (withSeed = true) => {
  const database = createDatabase();
  if (withSeed) seed(database);
  const DB = createD1(database);
  return { database, env: { DB }, DB };
};

const jsonRequest = (url, method, body) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("migration adds only bounded staff notes to participant storage", () => {
  const database = createDatabase();
  const columns = database.prepare("PRAGMA table_info(registrations)").all();
  assert.equal(columns.some((column) => column.name === "staff_notes"), true);
  database.exec(`
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'event', 'Event', 'UTC', 'REGISTRATION_OPEN');
  `);
  assert.throws(() => database.prepare(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, lookup_code, private_token_hash,
       submitted_at, status_changed_at, staff_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "registration",
    "event",
    "Daisy",
    "Duck",
    "DAASY234",
    "hash",
    "2026-07-25T00:00:00Z",
    "2026-07-25T00:00:00Z",
    "x".repeat(2001),
  ), /CHECK constraint failed/);
  database.close();
});

test("handler returns null for routes owned by other staff modules", async () => {
  const { database, env } = makeContext();
  const duckResponse = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/ducks/token"),
    env,
    staffActor,
  );
  const registrationSearchResponse = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/registrations/search?eventId=event-open&q=Daisy"),
    env,
    staffActor,
  );
  const replacementSearchResponse = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/registrations/replacement-search?eventId=event-open&q=Daisy"),
    env,
    staffActor,
  );
  assert.equal(duckResponse, null);
  assert.equal(registrationSearchResponse, null);
  assert.equal(replacementSearchResponse, null);
  database.close();
});

test("staff can filter an event registration list and inspect assignment detail", async () => {
  const { database, env, DB } = makeContext();
  const response = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event-open/registrations?status=active&assignment=assigned&q=Daisy"),
    env,
    staffActor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.event.status, "REGISTRATION_OPEN");
  assert.equal(body.registrations.length, 1);
  assert.equal(body.registrations[0].email, "daisy@example.com");
  assert.equal(body.registrations[0].assignment.duck.visibleNumber, 41);
  assert.equal("duckKeepPreference" in body.registrations[0], false);
  assert.equal(JSON.stringify(body).includes("private_token_hash"), false);
  const listStatement = DB.statements.find((statement) => statement.sql.includes("ORDER BY r.last_name"));
  assert.equal(listStatement.sql.includes("Daisy"), false);
  assert.equal(listStatement.sql.includes("duck_keep_preference"), false);
  assert.equal(listStatement.args.includes("%Daisy%"), true);

  const detail = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/registrations/registration-one"),
    env,
    staffActor,
  );
  const detailBody = await detail.json();
  assert.equal(detailBody.registration.notes, "Needs a wide lane");
  assert.equal(detailBody.registration.raceEntryId, "entry-one");
  assert.equal(detailBody.registration.assignment.id, "assignment-one");
  assert.equal("duckKeepPreference" in detailBody.registration, false);
  database.close();
});

test("staff walk-up creation is event-guarded, audited, and idempotent", async () => {
  const { database, env } = makeContext();
  const commandId = crypto.randomUUID();
  const privateToken = "p".repeat(43);
  const payload = {
    commandId,
    privateToken,
    firstName: "  Della ",
    lastName: " Duck ",
    email: "DELLA@example.com",
    phone: "555-0110",
    emailNotificationsEnabled: true,
    notes: "Call guardian before racing",
  };
  const create = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/events/event-open/registrations", "POST", payload),
    env,
    staffActor,
  );
  const created = await create.json();
  assert.equal(create.status, 201);
  assert.equal(created.registration.firstName, "Della");
  assert.equal(created.registration.email, "della@example.com");
  assert.equal(created.registration.createdVia, "STAFF");
  assert.equal("duckKeepPreference" in created.registration, false);
  assert.equal(created.privateStatusPath, `/r/${privateToken}`);
  assert.equal(database.prepare(
    "SELECT duck_keep_preference FROM race_entries WHERE registration_id = ?",
  ).get(created.registration.registrationId).duck_keep_preference, "UNDECIDED");

  const replay = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/events/event-open/registrations", "POST", payload),
    env,
    staffActor,
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE first_name = 'Della'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE command_id = ?").get(commandId).count, 1);
  const auditDetails = database.prepare("SELECT details_json FROM audit_events WHERE command_id = ?").get(commandId).details_json;
  assert.deepEqual(JSON.parse(auditDetails), { staff_profile_id: "staff", created_via: "STAFF" });
  assert.equal(auditDetails.includes("Della"), false);
  assert.equal(auditDetails.includes("example.com"), false);
  assert.equal(auditDetails.includes("guardian"), false);

  const changedReplay = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/events/event-open/registrations", "POST", {
      ...payload,
      firstName: "Different",
    }),
    env,
    staffActor,
  );
  assert.equal(changedReplay.status, 409);

  const blocked = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/events/event-complete/registrations", "POST", {
      ...payload,
      commandId: crypto.randomUUID(),
      privateToken: "q".repeat(43),
    }),
    env,
    staffActor,
  );
  assert.equal(blocked.status, 409);
  database.close();
});

test("Round One walk-ups remain atomic through multiple, final, and concurrently started heats", async (context) => {
  const { database, env, DB } = makeContext();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, round_one_heat_capacity, final_heat_capacity)
    VALUES ('event-round', 'round-race', 'Round Race', '2026-08-02', 'UTC', 'ROUND_ONE', 4, 4);
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size, roster_locked_at,
       roster_locked_by_staff_profile_id)
    VALUES
      ('round-heat-1', 'event-round', 'ROUND_ONE', 1, 'LOADING', 4,
       '2026-07-30T00:00:00Z', 'staff'),
      ('round-heat-2', 'event-round', 'ROUND_ONE', 2, 'LOADING', 4,
       '2026-07-30T00:00:00Z', 'staff'),
      ('round-heat-3', 'event-round', 'ROUND_ONE', 3, 'LOADING', 4,
       '2026-07-30T00:00:00Z', 'staff');
  `);
  const create = (suffix, commandId = crypto.randomUUID()) => handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/events/event-round/registrations", "POST", {
      commandId,
      privateToken: suffix.repeat(43),
      firstName: `Late${suffix}`,
      lastName: "Racer",
      email: null,
      phone: null,
      emailNotificationsEnabled: false,
      notes: null,
    }),
    env,
    staffActor,
  );

  const withMultipleRemaining = await create("m");
  assert.equal(withMultipleRemaining.status, 201, await withMultipleRemaining.clone().text());

  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('start-one', 'event-round', 'START_HEAT', 'round-heat-1',
            '2026-07-30T00:01:00Z', '2026-07-30T00:01:00Z'),
           ('start-two', 'event-round', 'START_HEAT', 'round-heat-2',
            '2026-07-30T00:02:00Z', '2026-07-30T00:02:00Z');
    UPDATE heats SET status = 'FINALIZED', started_at = '2026-07-30T00:01:00Z',
                     finalized_at = '2026-07-30T00:02:30Z'
     WHERE id IN ('round-heat-1', 'round-heat-2');
  `);
  const withOneRemaining = await create("n");
  assert.equal(withOneRemaining.status, 201, await withOneRemaining.clone().text());

  database.exec(`
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('start-three', 'event-round', 'START_HEAT', 'round-heat-3',
            '2026-07-30T00:03:00Z', '2026-07-30T00:03:00Z');
    UPDATE heats SET status = 'RUNNING', started_at = '2026-07-30T00:03:00Z'
     WHERE id = 'round-heat-3';
  `);
  const beforeLate = {
    registrations: database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE event_id = 'event-round'").get().count,
    entries: database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE event_id = 'event-round'").get().count,
    commands: database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE event_id = 'event-round'").get().count,
    audits: database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_id = 'event-round'").get().count,
  };
  const closed = await create("p");
  assert.equal(closed.status, 409);
  assert.match((await closed.json()).error, /every Round One heat has started/);
  assert.deepEqual({
    registrations: database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE event_id = 'event-round'").get().count,
    entries: database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE event_id = 'event-round'").get().count,
    commands: database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE event_id = 'event-round'").get().count,
    audits: database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_id = 'event-round'").get().count,
  }, beforeLate);

  // Restore exactly one never-started heat, let the preflight observe it, then
  // make the final start win immediately before the creation batch begins.
  database.exec(`
    DELETE FROM race_commands WHERE id = 'start-three';
    UPDATE heats SET status = 'CALLING', started_at = NULL, finalized_at = NULL
     WHERE id = 'round-heat-3';
  `);
  DB.beforeBatch = () => {
    database.exec(`
      INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
      VALUES ('start-concurrent', 'event-round', 'START_HEAT', 'round-heat-3',
              '2026-07-30T00:04:00Z', '2026-07-30T00:04:00Z');
      UPDATE heats SET status = 'RUNNING', started_at = '2026-07-30T00:04:00Z'
       WHERE id = 'round-heat-3';
    `);
  };
  const beforeConcurrent = database.prepare(
    "SELECT COUNT(*) AS count FROM registrations WHERE event_id = 'event-round'",
  ).get().count;
  const concurrentCommandId = crypto.randomUUID();
  const lostRace = await create("q", concurrentCommandId);
  assert.equal(lostRace.status, 409);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE event_id = 'event-round'").get().count,
    beforeConcurrent,
    "the stale creation leaves no partial participant",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE id = ?").get(
      concurrentCommandId,
    ).count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("partial participant edits ignore legacy preference data and omit PII from audit details", async () => {
  const { database, env } = makeContext();
  const commandId = crypto.randomUUID();
  const edit = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one", "PATCH", {
      commandId,
      expectedRevision: 0,
      firstName: "Daisy Updated",
      email: "updated@example.com",
      emailNotificationsEnabled: false,
      duckKeepPreference: "RETURN",
      notes: "Uses accessible starting area",
    }),
    env,
    staffActor,
  );
  const edited = await edit.json();
  assert.equal(edit.status, 200);
  assert.equal(edited.registration.firstName, "Daisy Updated");
  assert.equal(edited.registration.lastName, "Duck");
  assert.equal(edited.registration.revision, 1);
  assert.equal(edited.registration.raceEntryRevision, 0);
  assert.equal("duckKeepPreference" in edited.registration, false);
  const legacyEntry = database.prepare(
    "SELECT duck_keep_preference, revision FROM race_entries WHERE id = 'entry-one'",
  ).get();
  assert.equal(legacyEntry.duck_keep_preference, "KEEP");
  assert.equal(legacyEntry.revision, 0);
  const audit = database.prepare("SELECT details_json FROM audit_events WHERE command_id = ?").get(commandId);
  const details = JSON.parse(audit.details_json);
  assert.deepEqual(details.changed_fields, [
    "first_name",
    "email",
    "email_notifications_enabled",
    "staff_notes",
  ]);
  assert.equal(audit.details_json.includes("Daisy Updated"), false);
  assert.equal(audit.details_json.includes("example.com"), false);
  assert.equal(audit.details_json.includes("accessible"), false);

  const stale = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one", "PATCH", {
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      phone: "555-0199",
    }),
    env,
    staffActor,
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).currentRevision, 1);

  const completeEventEdit = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-complete", "PATCH", {
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
      notes: "Too late",
    }),
    env,
    staffActor,
  );
  assert.equal(completeEventEdit.status, 409);
  database.close();
});

test("staff clearing a phone also clears SMS consent without breaking older edit clients", async () => {
  const { database, env } = makeContext();
  database.prepare(
    "UPDATE registrations SET sms_notifications_enabled = 1 WHERE id = 'registration-one'",
  ).run();
  const commandId = crypto.randomUUID();
  const response = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one", "PATCH", {
      commandId,
      expectedRevision: 0,
      phone: null,
    }),
    env,
    staffActor,
  );
  assert.equal(response.status, 200);
  const row = database.prepare(
    "SELECT phone, sms_notifications_enabled FROM registrations WHERE id = 'registration-one'",
  ).get();
  assert.equal(row.phone, null);
  assert.equal(row.sms_notifications_enabled, 0);
  assert.deepEqual(
    JSON.parse(database.prepare(
      "SELECT details_json FROM audit_events WHERE command_id = ?",
    ).get(commandId).details_json).changed_fields,
    ["phone", "sms_notifications_enabled"],
  );
  database.close();
});

test("withdraw, reactivate, and disqualify are authorized idempotent status commands", async () => {
  const { database, env } = makeContext();
  const disallowed = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/disqualify", "POST", {
      commandId: crypto.randomUUID(),
      expectedRevision: 0,
    }),
    env,
    staffActor,
  );
  assert.equal(disallowed.status, 403);

  const withdrawCommand = crypto.randomUUID();
  const withdrawPayload = { commandId: withdrawCommand, expectedRevision: 0 };
  const withdraw = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/withdraw", "POST", withdrawPayload),
    env,
    staffActor,
  );
  assert.equal(withdraw.status, 201);
  assert.equal((await withdraw.json()).registration.status, "WITHDRAWN");
  const withdrawReplay = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/withdraw", "POST", withdrawPayload),
    env,
    staffActor,
  );
  assert.equal((await withdrawReplay.json()).replayed, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE id = ?").get(withdrawCommand).count, 1);

  const regularReactivation = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/reactivate", "POST", {
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
    }),
    env,
    staffActor,
  );
  assert.equal(regularReactivation.status, 403);

  const reactivate = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/reactivate", "POST", {
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
    }),
    env,
    adminActor,
  );
  assert.equal((await reactivate.json()).registration.status, "ACTIVE");

  const disqualify = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-one/disqualify", "POST", {
      commandId: crypto.randomUUID(),
      expectedRevision: 2,
    }),
    env,
    adminActor,
  );
  assert.equal((await disqualify.json()).registration.status, "DISQUALIFIED");
  assert.deepEqual(
    database.prepare("SELECT action FROM audit_events WHERE subject_id = ? ORDER BY occurred_at, rowid").all("registration-one")
      .map((row) => row.action),
    ["REGISTRATION_WITHDRAWN", "REGISTRATION_REACTIVATED", "REGISTRATION_DISQUALIFIED"],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE id = ?").get("registration-one").count, 1);
  assert.equal(database.prepare("SELECT valid_to FROM duck_assignments WHERE id = ?").get("assignment-one").valid_to, null);
  database.close();
});

// Withdrawal and disqualification are the only exit a paired participant has,
// so they must be pure bookkeeping. The duck is already sealed in a heat bag and
// nothing on race day may move it, renumber a slot, or resort a heat.
test("a status change writes only the command, the registration, and the audit", async (context) => {
  const { database, env, DB } = makeContext();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-one', 'event-open', 'ROUND_ONE', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-one', 'event-open', 'heat-one', 'entry-one', 'ROUND_ONE', 1,
            'BALANCED_DRAW', '2026-07-25T01:00:00Z'),
           ('heat-entry-two', 'event-open', 'heat-one', 'entry-two', 'ROUND_ONE', 2,
            'BALANCED_DRAW', '2026-07-25T01:00:00Z');
  `);

  for (const [operation, actor, revision] of [
    ["withdraw", staffActor, 0],
    ["reactivate", adminActor, 1],
    ["disqualify", adminActor, 2],
  ]) {
    const before = DB.statements.length;
    const response = await handleParticipantOperations(
      jsonRequest(`https://quickducks.com/api/v1/staff/registrations/registration-one/${operation}`, "POST", {
        commandId: crypto.randomUUID(),
        expectedRevision: revision,
      }),
      env,
      actor,
    );
    assert.equal(response.status, 201, operation);

    // No statement this operation prepared writes to any table that carries the
    // physical race: assignments, heats, heat entries, or results.
    const writes = DB.statements.slice(before)
      .map((statement) => statement.sql)
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
    for (const sql of writes) {
      assert.doesNotMatch(
        sql,
        /(INSERT INTO|UPDATE|DELETE FROM)\s+(duck_assignments|heats|heat_entries|heat_results)\b/i,
        `${operation} must not write race data: ${sql}`,
      );
    }
    assert.deepEqual(
      writes.map((sql) => sql.match(/(?:INSERT INTO|UPDATE)\s+(\w+)/i)[1]),
      ["race_commands", "registrations", "audit_events"],
      operation,
    );
  }

  // And the stored race data is provably identical afterwards, including the
  // slot order of the racer who never left.
  assert.equal(database.prepare("SELECT valid_to FROM duck_assignments WHERE id = 'assignment-one'").get().valid_to, null);
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY slot_number")
      .all().map((row) => ({ ...row })),
    [
      { id: "heat-entry-one", heat_id: "heat-one", race_entry_id: "entry-one", slot_number: 1 },
      { id: "heat-entry-two", heat_id: "heat-one", race_entry_id: "entry-two", slot_number: 2 },
    ],
  );
  assert.equal(database.prepare("SELECT status FROM heats WHERE id = 'heat-one'").get().status, "PLANNED");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The rule this replaces refused withdrawal once the participant's heat was
// locked or beyond, which is the old model where a withdrawn racer came off the
// roster. Under the current model there is nothing to come off: the duck is
// sealed in a numbered bag, the entry never moves, and the racer is simply
// ineligible. So the heat's state is no longer a reason to refuse, and a heat
// that has already been raced and published is no different from a planned one.
test("withdrawal and disqualification are allowed at every heat state and move nothing", async (context) => {
  const { database, env } = makeContext();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO heats
      (id, event_id, round, heat_number, status, target_size)
    VALUES ('heat-one', 'event-open', 'ROUND_ONE', 1, 'PLANNED', 2);
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-one', 'event-open', 'heat-one', 'entry-one', 'ROUND_ONE', 1,
            'BALANCED_DRAW', '2026-07-25T01:00:00Z'),
           ('heat-entry-two', 'event-open', 'heat-one', 'entry-two', 'ROUND_ONE', 2,
            'BALANCED_DRAW', '2026-07-25T01:00:00Z');
  `);

  const raceSnapshot = () => ({
    heats: database.prepare("SELECT id, status, heat_number, roster_locked_at, target_size FROM heats ORDER BY id")
      .all().map((row) => ({ ...row })),
    entries: database.prepare(
      "SELECT id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at FROM heat_entries ORDER BY id",
    ).all().map((row) => ({ ...row })),
    assignments: database.prepare(
      "SELECT id, race_entry_id, duck_id, valid_from, valid_to FROM duck_assignments ORDER BY id",
    ).all().map((row) => ({ ...row })),
    results: database.prepare(
      "SELECT id, heat_id, race_entry_id, place, status, revision FROM heat_results ORDER BY id",
    ).all().map((row) => ({ ...row })),
  });

  const revisionOf = () => database.prepare(
    "SELECT revision FROM registrations WHERE id = 'registration-one'",
  ).get().revision;
  const statusOf = () => database.prepare(
    "SELECT status FROM registrations WHERE id = 'registration-one'",
  ).get().status;
  const call = async (operation, currentActor) => {
    const response = await handleParticipantOperations(
      jsonRequest(`https://quickducks.com/api/v1/staff/registrations/registration-one/${operation}`, "POST", {
        commandId: crypto.randomUUID(),
        expectedRevision: revisionOf(),
      }),
      env,
      currentActor,
    );
    return response;
  };

  // Every heat state the entry can be in, including the locked, raced, and
  // published ones the old rule refused. `FINALIZED` additionally carries a
  // published result for the *other* racer in the heat, which must survive too.
  const heatStates = [
    ["PLANNED", null],
    ["LOADING", "2026-07-25T01:05:00Z"],
    ["READY", "2026-07-25T01:05:00Z"],
    ["CALLING", "2026-07-25T01:05:00Z"],
    ["RUNNING", "2026-07-25T01:05:00Z"],
    ["AWAITING_RESULT", "2026-07-25T01:05:00Z"],
    ["FINALIZED", "2026-07-25T01:05:00Z"],
  ];
  for (const [status, lockedAt] of heatStates) {
    database.prepare(`
      UPDATE heats
         SET status = ?, roster_locked_at = ?,
             finalized_at = CASE WHEN ? = 'FINALIZED' THEN '2026-07-25T01:10:00Z' ELSE NULL END
       WHERE id = 'heat-one'
    `).run(status, lockedAt, status);
    if (status === "FINALIZED") {
      database.exec(`
        INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
        VALUES ('publish-command', 'event-open', 'FINALIZE_HEAT_RESULT', 'heat-one',
                '2026-07-25T01:10:00Z', '2026-07-25T01:10:00Z');
        INSERT INTO heat_results
          (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
           finalized_at, recorded_by_staff_profile_id, source_command_id)
        VALUES ('published-result', 'event-open', 'heat-one', 'entry-one', 'assignment-one', 1,
                'FINALIZED', 1, '2026-07-25T01:10:00Z', 'staff', 'publish-command');
      `);
    }
    const before = raceSnapshot();

    const withdrawn = await call("withdraw", staffActor);
    assert.equal(withdrawn.status, 201, `withdraw at ${status}`);
    assert.equal((await withdrawn.json()).registration.status, "WITHDRAWN", `withdraw at ${status}`);
    assert.equal(statusOf(), "WITHDRAWN", status);

    assert.equal((await call("reactivate", adminActor)).status, 201, `reactivate at ${status}`);
    // The duck assignment survived, so reactivation restores ACTIVE.
    assert.equal(statusOf(), "ACTIVE", status);

    const disqualified = await call("disqualify", adminActor);
    assert.equal(disqualified.status, 201, `disqualify at ${status}`);
    assert.equal(statusOf(), "DISQUALIFIED", status);
    assert.equal((await call("reactivate", adminActor)).status, 201, `reactivate at ${status}`);

    // Nothing physical moved: not the heat, not an entry identifier or slot
    // number, not a duck assignment, not a published result.
    assert.deepEqual(raceSnapshot(), before, `race data unchanged at ${status}`);
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
