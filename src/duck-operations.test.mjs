import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleDuckOperations } from "./duck-operations.ts";

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["DUCK_MANAGER"],
  authentication: "bearer",
};

const makeDb = (first = () => null, all = () => ({ results: [] })) => {
  const statements = [];
  const batches = [];
  return {
    statements,
    batches,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          return first(sql, this.args);
        },
        async all() {
          return all(sql, this.args);
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      batches.push(items);
      return items.map(() => ({ success: true }));
    },
  };
};

const makeEnv = (db) => ({
  APP_ORIGIN: "https://quickducks.com",
  DB: db,
});

const migrationNames = [
  "0001_staff_identity.sql",
  "0002_registration_foundation.sql",
  "0003_assignment_and_heat_status.sql",
  "0004_pairing_status_and_purge.sql",
  "0005_staff_access_management.sql",
  "0007_duck_inventory_operations.sql",
];

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  return database;
};

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
      const results = items.map((item) => database.prepare(item.sql).run(...item.args));
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

const summaryRow = {
  duck_id: "duck_test",
  visible_number: 42,
  inventory_status: "IN_USE",
  duck_revision: 3,
  physical_condition: "GOOD",
  storage_location: "HEAT 4 BAG",
  notes: "Blue mark under base",
  tag_id: "tag_test",
  tag_status: "ACTIVE",
  tag_activated_at: "2026-07-26T08:00:00Z",
  event_duck_id: "event_duck_test",
  reserved_at: "2026-07-26T08:00:00Z",
  released_at: null,
  event_id: "event_test",
  event_name: "Test Duck Race",
  event_status: "REGISTRATION_CLOSED",
  assignment_id: "assignment_test",
  assignment_valid_from: "2026-07-26T09:00:00Z",
  race_entry_id: "entry_test",
  registration_id: "registration_test",
  first_name: "Daisy",
  last_name: "Duck",
  registration_status: "ACTIVE",
  heat_id: "heat_test",
  heat_round: "ROUND_ONE",
  heat_number: 4,
  heat_status: "PLANNED",
  heat_slot_number: 2,
  disposition: null,
  disposition_recorded_at: null,
};

test("duck operations compose with the router and fail closed without staff", async () => {
  const db = makeDb();
  const unrelated = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/events/current"),
    makeEnv(db),
    null,
  );
  const privateInventory = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks"),
    makeEnv(db),
    null,
  );

  assert.equal(unrelated, null);
  assert.equal(privateInventory.status, 401);
  assert.equal(db.statements.length, 0);
});

test("duck-manager inventory includes relationships but redacts participant identity", async () => {
  const db = makeDb(
    () => null,
    (sql) => sql.includes("FROM ducks d") ? { results: [summaryRow] } : { results: [] },
  );
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ducks[0].tag.status, "ACTIVE");
  assert.equal(body.ducks[0].reservation.event.status, "REGISTRATION_CLOSED");
  assert.equal(body.ducks[0].assignment.id, "assignment_test");
  assert.equal(body.ducks[0].participant.firstName, undefined);
  assert.equal(body.ducks[0].participant.status, "ACTIVE");
  assert.equal(body.ducks[0].heat.number, 4);
  assert.equal(body.ducks[0].disposition, null);
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.match(db.statements[0].sql, /ORDER BY d\.visible_number/);
  assert.doesNotMatch(db.statements[0].sql, /LIMIT 200/);

  const registrationManager = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks"),
    makeEnv(db),
    { ...actor, roles: ["REGISTRATION", "DUCK_MANAGER"] },
  );
  assert.equal((await registrationManager.json()).ducks[0].participant.firstName, "Daisy");
});

