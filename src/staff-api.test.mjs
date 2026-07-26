import assert from "node:assert/strict";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
import { handleApi } from "./api.ts";
import { handleStaffApi } from "./staff-api.ts";

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
};

const makeDb = (first, all = () => ({ results: [] })) => {
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
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  DB: db,
});

test("authenticates a Cognito subject only when a matching staff profile exists", async () => {
  const db = makeDb(() => ({
    id: actor.id,
    cognito_sub: actor.cognitoSub,
    email: actor.email,
    display_name: actor.displayName,
    is_system_admin: 0,
  }));
  const request = new Request("https://quickducks.com/api/v1/staff/ducks/token", {
    headers: { authorization: "Bearer valid.jwt.token" },
  });
  const result = await authenticateStaff(request, makeEnv(db), async () => ({ sub: actor.cognitoSub }));

  assert.deepEqual(result, actor);
  assert.deepEqual(db.statements[0].args, [actor.cognitoSub]);
});

test("rejects anonymous staff API requests", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(db),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
});

test("staff name search may return contact details", async () => {
  const db = makeDb(
    () => null,
    () => ({
      results: [{
        registration_id: "registration_test",
        race_entry_id: "entry_test",
        first_name: "Daisy",
        last_name: "Duck",
        email: "daisy@example.com",
        phone: "555-0100",
        lookup_code: "DAASY234",
        status: "SUBMITTED",
        visible_number: null,
      }],
    }),
  );
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/registrations/search?eventId=event_test&q=Daisy"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(body.registrations[0].email, "daisy@example.com");
  assert.equal(body.registrations[0].phone, "555-0100");
  assert.match(db.statements[0].sql, /r\.email, r\.phone/);
});

test("staff inspection does not offer pairing for an ineligible duck", async () => {
  const db = makeDb(() => ({
    duck_id: "duck_test",
    visible_number: 42,
    inventory_status: "DAMAGED",
    duck_revision: 1,
    tag_status: "ACTIVE",
    assignment_id: null,
    event_id: null,
    race_entry_id: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    lookup_code: null,
    registration_status: null,
  }));
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).pairingRequired, false);
});

test("staff pairs the scanned duck with a code-selected participant atomically", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM duck_tags")) {
      return {
        id: "duck_test",
        visible_number: 42,
        inventory_status: "AVAILABLE",
        revision: 0,
        active_assignment_id: null,
      };
    }
    if (sql.includes("FROM registrations")) {
      return {
        event_id: "event_test",
        heat_assignment_mode: "POST_CLOSE_BALANCED",
        round_one_heat_capacity: 10,
        registration_id: "registration_test",
        registration_status: "SUBMITTED",
        registration_revision: 0,
        race_entry_id: "entry_test",
        race_entry_revision: 0,
        first_name: "Daisy",
        last_name: "Duck",
        email: "daisy@example.com",
        phone: "555-0100",
        lookup_code: "DAASY234",
      };
    }
    if (sql.includes("FROM event_ducks")) return null;
    return null;
  });
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        lookupCode: "DAASY234",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.duck.visibleNumber, 42);
  assert.equal(body.participant.firstName, "Daisy");
  assert.equal(body.participant.email, "daisy@example.com");
  assert.equal(body.heatAssignmentPending, true);
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO duck_assignments/);
  assert.match(sql, /SET status = 'ACTIVE'/);
  assert.match(sql, /inventory_status = 'IN_USE'/);
  assert.match(sql, /DUCK_ASSIGNED/);
});

test("staff cannot pair a reserved duck whose inventory state is unsafe", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM duck_tags")) {
      return {
        id: "duck_test",
        visible_number: 42,
        inventory_status: "DAMAGED",
        revision: 0,
        active_assignment_id: null,
      };
    }
    if (sql.includes("FROM registrations")) {
      return {
        event_id: "event_test",
        heat_assignment_mode: "POST_CLOSE_BALANCED",
        round_one_heat_capacity: 10,
        registration_id: "registration_test",
        registration_status: "SUBMITTED",
        registration_revision: 0,
        race_entry_id: "entry_test",
        race_entry_revision: 0,
        first_name: "Daisy",
        last_name: "Duck",
        email: null,
        phone: null,
        lookup_code: "DAASY234",
      };
    }
    if (sql.includes("FROM event_ducks")) return { id: "event_duck_test", event_id: "event_test" };
    return null;
  });
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}/assignments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        lookupCode: "DAASY234",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 409);
  assert.equal(db.batches.length, 0);
});

test("only a system administrator can purge a race", async () => {
  const db = makeDb(() => null);
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE Test Duck Race" }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("purge deletes the complete race, duck, tag, browser, and audit dataset", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb((sql) => {
    if (sql.includes("SELECT id, name, status FROM events")) {
      return { id: "event_test", name: "Test Duck Race", status: "ARCHIVED" };
    }
    if (sql.includes("WHERE id !=")) return null;
    if (sql.includes("LEFT JOIN duck_event_dispositions")) return null;
    return null;
  });
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE Test Duck Race" }),
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 204);
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /DELETE FROM browser_collection_registrations/);
  assert.match(sql, /DELETE FROM heat_results/);
  assert.match(sql, /DELETE FROM duck_assignments/);
  assert.match(sql, /DELETE FROM registrations/);
  assert.match(sql, /DELETE FROM audit_events/);
  assert.equal(db.batches[0].find((statement) => statement.sql.includes("audit_events")).sql, "DELETE FROM audit_events");
  assert.match(sql, /DELETE FROM events/);
  assert.match(sql, /DELETE FROM duck_tags/);
  assert.match(sql, /DELETE FROM ducks/);
  assert.match(sql, /DELETE FROM browser_registration_collections/);
  assert.equal(response.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
});
