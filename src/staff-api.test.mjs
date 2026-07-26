import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  authentication: "bearer",
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

const migrationNames = [
  "0001_staff_identity.sql",
  "0002_registration_foundation.sql",
  "0003_assignment_and_heat_status.sql",
  "0004_pairing_status_and_purge.sql",
  "0005_staff_access_management.sql",
  "0006_participant_operations.sql",
  "0007_duck_inventory_operations.sql",
  "0008_event_operations.sql",
  "0009_heat_result_operations.sql",
  "0010_staff_lifecycle.sql",
  "0011_support_operations.sql",
];

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

test("authenticates staff from the host-only session cookie", async () => {
  const db = makeDb(() => ({
    id: actor.id,
    cognito_sub: actor.cognitoSub,
    email: actor.email,
    display_name: actor.displayName,
    is_system_admin: 0,
  }));
  const request = new Request("https://quickducks.com/staff", {
    headers: { cookie: "__Host-quickducks_staff=valid.jwt.token" },
  });
  const result = await authenticateStaff(request, makeEnv(db), async (token) => {
    assert.equal(token, "valid.jwt.token");
    return { sub: actor.cognitoSub };
  });

  assert.deepEqual(result, { ...actor, authentication: "cookie" });
});

test("requires same-origin protection for cookie-authenticated staff mutations", async () => {
  const db = makeDb(() => null);
  const cookieActor = { ...actor, authentication: "cookie" };
  const blocked = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/unknown", { method: "POST" }),
    makeEnv(db),
    async () => cookieActor,
  );
  const allowed = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/unknown", {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
    }),
    makeEnv(db),
    async () => cookieActor,
  );

  assert.equal(blocked.status, 403);
  assert.equal(allowed.status, 404);
});

test("regular staff cannot list or add staff access", async () => {
  const db = makeDb(() => null);
  let provisioned = false;
  const provisioner = {
    async create() {
      provisioned = true;
      throw new Error("should not run");
    },
    async delete() {},
  };
  const list = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles"),
    makeEnv(db),
    actor,
    provisioner,
  );
  const create = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        email: "new.staff@example.com",
        displayName: "New Staff",
        role: "STAFF",
      }),
    }),
    makeEnv(db),
    actor,
    provisioner,
  );

  assert.equal(list.status, 403);
  assert.equal(create.status, 403);
  assert.equal(provisioned, false);
  assert.equal(db.statements.length, 0);
});

test("administrators list staff without exposing Cognito subjects", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb(
    () => null,
    () => ({
      results: [
        {
          id: "admin_test",
          email: "admin@example.com",
          display_name: "Admin Person",
          is_system_admin: 1,
          created_at: "2026-07-26T00:00:00Z",
        },
        {
          id: "staff_test",
          email: "staff@example.com",
          display_name: "Staff Person",
          is_system_admin: 0,
          created_at: "2026-07-26T00:00:00Z",
        },
      ],
    }),
  );
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles"),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.staff.map((profile) => profile.role), ["ADMIN", "STAFF"]);
  assert.equal(JSON.stringify(body).includes("cognitoSub"), false);
});

test("an administrator creates passwordless regular staff with command and audit records", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb(() => null);
  const provisioner = {
    async create(email, displayName) {
      assert.equal(email, "new.staff@example.com");
      assert.equal(displayName, "New Staff");
      return { cognitoSub: "new-staff-sub", username: "new-staff-user", created: true };
    },
    async delete() {
      assert.fail("successful creation must not be deleted");
    },
  };
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        email: " New.Staff@Example.com ",
        displayName: "  New   Staff ",
        role: "STAFF",
      }),
    }),
    makeEnv(db),
    admin,
    provisioner,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.staff.email, "new.staff@example.com");
  assert.equal(body.staff.displayName, "New Staff");
  assert.equal(body.staff.role, "STAFF");
  assert.equal(db.batches.length, 1);
  const profileInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO staff_profiles"));
  assert.deepEqual(profileInsert.args.slice(1), ["new-staff-sub", "new.staff@example.com", "New Staff", 0, actor.id]);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO staff_access_commands/);
  assert.match(sql, /INSERT INTO staff_access_audit_events/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("staff_access_audit_events"));
  assert.equal(JSON.parse(audit.args[5]).role, "STAFF");
});

test("an administrator can grant administrator role", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb(() => null);
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        email: "another.admin@example.com",
        displayName: "Another Admin",
        role: "ADMIN",
      }),
    }),
    makeEnv(db),
    admin,
    {
      async create() {
        return { cognitoSub: "another-admin-sub", username: "another-admin-user", created: true };
      },
      async delete() {},
    },
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).staff.role, "ADMIN");
  const profileInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO staff_profiles"));
  assert.equal(profileInsert.args[4], 1);
});