test("duck detail returns append-only inventory and relationship history without raw tag tokens", async () => {
  const db = makeDb(
    (sql) => sql.includes("FROM ducks d") ? summaryRow : null,
    (sql) => {
      if (sql.includes("FROM duck_inventory_events")) {
        return { results: [{
          id: "inventory_event_test",
          action: "DUCK_INTAKE",
          occurred_at: "2026-07-26T08:00:00Z",
          details_json: JSON.stringify({ request: { visibleNumber: 42 } }),
          actor_id: actor.id,
          actor_display_name: actor.displayName,
        }] };
      }
      if (sql.includes("FROM duck_tags")) {
        return { results: [{
          id: "tag_test",
          status: "ACTIVE",
          supersedes_tag_id: null,
          written_at: "2026-07-26T08:00:00Z",
          verified_at: "2026-07-26T08:00:00Z",
          activated_at: "2026-07-26T08:00:00Z",
          retired_at: null,
          created_at: "2026-07-26T08:00:00Z",
        }] };
      }
      return { results: [] };
    },
  );
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.duck.visibleNumber, 42);
  assert.equal(body.history.inventoryEvents[0].action, "DUCK_INTAKE");
  assert.equal(body.history.tags[0].status, "ACTIVE");
  assert.equal(JSON.stringify(body).includes("tagToken"), false);
});

test("physical inventory intake atomically creates duck, active tag, event reservation, command, and audits", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("SELECT id FROM events")) return { id: "event_test" };
    return null;
  });
  const token = "a".repeat(32);
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        physicallyPresent: true,
        visibleNumber: 42,
        tagToken: token,
        condition: "GOOD",
        location: "Intake table",
        notes: "Verified in person",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.duck.inventoryStatus, "RESERVED_FOR_EVENT");
  assert.equal(body.tag.status, "ACTIVE");
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  const command = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO race_commands"));
  assert.equal(command.args.includes("REGISTER_RACE_DUCK"), true);
  assert.match(sql, /INSERT INTO ducks/);
  assert.match(sql, /INSERT INTO duck_tags/);
  assert.match(sql, /INSERT INTO event_ducks/);
  assert.match(sql, /INSERT INTO duck_inventory_events/);
  assert.match(sql, /INSERT INTO audit_events/);
  const tagInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO duck_tags"));
  assert.equal(tagInsert.sql.includes(token), false);
  assert.equal(tagInsert.args.includes(token), true);
});

test("intake requires affirmative physical presence", async () => {
  const db = makeDb();
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        visibleNumber: 42,
        tagToken: "a".repeat(32),
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 400);
  assert.equal(db.statements.length, 0);
});

test("revision-checked inventory edit binds all user values and writes command history", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM ducks d") && sql.includes("d.storage_location")) {
      return {
        id: "duck_test",
        visible_number: 42,
        inventory_status: "RESERVED_FOR_EVENT",
        revision: 7,
        physical_condition: "GOOD",
        storage_location: "Intake",
        notes: null,
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_CLOSED",
        active_assignment_id: null,
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 7,
        visibleNumber: 43,
        condition: "NEEDS_TAG",
        location: "Repair shelf",
        notes: "Replace before pairing",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.duck.revision, 8);
  assert.equal(body.duck.visibleNumber, 43);
  const update = db.batches[0].find((statement) => statement.sql.includes("UPDATE ducks SET"));
  assert.equal(update.sql.includes("Replace before pairing"), false);
  assert.equal(update.args.includes("Replace before pairing"), true);
  const audit = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO audit_events"));
  assert.equal(audit.args[3], "DUCK_INVENTORY_EDITED");
});

test("stale edit is rejected before any write", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM ducks d")) {
      return {
        id: "duck_test",
        visible_number: 42,
        inventory_status: "RESERVED_FOR_EVENT",
        revision: 8,
        physical_condition: "GOOD",
        storage_location: null,
        notes: null,
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_OPEN",
        active_assignment_id: null,
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 7,
        notes: "stale",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).revision, 8);
  assert.equal(db.batches.length, 0);
});

test("tag replacement retires the active mapping and activates a verified successor atomically", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM ducks d")) {
      return {
        duck_id: "duck_test",
        visible_number: 42,
        revision: 3,
        inventory_status: "IN_USE",
        physical_condition: "GOOD",
        event_duck_id: "event_duck_test",
        event_status: "ROUND_ONE",
        tag_id: "old_tag",
        active_assignment_id: "assignment_test",
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test/tags/replace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 3,
        physicalTagVerified: true,
        tagToken: "b".repeat(32),
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).revision, 4);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /status = 'RETIRED'/);
  assert.match(sql, /supersedes_tag_id/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO audit_events"));
  assert.equal(audit.args[3], "DUCK_TAG_REPLACED");
});

