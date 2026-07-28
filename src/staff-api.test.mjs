import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
import { handleApi } from "./api.ts";
import { handleStaffApi } from "./staff-api.ts";

const staffApiSource = readFileSync(new URL("./staff-api.ts", import.meta.url), "utf8");

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR"],
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

// The full ordered chain, so these run against the schema production runs.
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

test("authenticates a Cognito subject only when a matching staff profile exists", async () => {
  const db = makeDb(() => ({
    id: actor.id,
    cognito_sub: actor.cognitoSub,
    email: actor.email,
    display_name: actor.displayName,
    is_system_admin: 0,
  }), () => ({ results: actor.roles.map((role) => ({ role })) }));
  const request = new Request("https://quickducks.com/api/v1/staff/ducks/token", {
    headers: { authorization: "Bearer valid.jwt.token" },
  });
  const result = await authenticateStaff(request, makeEnv(db), async () => ({ sub: actor.cognitoSub }));

  assert.deepEqual(result, actor);
  assert.deepEqual(db.statements[0].args, [actor.cognitoSub]);
});

// `staff_role_assignments` now constrains `role` to the current vocabulary, so
// an unreadable stored set means the database was corrupted out of band. The
// session denies rather than authorizing whatever subset it could parse.
test("authentication denies a session whose stored roles are unreadable", async () => {
  for (const results of [
    [{ role: "ADMIN" }, { role: "REGISTRATION" }],
    [{ role: "RETURN_STEWARD" }],
    [{ role: "RETURN_STEWARD" }, { role: "REGISTRATION" }],
    [{ role: "registration" }],
    [{ role: null }],
    [{ role: "REGISTRATION" }, { role: "REGISTRATION" }],
  ]) {
    const db = makeDb(() => ({
      id: actor.id,
      cognito_sub: actor.cognitoSub,
      email: actor.email,
      display_name: actor.displayName,
      is_system_admin: 0,
    }), () => ({ results }));
    const result = await authenticateStaff(
      new Request("https://quickducks.com/api/v1/staff/events", {
        headers: { authorization: "Bearer valid.jwt.token" },
      }),
      makeEnv(db),
      async () => ({ sub: actor.cognitoSub }),
    );
    assert.equal(result, null, JSON.stringify(results));
  }
});

// A representable stored set still projects exactly its roles and nothing more.
test("authentication projects a valid stored role set without broadening it", async () => {
  const db = makeDb(() => ({
    id: actor.id,
    cognito_sub: actor.cognitoSub,
    email: actor.email,
    display_name: actor.displayName,
    is_system_admin: 0,
  }), () => ({ results: [{ role: "RACE_DIRECTOR" }, { role: "REGISTRATION" }] }));
  const result = await authenticateStaff(
    new Request("https://quickducks.com/api/v1/staff/events", {
      headers: { authorization: "Bearer valid.jwt.token" },
    }),
    makeEnv(db),
    async () => ({ sub: actor.cognitoSub }),
  );
  assert.notEqual(result, null);
  assert.deepEqual(result.roles, ["REGISTRATION", "RACE_DIRECTOR"]);
  assert.equal(result.isSystemAdmin, false);

  // A session holding no roles at all reaches no staff route.
  const roleless = { ...result, roles: [] };
  const denied = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(makeDb(() => null)),
    roleless,
  );
  assert.equal(denied.status, 403);
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
  }), () => ({ results: actor.roles.map((role) => ({ role })) }));
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