test("replaying a staff grant does not create another Cognito identity", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb((sql) => {
    if (sql.includes("FROM staff_access_commands")) {
      return {
        id: "staff_replay",
        email: "staff@example.com",
        display_name: "Staff Person",
        is_system_admin: 0,
        created_at: "2026-07-26T00:00:00Z",
      };
    }
    return null;
  });
  let provisioned = false;
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370",
        email: "staff@example.com",
        displayName: "Staff Person",
        role: "STAFF",
      }),
    }),
    makeEnv(db),
    admin,
    {
      async create() {
        provisioned = true;
        throw new Error("should not run");
      },
      async delete() {},
    },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(provisioned, false);
  assert.equal(db.batches.length, 0);
});

test("a failed D1 grant removes a newly created Cognito identity", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb(() => null);
  db.batch = async () => {
    throw new Error("conflict");
  };
  const deleted = [];
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        email: "cleanup@example.com",
        displayName: "Cleanup Person",
        role: "STAFF",
      }),
    }),
    makeEnv(db),
    admin,
    {
      async create() {
        return { cognitoSub: "cleanup-sub", username: "cleanup-user", created: true };
      },
      async delete(username) {
        deleted.push(username);
      },
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(deleted, ["cleanup-user"]);
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

test("staff records a duck disposition and closes return state atomically", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("JOIN duck_tags")) {
      return {
        duck_id: "duck_test",
        visible_number: 42,
        event_duck_id: "event_duck_test",
        event_status: "COMPLETED",
        disposition_id: null,
        active_assignment_id: "assignment_test",
      };
    }
    return null;
  });
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}/dispositions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        disposition: "RETURNED",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.inventoryStatus, "AVAILABLE");
  assert.equal(body.eventStatus, "RETURN_PROCESSING");
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /RECORD_DUCK_DISPOSITION/);
  assert.match(sql, /status IN \('COMPLETED', 'RETURN_PROCESSING'\)/);
  assert.match(sql, /INSERT INTO duck_event_dispositions/);
  assert.match(sql, /UPDATE duck_assignments/);
  assert.match(sql, /UPDATE event_ducks/);
  assert.match(sql, /inventory_status = \?/);
  assert.match(sql, /status = 'RETURN_PROCESSING'/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO audit_events"));
  assert.equal(audit.args[3], "DUCK_DISPOSITION_RECORDED");
});

test("staff can explicitly correct a disposition during return processing", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("JOIN duck_tags")) {
      return {
        duck_id: "duck_test",
        visible_number: 42,
        event_duck_id: "event_duck_test",
        event_status: "RETURN_PROCESSING",
        disposition_id: "disposition_test",
        active_assignment_id: null,
      };
    }
    return null;
  });
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}/dispositions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        disposition: "DAMAGED",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 201);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /UPDATE duck_event_dispositions/);
  assert.doesNotMatch(sql, /INSERT INTO duck_event_dispositions/);
  assert.doesNotMatch(sql, /UPDATE duck_assignments/);
  const audit = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO audit_events"));
  assert.equal(audit.args[3], "DUCK_DISPOSITION_CORRECTED");
});

test("replaying a disposition command does not write a second disposition", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("SELECT event_id, command_type, result_id FROM race_commands")) {
      return {
        event_id: "event_test",
        command_type: "RECORD_DUCK_DISPOSITION",
        result_id: "disposition_test",
      };
    }
    if (sql.includes("FROM duck_event_dispositions ded")) {
      return {
        disposition_id: "disposition_test",
        disposition: "RETURNED",
        visible_number: 42,
        inventory_status: "AVAILABLE",
        event_status: "RETURN_PROCESSING",
      };
    }
    return null;
  });
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}/dispositions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370",
        eventId: "event_test",
        disposition: "RETURNED",
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  assert.equal(db.batches.length, 0);
});

test("staff records a missing duck by visible number when it cannot be scanned", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM ducks d") && sql.includes("d.visible_number = ?")) {
      return {
        duck_id: "duck_test",
        visible_number: 42,
        event_duck_id: "event_duck_test",
        event_status: "RETURN_PROCESSING",
        disposition_id: null,
        active_assignment_id: "assignment_test",
      };
    }
    return null;
  });
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/ducks/42/dispositions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), disposition: "MISSING" }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.duck.visibleNumber, 42);
  assert.equal(body.inventoryStatus, "MISSING");
  const duckUpdate = db.batches[0].find((statement) => statement.sql.includes("UPDATE ducks"));
  assert.equal(duckUpdate.args[0], "MISSING");
});