test("tag retirement without replacement is blocked for an assigned duck", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM ducks d")) {
      return {
        duck_id: "duck_test",
        visible_number: 42,
        revision: 3,
        inventory_status: "IN_USE",
        physical_condition: "GOOD",
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_CLOSED",
        tag_id: "old_tag",
        active_assignment_id: "assignment_test",
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test/tags/retire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 3,
        reason: "Tag is damaged",
        physicalTagRemoved: true,
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Replace the tag instead/);
  assert.equal(db.batches.length, 0);
});

test("pre-race reassignment closes the old assignment but preserves heat entries", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("SELECT id FROM events")) return { id: "event_test" };
    if (sql.includes("LEFT JOIN event_ducks ed")) {
      return {
        duck_id: "duck_new",
        visible_number: 84,
        duck_revision: 2,
        inventory_status: "RESERVED_FOR_EVENT",
        physical_condition: "GOOD",
        event_duck_id: "event_duck_new",
        event_duck_event_id: "event_test",
        active_assignment_id: null,
        tag_id: "tag_new",
      };
    }
    if (sql.includes("FROM race_entries re")) {
      return {
        race_entry_id: "entry_test",
        registration_id: "registration_test",
        registration_status: "ACTIVE",
        first_name: "Daisy",
        last_name: "Duck",
        old_assignment_id: "assignment_old",
        old_duck_id: "duck_old",
        old_duck_revision: 5,
        old_event_duck_id: "event_duck_old",
        blocking_heat_id: null,
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_new/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        raceEntryId: "entry_test",
        expectedRevision: 2,
        reason: "Wrong duck was paired",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.replacedAssignmentId, "assignment_old");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /STAFF_REASSIGNED/);
  assert.match(sql, /INSERT INTO duck_assignments/);
  assert.doesNotMatch(sql, /UPDATE heat_entries/);
  assert.doesNotMatch(sql, /DELETE FROM heat_entries/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO audit_events"));
  assert.equal(audit.args[3], "DUCK_REASSIGNED");
});

test("unassignment can atomically release the pre-race reservation", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM duck_assignments da")) {
      return {
        assignment_id: "assignment_test",
        event_id: "event_test",
        race_entry_id: "entry_test",
        registration_id: "registration_test",
        duck_id: "duck_test",
        visible_number: 42,
        duck_revision: 4,
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_CLOSED",
        physical_condition: "GOOD",
        blocking_heat_id: null,
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/assignments/assignment_test/unassign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 4,
        releaseReservation: true,
        reason: "Participant withdrew",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.reservationReleased, true);
  assert.equal(body.duck.inventoryStatus, "AVAILABLE");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /valid_to = \?/);
  assert.match(sql, /released_at = \?/);
  assert.match(sql, /status = 'SUBMITTED'/);
  const auditActions = db.batches[0]
    .filter((statement) => statement.sql.includes("INSERT INTO audit_events"))
    .map((statement) => statement.args[3]);
  assert.deepEqual(auditActions, ["DUCK_UNASSIGNED", "DUCK_RESERVATION_RELEASED"]);
});

test("unassignment is blocked once the participant heat has started", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM duck_assignments da")) {
      return {
        assignment_id: "assignment_test",
        event_id: "event_test",
        race_entry_id: "entry_test",
        registration_id: "registration_test",
        duck_id: "duck_test",
        visible_number: 42,
        duck_revision: 4,
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_CLOSED",
        physical_condition: "GOOD",
        blocking_heat_id: "heat_test",
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/assignments/assignment_test/unassign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 4,
        reason: "Needs correction",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /heat has started/);
  assert.equal(db.batches.length, 0);
});

test("print label endpoint returns only duck number and canonical tag URL", async () => {
  const db = makeDb((sql) => sql.includes("dt.token")
    ? { visible_number: 42, token: "a".repeat(32) }
    : null);
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test/label"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), ["tagUrl", "visibleNumber"]);
  assert.deepEqual(body, {
    visibleNumber: 42,
    tagUrl: `https://quickducks.com/t/${"a".repeat(32)}`,
  });
});