test("staff session revalidation returns authorization state without identity or PII", async () => {
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/session"),
    makeEnv(makeDb(() => null)),
    async () => actor,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    access: {
      isSystemAdmin: false,
      roles: actor.roles,
    },
  });
  assert.equal(JSON.stringify(body).includes(actor.id), false);
  assert.equal(JSON.stringify(body).includes(actor.email), false);
  assert.equal(JSON.stringify(body).includes(actor.displayName), false);
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
        roles: ["REGISTRATION"],
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
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
  const db = makeDb(
    () => null,
    () => ({
      results: [
        {
          id: "admin_test",
          email: "admin@example.com",
          display_name: "Admin Person",
          is_system_admin: 1,
          role_revision: 0,
          roles_csv: "",
          created_at: "2026-07-26T00:00:00Z",
        },
        {
          id: "staff_test",
          email: "staff@example.com",
          display_name: "Staff Person",
          is_system_admin: 0,
          role_revision: 2,
          roles_csv: "DUCK_MANAGER,REGISTRATION",
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
  assert.deepEqual(body.staff[0].roles, []);
  assert.deepEqual(body.staff[1].roles, ["REGISTRATION", "DUCK_MANAGER"]);
  assert.equal(body.staff[1].roleRevision, 2);
  assert.equal(JSON.stringify(body).includes("cognitoSub"), false);
});

test("an administrator creates passwordless regular staff with command and audit records", async () => {
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
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
        roles: ["REGISTRATION", "DUCK_MANAGER"],
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
  assert.equal(db.batches[0].filter((statement) => statement.sql.includes("INSERT INTO staff_role_assignments")).length, 2);
  const audit = db.batches[0].find((statement) => statement.sql.includes("staff_access_audit_events"));
  assert.deepEqual(JSON.parse(audit.args[5]), {
    accountType: "STAFF",
    roles: ["REGISTRATION", "DUCK_MANAGER"],
  });
});

// The grant path shares the strict role validator, so the retired role is a
// malformed request: no Cognito identity is created and no row is written.
test("granting staff access with the retired RETURN_STEWARD role is rejected", async () => {
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
  for (const roles of [["RETURN_STEWARD"], ["REGISTRATION", "RETURN_STEWARD"]]) {
    const db = makeDb(() => null);
    const provisioner = {
      async create() {
        assert.fail("an invalid role must not create a Cognito identity");
      },
      async delete() {
        assert.fail("nothing to delete");
      },
    };
    const response = await handleStaffApi(
      new Request("https://quickducks.com/api/v1/staff/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          email: "new.staff@example.com",
          displayName: "New Staff",
          role: "STAFF",
          roles,
        }),
      }),
      makeEnv(db),
      admin,
      provisioner,
    );

    assert.equal(response.status, 400, roles.join(","));
    assert.equal(db.batches.length, 0);
  }
});

test("an administrator can grant administrator role", async () => {
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
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
        roles: [],
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
  assert.equal(db.batches[0].some((statement) => statement.sql.includes("INSERT INTO staff_role_assignments")), false);
});