test("only a system administrator can mark an event purge-ready", async () => {
  const db = makeDb(() => null);
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        returnReviewCompleted: true,
        permanentDeletionAcknowledged: true,
      }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("return review identifies unresolved duck numbers without participant data", async () => {
  const db = makeDb(
    (sql) => {
      if (sql.includes("FROM events")) {
        return { id: "event_test", name: "Test Duck Race", status: "RETURN_PROCESSING" };
      }
      if (sql.includes("COUNT(*) AS total_count")) {
        return { total_count: 3, unresolved_count: 1, unreleased_count: 0 };
      }
      return null;
    },
    (sql) => {
      if (sql.includes("ded.id IS NULL")) return { results: [{ visible_number: 42 }] };
      if (sql.includes("GROUP BY disposition")) {
        return { results: [{ disposition: "RETURNED", disposition_count: 2 }] };
      }
      return { results: [] };
    },
  );
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/return-review"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.review.unresolvedDuckNumbers, [42]);
  assert.equal(body.review.dispositions.RETURNED, 2);
  assert.equal(JSON.stringify(body).includes("participant"), false);
});

test("purge readiness is blocked while a physical duck is unresolved", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("SELECT id, name, status FROM events")) {
      return { id: "event_test", name: "Test Duck Race", status: "RETURN_PROCESSING" };
    }
    if (sql.includes("FROM event_ducks ed") && sql.includes("ded.id IS NULL")) return { id: "event_duck_test" };
    return null;
  });
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        returnReviewCompleted: true,
        permanentDeletionAcknowledged: true,
      }),
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Every event duck/);
  assert.equal(db.batches.length, 0);
});

test("an administrator marks a fully reconciled event purge-ready", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb(
    (sql) => {
      if (sql.includes("FROM race_commands")) return null;
      if (sql.includes("SELECT id, name, status FROM events")) {
        return { id: "event_test", name: "Test Duck Race", status: "RETURN_PROCESSING" };
      }
      return null;
    },
    (sql) => sql.includes("FROM duck_event_dispositions")
      ? { results: [{ disposition: "RETURNED", disposition_count: 12 }] }
      : { results: [] },
  );
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        returnReviewCompleted: true,
        permanentDeletionAcknowledged: true,
      }),
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.event.status, "ARCHIVED");
  assert.equal(body.dispositions.RETURNED, 12);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /MARK_EVENT_PURGE_READY/);
  assert.match(sql, /status IN \('COMPLETED', 'RETURN_PROCESSING'\)/);
  assert.match(sql, /status = 'ARCHIVED'/);
  assert.match(sql, /EVENT_MARKED_PURGE_READY/);
});

test("an administrator can reopen purge readiness for a correction", async () => {
  const admin = { ...actor, isSystemAdmin: true };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("SELECT id, name, status FROM events")) {
      return { id: "event_test", name: "Test Duck Race", status: "ARCHIVED" };
    }
    return null;
  });
  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge-ready/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), reason: "Duck 42 needs correction" }),
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).event.status, "RETURN_PROCESSING");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /CANCEL_EVENT_PURGE_READY/);
  assert.match(sql, /status = 'ARCHIVED'/);
  assert.match(sql, /status = 'RETURN_PROCESSING'/);
  assert.match(sql, /EVENT_PURGE_READY_CANCELLED/);
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
    if (sql.includes("FROM event_purge_claims")) return { status: "PURGING" };
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
  assert.match(sql, /DELETE FROM email_attempts/);
  assert.match(sql, /DELETE FROM email_notifications/);
  assert.match(sql, /DELETE FROM heat_result_history/);
  assert.match(sql, /DELETE FROM heat_results/);
  assert.match(sql, /DELETE FROM return_batch_items/);
  assert.match(sql, /DELETE FROM return_batches/);
  assert.match(sql, /DELETE FROM duck_assignments/);
  assert.match(sql, /DELETE FROM duck_inventory_events/);
  assert.match(sql, /DELETE FROM registrations/);
  assert.match(sql, /DELETE FROM audit_events/);
  assert.equal(db.batches[0].find((statement) => statement.sql.includes("audit_events")).sql, "DELETE FROM audit_events");
  assert.match(sql, /DELETE FROM events/);
  assert.match(sql, /DELETE FROM duck_tags/);
  assert.match(sql, /DELETE FROM ducks/);
  assert.match(sql, /DELETE FROM browser_registration_collections/);
  assert.equal(response.headers.get("clear-site-data"), '"cache", "cookies", "storage"');
});

test("final purge executes against the complete migrated schema", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('staff_test', 'staff-sub', 'staff@example.com', 'Staff Member', 1, 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Duck Race', 'UTC', 'ARCHIVED');
    INSERT INTO event_purge_claims
      (event_id, command_id, status, claimed_by_staff_profile_id, claimed_at)
    VALUES
      ('event_test', 'claim-command', 'PURGING', 'staff_test', '2026-07-26T00:00:00Z');
  `);

  const response = await handleStaffApi(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE Test Duck Race" }),
    }),
    makeEnv(sqliteD1(database)),
    { ...actor, isSystemAdmin: true },
  );

  assert.equal(response.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_purge_claims").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
