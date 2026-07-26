import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleParticipantOperations } from "./participant-operations.ts";

const migrationNames = [
  "0001_staff_identity.sql",
  "0002_registration_foundation.sql",
  "0003_assignment_and_heat_status.sql",
  "0004_pairing_status_and_purge.sql",
  "0005_staff_access_management.sql",
  "0006_participant_operations.sql",
];

const staffActor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Registration Staff",
  isSystemAdmin: false,
  authentication: "bearer",
};

const adminActor = {
  ...staffActor,
  id: "admin",
  cognitoSub: "admin-sub",
  email: "admin@example.com",
  displayName: "Race Administrator",
  isSystemAdmin: true,
};

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
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
  return {
    statements,
    prepare,
    async batch(items) {
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
  const response = await handleParticipantOperations(
    new Request("https://quickducks.com/api/v1/staff/ducks/token"),
    env,
    staffActor,
  );
  assert.equal(response, null);
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
  assert.equal(JSON.stringify(body).includes("private_token_hash"), false);
  const listStatement = DB.statements.find((statement) => statement.sql.includes("ORDER BY r.last_name"));
  assert.equal(listStatement.sql.includes("Daisy"), false);
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
    duckKeepPreference: "RETURN",
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
  assert.equal(created.privateStatusPath, `/r/${privateToken}`);

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

test("partial participant edits require the current revision and omit PII from audit details", async () => {
  const { database, env } = makeContext();
  const commandId = crypto.randomUUID();
  const edit = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-two", "PATCH", {
      commandId,
      expectedRevision: 0,
      firstName: "Don",
      email: "don@example.com",
      emailNotificationsEnabled: true,
      duckKeepPreference: "KEEP",
      notes: "Uses accessible starting area",
    }),
    env,
    staffActor,
  );
  const edited = await edit.json();
  assert.equal(edit.status, 200);
  assert.equal(edited.registration.firstName, "Don");
  assert.equal(edited.registration.lastName, "Duck");
  assert.equal(edited.registration.revision, 1);
  assert.equal(edited.registration.raceEntryRevision, 1);
  const audit = database.prepare("SELECT details_json FROM audit_events WHERE command_id = ?").get(commandId);
  const details = JSON.parse(audit.details_json);
  assert.deepEqual(details.changed_fields, [
    "first_name",
    "email",
    "email_notifications_enabled",
    "duck_keep_preference",
    "staff_notes",
  ]);
  assert.equal(audit.details_json.includes("Don"), false);
  assert.equal(audit.details_json.includes("example.com"), false);
  assert.equal(audit.details_json.includes("accessible"), false);

  const stale = await handleParticipantOperations(
    jsonRequest("https://quickducks.com/api/v1/staff/registrations/registration-two", "PATCH", {
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