test("replaying a staff grant does not create another Cognito identity", async () => {
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
  const db = makeDb((sql) => {
    if (sql.includes("FROM staff_access_commands")) {
      return {
        id: "staff_replay",
        email: "staff@example.com",
         display_name: "Staff Person",
         is_system_admin: 0,
         role_revision: 0,
         roles_csv: "",
         requested_account_type: "STAFF",
         requested_roles_json: '["REGISTRATION"]',
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
        roles: ["REGISTRATION"],
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
  const admin = { ...actor, isSystemAdmin: true, roles: [] };
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
        roles: ["REGISTRATION"],
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

test("staff pairing search accepts code, name, email, or phone and returns protected contact details", async () => {
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
    new Request("https://quickducks.com/api/v1/staff/registrations/search?eventId=event_test&q=daisy%40example.com"),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(body.registrations[0].email, "daisy@example.com");
  assert.equal(body.registrations[0].phone, "555-0100");
  assert.match(db.statements[0].sql, /r\.email, r\.phone/);
  assert.match(db.statements[0].sql, /COALESCE\(r\.email, ''\) LIKE/);
  assert.match(db.statements[0].sql, /COALESCE\(r\.phone, ''\) LIKE/);
  assert.equal(db.statements[0].args.filter((value) => value === "%daisy@example.com%").length, 5);
});

const searchRow = (overrides = {}) => ({
  registration_id: "registration_test",
  race_entry_id: "entry_test",
  first_name: "Daisy",
  last_name: "Duck",
  email: "daisy@example.com",
  phone: "555-0100",
  lookup_code: "DAASY234",
  status: "SUBMITTED",
  visible_number: null,
  ...overrides,
});

const search = async (query, rows) => {
  const db = makeDb(() => null, () => ({ results: rows }));
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/registrations/search?eventId=event_test&q=${encodeURIComponent(query)}`),
    makeEnv(db),
    actor,
  );
  return response.json();
};

test("an exactly typed lookup code reports one unambiguous match to pair directly", async () => {
  const body = await search("DAASY234", [searchRow()]);

  assert.equal(body.exactMatch.lookupCode, "DAASY234");
  assert.equal(body.exactMatch.assignedDuckNumber, null);
  assert.equal(body.registrations.length, 1);
});

test("exact-code matching tolerates the spacing and case staff actually type", async () => {
  for (const typed of ["daasy234", " DAASY234 ", "daas-y234", "DAAS Y234"]) {
    const body = await search(typed, [searchRow()]);
    assert.equal(body.exactMatch?.lookupCode, "DAASY234", `"${typed}" must match exactly`);
  }
});

test("a partial or non-code search never reports an exact match", async () => {
  // A name search that happens to return one row still requires staff review.
  assert.equal((await search("Daisy", [searchRow()])).exactMatch, null);
  assert.equal((await search("DAASY23", [searchRow()])).exactMatch, null);
  assert.equal((await search("daisy@example.com", [searchRow()])).exactMatch, null);
  // A well-formed code with no matching registration reports nothing to pair.
  assert.equal((await search("ZZZZ2345", [searchRow()])).exactMatch, null);
});

test("an exact code already paired to a duck is reported for review, not auto-pairing", async () => {
  // The console falls through to the normal list, which names the duck holding
  // the code, instead of firing a pairing command that would be rejected.
  const body = await search("DAASY234", [searchRow({ visible_number: 128 })]);

  assert.equal(body.exactMatch.assignedDuckNumber, 128);
  assert.equal(body.registrations[0].assignedDuckNumber, 128);
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

test("staff inspection ignores a historical closed assignment after unassignment", async () => {
  const db = makeDb((sql) => ({
    duck_id: "duck_test",
    visible_number: 42,
    inventory_status: "RESERVED_FOR_EVENT",
    duck_revision: 2,
    tag_status: "ACTIVE",
    event_name: "Test Duck Race",
    event_status: "REGISTRATION_OPEN",
    assignment_id: sql.includes("da2.valid_to IS NULL") ? null : "closed_assignment",
    assignment_valid_to: "2026-07-26T11:00:00Z",
    event_id: "event_test",
    race_entry_id: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    lookup_code: null,
    registration_status: null,
    disposition: null,
  }));
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(body.pairingRequired, true);
  assert.equal(body.assignment, null);
  assert.match(db.statements[0].sql, /da2\.valid_to IS NULL/);
});

test("staff inspection still returns the current active assignment", async () => {
  const db = makeDb(() => ({
    duck_id: "duck_test",
    visible_number: 42,
    inventory_status: "IN_USE",
    duck_revision: 1,
    tag_status: "ACTIVE",
    event_name: "Test Duck Race",
    event_status: "REGISTRATION_OPEN",
    assignment_id: "active_assignment",
    assignment_valid_to: null,
    event_id: "event_test",
    race_entry_id: "entry_test",
    first_name: "Daisy",
    last_name: "Duck",
    email: "daisy@example.com",
    phone: "555-0100",
    lookup_code: "DAASY234",
    registration_status: "ACTIVE",
    disposition: null,
  }));
  const response = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(body.pairingRequired, false);
  assert.equal(body.assignment.id, "active_assignment");
  assert.equal(body.assignment.active, true);
  assert.equal(body.assignment.participant.firstName, "Daisy");
});

// A duck name is participant-written text that the public now sees, so the
// scanned-duck projection carries it — but only to the roles that may clear it,
// alongside the registration identifier the clear endpoint needs.
test("the scanned duck carries its chosen name only for roles that may moderate it", async () => {
  const pairedRow = (duckName) => () => ({
    duck_id: "duck_test",
    visible_number: 42,
    inventory_status: "IN_USE",
    duck_revision: 1,
    tag_status: "ACTIVE",
    event_name: "Test Duck Race",
    event_status: "ROUND_ONE",
    assignment_id: "active_assignment",
    assignment_valid_to: null,
    event_id: "event_test",
    race_entry_id: "entry_test",
    registration_id: "registration_test",
    duck_name: duckName,
    first_name: "Daisy",
    last_name: "Duck",
    email: "daisy@example.com",
    phone: "555-0100",
    lookup_code: "DAASY234",
    registration_status: "ACTIVE",
  });

  const allowed = await (await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(makeDb(pairedRow("Sir Quacks-a-Lot"))),
    { ...actor, roles: ["REGISTRATION"] },
  )).json();
  assert.equal(allowed.assignment.participant.duckName, "Sir Quacks-a-Lot");
  assert.equal(allowed.assignment.participant.duckNamePubliclyHidden, false);
  assert.equal(allowed.assignment.participant.registrationId, "registration_test");

  // A stored name the read-time filter suppresses is still shown to staff, and
  // flagged, because that is exactly the case they have to act on.
  const hidden = await (await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(makeDb(pairedRow("Bastard Duck"))),
    { ...actor, roles: ["RACE_DIRECTOR"] },
  )).json();
  assert.equal(hidden.assignment.participant.duckName, "Bastard Duck");
  assert.equal(hidden.assignment.participant.duckNamePubliclyHidden, true);

  // A duck manager keeps the narrow projection: no contact detail, no
  // registration identifier, and no duck name to act on.
  const narrow = await handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${"a".repeat(32)}`),
    makeEnv(makeDb(pairedRow("Sir Quacks-a-Lot"))),
    { ...actor, isSystemAdmin: false, roles: ["DUCK_MANAGER"] },
  );
  const narrowBody = await narrow.json();
  assert.deepEqual(Object.keys(narrowBody.assignment.participant), ["registrationStatus"]);
  assert.equal(JSON.stringify(narrowBody).includes("Sir Quacks-a-Lot"), false);
  assert.equal(JSON.stringify(narrowBody).includes("registration_test"), false);
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
        round_one_heat_capacity: 10,
        final_heat_capacity: 50,
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
  // Heats are always assigned while pairing; there is no other mode, and no
  // event can be left waiting for a retired planner.
  assert.equal(body.heatAssignmentPending, false);
  assert.deepEqual(body.heat, { round: "ROUND_ONE", number: 1 });
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO duck_assignments/);
  assert.match(sql, /SET status = 'ACTIVE'/);
  assert.match(sql, /inventory_status = 'IN_USE'/);
  assert.match(sql, /DUCK_ASSIGNED/);
  assert.match(sql, /INSERT INTO heats/);
  assert.match(sql, /INSERT INTO heat_entries/);
  assert.doesNotMatch(sql, /heat_assignment_mode/);
});

// Deleting a duck mid-race hands its participant back to the pairing queue with
// their heat place intact. Pairing them with another duck must therefore work
// while racing, and must reuse the heat entry they still hold rather than
// booking them a second slot.
test("re-pairing during a running race keeps the participant in the heat they are already in", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql.includes("FROM duck_tags")) {
      return {
        id: "duck_replacement",
        visible_number: 77,
        inventory_status: "AVAILABLE",
        revision: 0,
        active_assignment_id: null,
      };
    }
    if (sql.includes("FROM registrations")) {
      return {
        event_id: "event_test",
        round_one_heat_capacity: 10,
        final_heat_capacity: 50,
        registration_id: "registration_test",
        registration_status: "SUBMITTED",
        registration_revision: 2,
        race_entry_id: "entry_test",
        race_entry_revision: 1,
        first_name: "Daisy",
        last_name: "Duck",
        email: null,
        phone: null,
        lookup_code: "DAASY234",
        existing_heat_number: 3,
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
  assert.deepEqual(body.heat, { round: "ROUND_ONE", number: 3 }, "they keep the heat they were already in");
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO duck_assignments/);
  assert.match(sql, /SET status = 'ACTIVE'/);
  // No second heat place, and no new heat, for someone who already has one.
  assert.doesNotMatch(sql, /INSERT INTO heat_entries/);
  assert.doesNotMatch(sql, /INSERT INTO heats/);
});

// The lifecycle statuses pairing accepts are what allow the repair above.
test("pairing accepts a participant while a round is running", () => {
  assert.match(
    staffApiSource,
    /AND e\.status IN \('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL'\)/,
  );
});

test("immediate pairing rejects before creating a round-one heat beyond final capacity", async () => {
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
        heat_assignment_mode: "IMMEDIATE_FIXED",
        round_one_heat_capacity: 1,
        final_heat_capacity: 1,
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
    if (sql.includes("FROM event_ducks")) return null;
    if (sql.includes("COUNT(he.id) AS entry_count")) return null;
    if (sql.includes("COUNT(*) AS heat_count")) return { last_number: 1, heat_count: 1 };
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
  assert.match((await response.json()).error, /more round-one heats than the final can hold/i);
  assert.equal(db.batches.length, 0);
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
        round_one_heat_capacity: 10,
        final_heat_capacity: 50,
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

// Duck returns are no longer tracked, so every disposition, return-review, and
// staged-purge route that the legacy fallback used to own must be gone. The
// fallback answers 404 for an unknown path, and it must never touch D1.
const retiredStaffRoutes = [
  ["POST", `/api/v1/staff/ducks/${"a".repeat(32)}/dispositions`],
  ["POST", "/api/v1/staff/events/event_test/ducks/42/dispositions"],
  ["GET", "/api/v1/staff/events/return-review"],
  ["POST", "/api/v1/staff/events/event_test/purge-ready"],
  ["POST", "/api/v1/staff/events/event_test/purge-ready/cancel"],
  ["POST", "/api/v1/staff/events/event_test/purge"],
];

for (const [method, path] of retiredStaffRoutes) {
  test(`retired route ${method} ${path} is gone`, async () => {
    const db = makeDb(() => {
      throw new Error("a removed route must not read the database");
    });
    const response = await handleStaffApi(
      new Request(`https://quickducks.com${path}`, method === "GET" ? undefined : {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          eventId: "event_test",
          disposition: "RETURNED",
          confirmation: "DELETE Test Duck Race",
          returnReviewCompleted: true,
          permanentDeletionAcknowledged: true,
          reason: "correction reason",
        }),
      }),
      makeEnv(db),
      { ...actor, isSystemAdmin: true, roles: [] },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found." });
    assert.equal(db.batches.length, 0);
  });
}

// The scanned-duck projection is pairing and inspection only now. It must not
// advertise a disposition permission or leak a stored disposition value.
test("the staff duck projection no longer exposes returns", async () => {
  const db = makeDb(() => ({
    duck_id: "duck_test",
    visible_number: 42,
    inventory_status: "AVAILABLE",
    duck_revision: 1,
    tag_status: "ACTIVE",
    event_name: "Test Duck Race",
    event_status: "COMPLETED",
    assignment_id: null,
    assignment_valid_to: null,
    event_id: "event_test",
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
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.permissions), ["pair"]);
  assert.equal("disposition" in body, false);
  const sql = db.statements.map((statement) => statement.sql).join("\n");
  assert.doesNotMatch(sql, /duck_event_dispositions/);
});

const seedImmediatePairingEvent = (database, { ducksPerHeat, finalHeatCapacity }) => {
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('staff_test', 'staff-sub', 'staff@example.com', 'Staff Member', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('staff-registration', 'staff_test', 'REGISTRATION', '2026-07-26T00:00:00Z');
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity)
    VALUES
      ('event_test', 'test-race', 'Test Duck Race', '2026-08-30', 'UTC',
       'REGISTRATION_OPEN', 'IMMEDIATE_FIXED', ${ducksPerHeat}, ${finalHeatCapacity});
  `);
  const participants = [];
  for (const index of [1, 2, 3]) {
    const lookupCode = `DDDDDDD${index + 1}`;
    const token = String(index).repeat(32);
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

const pairRequest = (token, lookupCode) => new Request(
  `https://quickducks.com/api/v1/staff/ducks/${token}/assignments`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), eventId: "event_test", lookupCode }),
  },
);

test("immediate pairing fills heat one and atomically creates heat two in migrated SQLite", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const participants = seedImmediatePairingEvent(database, { ducksPerHeat: 2, finalHeatCapacity: 10 });
  const env = makeEnv(sqliteD1(database));

  const heatNumbers = [];
  for (const participant of participants) {
    const response = await handleStaffApi(pairRequest(participant.token, participant.lookupCode), env, actor);
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.heatAssignmentPending, false);
    heatNumbers.push(body.heat.number);
  }
  assert.deepEqual(heatNumbers, [1, 1, 2]);

  const heats = database.prepare(
    `SELECT heat_number, status, target_size, source_command_id,
            (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = heats.id) AS entry_count
       FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE'
      ORDER BY heat_number`,
  ).all();
  assert.deepEqual(heats.map((heat) => ({ ...heat, source_command_id: heat.source_command_id !== null })), [
    { heat_number: 1, status: "PLANNED", target_size: 2, source_command_id: true, entry_count: 2 },
    { heat_number: 2, status: "PLANNED", target_size: 2, source_command_id: true, entry_count: 1 },
  ]);
  const entries = database.prepare(
    `SELECT he.race_entry_id, h.heat_number, he.slot_number, he.assignment_source
       FROM heat_entries he JOIN heats h ON h.id = he.heat_id
      WHERE he.event_id = 'event_test' AND he.round = 'ROUND_ONE'
      ORDER BY h.heat_number, he.slot_number`,
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(entries, [
    { race_entry_id: "entry-1", heat_number: 1, slot_number: 1, assignment_source: "PAIRING" },
    { race_entry_id: "entry-2", heat_number: 1, slot_number: 2, assignment_source: "PAIRING" },
    { race_entry_id: "entry-3", heat_number: 2, slot_number: 1, assignment_source: "PAIRING" },
  ]);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM registrations WHERE event_id = 'event_test' AND status = 'ACTIVE'",
  ).get().count, 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("guarded pairing SQL rejects a concurrent overfill at the heat boundary and the retry opens heat two", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  const participants = seedImmediatePairingEvent(database, { ducksPerHeat: 2, finalHeatCapacity: 10 });

  const first = await handleStaffApi(
    pairRequest(participants[0].token, participants[0].lookupCode),
    makeEnv(sqliteD1(database)),
    actor,
  );
  assert.equal(first.status, 201);
  const heatOneId = database.prepare(
    "SELECT id FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE' AND heat_number = 1",
  ).get().id;

  // Simulate a concurrent pairing that takes the last open slot after this
  // request's preflight read but before its atomic batch commits.
  let raced = false;
  const racingEnv = makeEnv(sqliteD1(database, () => {
    if (raced) return;
    raced = true;
    database.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
       VALUES ('concurrent-entry', 'event_test', ?, 'entry-2', 'ROUND_ONE', 2, 'PAIRING', '2026-07-26T00:00:01Z')`,
    ).run(heatOneId);
  }));
  const overfillAttempt = await handleStaffApi(
    pairRequest(participants[2].token, participants[2].lookupCode),
    racingEnv,
    actor,
  );
  assert.equal(overfillAttempt.status, 409);
  assert.match((await overfillAttempt.json()).error, /conflicted with another update/i);

  // The whole pairing command rolled back: no overfilled slot, no assignment,
  // and the participant remains SUBMITTED for a clean retry.
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_entries WHERE heat_id = ?",
  ).get(heatOneId).count, 2);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heats WHERE event_id = 'event_test' AND round = 'ROUND_ONE'",
  ).get().count, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM duck_assignments WHERE race_entry_id = 'entry-3'",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT status FROM registrations WHERE id = 'registration-3'",
  ).get().status, "SUBMITTED");

  const retry = await handleStaffApi(
    pairRequest(participants[2].token, participants[2].lookupCode),
    makeEnv(sqliteD1(database)),
    actor,
  );
  const retryBody = await retry.json();
  assert.equal(retry.status, 201);
  assert.deepEqual(retryBody.heat, { round: "ROUND_ONE", number: 2 });
  const capacities = database.prepare(
    `SELECT h.heat_number,
            (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS entry_count
       FROM heats h WHERE h.event_id = 'event_test' AND h.round = 'ROUND_ONE'
      ORDER BY h.heat_number`,
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(capacities, [
    { heat_number: 1, entry_count: 2 },
    { heat_number: 2, entry_count: 1 },
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