test("matching command UUID replay is read-only and reports replayed", async () => {
  const commandId = "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370";
  const requestDetails = {
    duckId: "duck_test",
    expectedRevision: 7,
    changes: { notes: "Counted twice" },
  };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) {
      return { event_id: "event_test", command_type: "EDIT_DUCK_INVENTORY", result_id: "duck_test" };
    }
    if (sql.includes("FROM duck_inventory_events")) {
      return { details_json: JSON.stringify({ request: requestDetails }) };
    }
    if (sql.includes("FROM ducks d")) {
      return {
        id: "duck_test",
        visible_number: 42,
        inventory_status: "RESERVED_FOR_EVENT",
        revision: 8,
        physical_condition: "GOOD",
        storage_location: null,
        notes: "Counted twice",
        event_duck_id: "event_duck_test",
        event_status: "REGISTRATION_CLOSED",
        active_assignment_id: null,
      };
    }
    return null;
  });
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks/duck_test", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        eventId: "event_test",
        expectedRevision: 7,
        notes: "Counted twice",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  assert.equal(db.batches.length, 0);
});

test("intake, replay, edit, tag lifecycle, and release execute against migrated SQLite", async () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff_test', 'staff-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'DRAFT');
  `);
  const env = makeEnv(sqliteD1(database));
  const intakeCommandId = crypto.randomUUID();
  const intakePayload = {
    commandId: intakeCommandId,
    eventId: "event_test",
    physicallyPresent: true,
    visibleNumber: 42,
    tagToken: "a".repeat(32),
    condition: "GOOD",
    location: "Intake",
    notes: "Present",
  };
  const intakeRequest = () => new Request("https://quickducks.com/api/v1/staff/inventory/ducks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intakePayload),
  });

  const intake = await handleDuckOperations(intakeRequest(), env, actor);
  const intakeBody = await intake.json();
  assert.equal(intake.status, 201);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);

  const replay = await handleDuckOperations(intakeRequest(), env, actor);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count, 1);

  const edit = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 0,
        visibleNumber: 43,
        location: "Ready rack",
      }),
    }),
    env,
    actor,
  );
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).duck.revision, 1);

  const replace = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}/tags/replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 1,
        tagToken: "b".repeat(32),
        physicalTagVerified: true,
      }),
    }),
    env,
    actor,
  );
  assert.equal(replace.status, 201);
  assert.deepEqual(
    database.prepare("SELECT status FROM duck_tags ORDER BY created_at, id").all().map((row) => row.status).sort(),
    ["ACTIVE", "RETIRED"],
  );

  const retire = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}/tags/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 2,
        reason: "Tag removed for repair",
        physicalTagRemoved: true,
      }),
    }),
    env,
    actor,
  );
  assert.equal(retire.status, 201);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_tags WHERE status = 'ACTIVE'").get().count, 0);
  const retiredDuck = database.prepare("SELECT inventory_status, physical_condition FROM ducks").get();
  assert.equal(retiredDuck.inventory_status, "QUARANTINED");
  assert.equal(retiredDuck.physical_condition, "NEEDS_TAG");

  const release = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}/reservations/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 3,
        reason: "Removed from this race",
      }),
    }),
    env,
    actor,
  );
  assert.equal(release.status, 201);
  assert.equal((await release.json()).duck.inventoryStatus, "QUARANTINED");
  assert.equal(database.prepare("SELECT released_at IS NOT NULL AS released FROM event_ducks").get().released, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("migration adds constrained inventory metadata and command-linked history", () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff', 'staff-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'DRAFT');
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('command', 'event', 'REGISTER_RACE_DUCK', 'duck', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition, storage_location, notes)
    VALUES ('duck', 42, 'RESERVED_FOR_EVENT', '2026-07-26T00:00:00Z', 'GOOD', 'INTAKE', 'Present');
    INSERT INTO duck_inventory_events
      (id, event_id, duck_id, action, actor_staff_profile_id, source_command_id, occurred_at, details_json)
    VALUES ('history', 'event', 'duck', 'DUCK_INTAKE', 'staff', 'command', '2026-07-26T00:00:00Z', '{}');
  `);

  assert.throws(() => database.exec(`
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('bad-duck', 43, 'AVAILABLE', '2026-07-26T00:00:00Z', 'UNKNOWN');
  `), /CHECK constraint failed/);
  database.exec("DELETE FROM race_commands WHERE id = 'command'");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_inventory_events").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
