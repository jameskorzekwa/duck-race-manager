import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";
import { handleEventOperations } from "./event-operations.ts";

const staff = {
  id: "staff_regular",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: [],
  authentication: "bearer",
};
const director = { ...staff, id: "staff_director", roles: ["RACE_DIRECTOR"] };
const admin = { ...staff, id: "admin_test", isSystemAdmin: true, roles: [] };

const midRaceEvent = {
  id: "event_test",
  slug: "test-race",
  name: "Test Duck Race",
  event_date: "2026-08-30",
  timezone: "UTC",
  status: "ROUND_ONE",
  registration_opens_at: null,
  registration_closes_at: null,
  email_required: 0,
  heat_assignment_mode: "POST_CLOSE_BALANCED",
  round_one_heat_capacity: 10,
  final_heat_capacity: 50,
  public_name_policy: "FIRST_NAME_LAST_INITIAL",
  revision: 4,
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:00.000Z",
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
      return items.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
};

const makeEnv = (db) => ({ APP_ORIGIN: "https://quickducks.com", DB: db });

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
    database.exec("BEGIN IMMEDIATE");
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

const forceDeleteRequest = (body, headers = {}) => new Request(
  "https://quickducks.com/api/v1/staff/events/event_test/force-delete",
  {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  },
);

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const migratedDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin_test', 'admin-sub', 'admin@example.com', 'Administrator', 1, 1),
      ('staff_director', 'director-sub', 'director@example.com', 'Race Director', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('director-role', 'staff_director', 'RACE_DIRECTOR', '2026-07-26T00:00:00Z');
  `);
  return database;
};

// Seeds one complete mid-race dataset covering every event-linked table in the
// migrated schema, independent of the event status under test.
const seedFullEventDataset = (database, status, withPurgeClaim) => {
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Duck Race', '2026-08-30', 'UTC', '${status}');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, status, lookup_code, private_token_hash,
       email_notifications_enabled, submitted_at, status_changed_at)
    VALUES
      ('registration', 'event_test', 'Daisy', 'Duck', 'daisy@example.com', 'ACTIVE', 'DAISY123',
       'private-hash', 1, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry', 'event_test', 'registration');
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES
      ('11111111-1111-4111-8111-111111111111', 'event_test', 'PAIR_DUCK', 'assignment',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('22222222-2222-4222-8222-222222222222', 'event_test', 'FINALIZE_HEAT_RESULTS', 'heat',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
      ('33333333-3333-4333-8333-333333333333', 'event_test', 'RECORD_DUCK_DISPOSITION', 'disposition',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck', 1, 'IN_USE', '2026-07-26T00:00:00Z');
    INSERT INTO duck_tags (id, duck_id, token, status)
    VALUES ('tag', 'duck', '${"t".repeat(32)}', 'ACTIVE');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck', 'event_test', 'duck', '2026-07-26T00:00:00Z', 'admin_test');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES
      ('assignment', 'event_test', 'entry', 'event-duck', 'duck', '2026-07-26T00:00:00Z',
       'admin_test', '11111111-1111-4111-8111-111111111111');
    INSERT INTO duck_inventory_events
      (id, event_id, duck_id, action, actor_staff_profile_id, source_command_id, occurred_at, details_json)
    VALUES
      ('inventory-event', 'event_test', 'duck', 'DUCK_ASSIGNED', 'admin_test',
       '11111111-1111-4111-8111-111111111111', '2026-07-26T00:00:00Z', '{}');
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('heat', 'event_test', 'ROUND_ONE', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('heat-entry', 'event_test', 'heat', 'entry', 'ROUND_ONE', 1, 'PAIRING', '2026-07-26T00:00:00Z');
    UPDATE heats
       SET status = 'FINALIZED', roster_locked_at = '2026-07-26T01:00:00Z',
           started_at = '2026-07-26T01:00:00Z', finished_at = '2026-07-26T01:05:00Z',
           finalized_at = '2026-07-26T01:10:00Z'
     WHERE id = 'heat';
    INSERT INTO heat_results
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id)
    VALUES
      ('heat-result', 'event_test', 'heat', 'entry', 'assignment', 1, 'FINALIZED', 2,
       '2026-07-26T01:10:00Z', 'admin_test', '22222222-2222-4222-8222-222222222222');
    INSERT INTO heat_result_history
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
       finalized_at, recorded_by_staff_profile_id, source_command_id, invalidated_at,
       invalidated_by_staff_profile_id, invalidated_by_source_command_id, invalidation_reason, created_at)
    VALUES
      ('result-history', 'event_test', 'heat', 'entry', 'assignment', 1, 'SUPERSEDED', 1,
       '2026-07-26T01:08:00Z', 'admin_test', '22222222-2222-4222-8222-222222222222',
       '2026-07-26T01:09:00Z', 'admin_test', '22222222-2222-4222-8222-222222222222',
       'Correction test', '2026-07-26T01:08:00Z');
    INSERT INTO email_notifications (id, event_id, registration_id, heat_id, notification_type, status)
    VALUES ('notification', 'event_test', 'registration', 'heat', 'HEAT_ASSIGNED', 'PENDING');
    INSERT INTO email_attempts (id, event_id, notification_id, attempt_number, stage, status, started_at)
    VALUES ('attempt', 'event_test', 'notification', 1, 'QUEUE', 'PENDING', '2026-07-26T02:00:00Z');
    INSERT INTO return_batches
      (id, event_id, status, source_command_id, started_by_staff_profile_id, started_at)
    VALUES ('batch', 'event_test', 'OPEN', 'batch-command', 'admin_test', '2026-07-26T03:00:00Z');
    INSERT INTO return_batch_items
      (id, event_id, batch_id, event_duck_id, sequence_number, disposition, source_command_id,
       added_by_staff_profile_id, added_at)
    VALUES
      ('batch-item', 'event_test', 'batch', 'event-duck', 1, 'RETURNED', 'item-command',
       'admin_test', '2026-07-26T03:01:00Z');
    INSERT INTO duck_event_dispositions
      (id, event_id, event_duck_id, disposition, recorded_by_staff_profile_id, source_command_id, recorded_at)
    VALUES
      ('disposition', 'event_test', 'event-duck', 'RETURNED', 'admin_test',
       '33333333-3333-4333-8333-333333333333', '2026-07-26T03:02:00Z');
    INSERT INTO browser_registration_collections (id, token_hash, created_at, last_seen_at, expires_at)
    VALUES ('collection', 'collection-hash', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', '2027-07-26T00:00:00Z');
    INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at)
    VALUES ('collection', 'registration', '2026-07-26T00:00:00Z');
    INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
    VALUES
      ('audit', 'event_test', '11111111-1111-4111-8111-111111111111', 'DUCK_PAIRED', 'RACE_ENTRY',
       'entry', 'STAFF', '2026-07-26T00:00:00Z', '{}');
  `);
  if (withPurgeClaim) {
    database.exec(`
      INSERT INTO event_purge_claims (event_id, command_id, status, claimed_by_staff_profile_id, claimed_at)
      VALUES ('event_test', 'claim-command', 'PURGING', 'admin_test', '2026-07-26T04:00:00Z');
    `);
  }
};

const eventLinkedTables = [
  "events",
  "registrations",
  "race_entries",
  "ducks",
  "duck_tags",
  "event_ducks",
  "duck_assignments",
  "duck_inventory_events",
  "duck_event_dispositions",
  "heats",
  "heat_entries",
  "heat_results",
  "heat_result_history",
  "email_notifications",
  "email_attempts",
  "return_batches",
  "return_batch_items",
  "browser_registration_collections",
  "browser_collection_registrations",
  "race_commands",
  "audit_events",
  "event_purge_claims",
];

const count = (database, table) =>
  database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

test("force delete rejects regular staff and race directors without touching the database", async () => {
  for (const actor of [staff, director]) {
    const db = makeDb(() => null);
    const response = await handleEventOperations(
      forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
      makeEnv(db),
      actor,
    );
    assert.equal(response.status, 403);
    assert.equal(db.statements.length, 0);
    assert.equal(db.batches.length, 0);
  }
});

test("force delete requires staff authentication before any role decision", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
    makeEnv(db),
    async () => null,
  );
  assert.equal(response.status, 401);
  assert.equal(db.statements.length, 0);
});

test("cookie-authenticated force delete requires the exact application origin", async () => {
  const cookieAdmin = { ...admin, authentication: "cookie" };
  const crossOrigin = makeDb(() => null);
  const denied = await handleApi(
    forceDeleteRequest(
      { commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" },
      { origin: "https://evil.example.com" },
    ),
    makeEnv(crossOrigin),
    async () => cookieAdmin,
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Same-origin staff request required." });
  assert.equal(crossOrigin.statements.length, 0);

  const missingOrigin = makeDb(() => null);
  const alsoDenied = await handleApi(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
    makeEnv(missingOrigin),
    async () => cookieAdmin,
  );
  assert.equal(alsoDenied.status, 403);
  assert.equal(missingOrigin.statements.length, 0);

  const sameOrigin = makeDb(() => null);
  const allowed = await handleApi(
    forceDeleteRequest(
      { commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" },
      { origin: "https://quickducks.com" },
    ),
    makeEnv(sameOrigin),
    async () => cookieAdmin,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { deleted: true, alreadyDeleted: true });
});

test("force delete validates command, revision, and typed name before database access", async () => {
  for (const body of [
    { revision: 0, confirmName: "Test Duck Race" },
    { commandId: "not-a-uuid", revision: 0, confirmName: "Test Duck Race" },
    { commandId: crypto.randomUUID(), revision: -1, confirmName: "Test Duck Race" },
    { commandId: crypto.randomUUID(), revision: 1.5, confirmName: "Test Duck Race" },
    { commandId: crypto.randomUUID(), revision: 0 },
    { commandId: crypto.randomUUID(), revision: 0, confirmName: "" },
  ]) {
    const db = makeDb(() => null);
    const response = await handleEventOperations(forceDeleteRequest(body), makeEnv(db), admin);
    assert.equal(response.status, 400);
    assert.equal(db.statements.length, 0);
  }
});

test("a wrong typed event name refuses with 422 and writes nothing", async () => {
  const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : midRaceEvent);
  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 4, confirmName: "Wrong Name" }),
    makeEnv(db),
    admin,
  );
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /exact event name/);
  assert.equal(db.batches.length, 0);
});

test("a stale revision refuses with 409, returns the current event, and writes nothing", async () => {
  const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : midRaceEvent);
  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 3, confirmName: "Test Duck Race" }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /Refresh/);
  assert.equal(body.event.revision, 4);
  assert.equal(db.batches.length, 0);
});

test("force delete removes the complete dataset in one guarded batch with bound values", async () => {
  // The only-event preflight (`id != ?`) finds no other event; every other
  // lookup returns the event under test.
  const db = makeDb((sql) =>
    sql.includes("FROM race_commands") || sql.includes("id != ?") ? null : midRaceEvent);
  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 4, confirmName: "Test Duck Race" }),
    makeEnv(db),
    admin,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, alreadyDeleted: false });
  assert.equal(db.batches.length, 1);
  const statements = db.batches[0];
  const sql = statements.map((statement) => statement.sql).join("\n");
  for (const table of eventLinkedTables.filter((table) => table !== "events")) {
    assert.match(sql, new RegExp(`DELETE FROM ${table}`), `missing DELETE FROM ${table}`);
  }
  assert.match(sql, /DELETE FROM events/);
  assert.match(sql, /'FORCE_DELETE_EVENT'/);
  assert.match(sql, /e\.revision = \?/);
  assert.match(sql, /SET status = 'ARCHIVED'/);
  assert.match(sql, /'PURGING'/);
  assert.ok(statements.every((statement) => statement.args.length > 0));
  assert.match(
    statements[0].sql,
    /NOT EXISTS \(SELECT 1 FROM events WHERE id != \?\)/,
    "sentinel insert must re-check the only-event invariant inside the batch",
  );
  const guarded = statements.filter((statement) => statement.sql.startsWith("DELETE FROM"));
  assert.ok(guarded.every((statement) => /EXISTS \(\s*SELECT 1 FROM (?:race_commands|event_purge_claims)/.test(statement.sql)));
});

for (const [status, withPurgeClaim] of [
  ["REGISTRATION_OPEN", false],
  ["ROUND_ONE", false],
  ["RETURN_PROCESSING", true],
  ["ARCHIVED", true],
]) {
  test(`migrated SQLite force delete clears every event-linked row from ${status}${withPurgeClaim ? " with an active purge claim" : ""}`, async (context) => {
    const database = migratedDatabase();
    context.after(() => database.close());
    seedFullEventDataset(database, status, withPurgeClaim);
    const env = makeEnv(sqliteD1(database));
    const seededCommands = count(database, "race_commands");

    const wrongName = await handleEventOperations(
      forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "DELETE Test Duck Race" }),
      env,
      admin,
    );
    assert.equal(wrongName.status, 422);
    const staleRevision = await handleEventOperations(
      forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 7, confirmName: "Test Duck Race" }),
      env,
      admin,
    );
    assert.equal(staleRevision.status, 409);
    const denied = await handleEventOperations(
      forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
      env,
      director,
    );
    assert.equal(denied.status, 403);
    assert.equal(count(database, "events"), 1);
    assert.equal(count(database, "registrations"), 1);
    assert.equal(count(database, "race_commands"), seededCommands);
    assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status, status);

    const commandId = crypto.randomUUID();
    const response = await handleEventOperations(
      forceDeleteRequest({ commandId, revision: 0, confirmName: "Test Duck Race" }),
      env,
      admin,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, alreadyDeleted: false });
    for (const table of eventLinkedTables) {
      assert.equal(count(database, table), 0, `expected ${table} to be empty`);
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(count(database, "staff_profiles"), 2);
    assert.equal(count(database, "staff_role_assignments"), 1);
    assert.equal(count(database, "organization_event_defaults"), 1);

    const replay = await handleEventOperations(
      forceDeleteRequest({ commandId, revision: 0, confirmName: "Test Duck Race" }),
      env,
      admin,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { deleted: true, alreadyDeleted: true });
    for (const table of eventLinkedTables) {
      assert.equal(count(database, table), 0);
    }
  });
}

test("a command identifier still recorded for another operation returns 409 without writes", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  seedFullEventDataset(database, "ROUND_ONE", false);
  const env = makeEnv(sqliteD1(database));

  const reuse = await handleEventOperations(
    forceDeleteRequest({
      commandId: "11111111-1111-4111-8111-111111111111",
      revision: 0,
      confirmName: "Test Duck Race",
    }),
    env,
    admin,
  );
  assert.equal(reuse.status, 409);
  assert.match((await reuse.json()).error, /already used/);
  assert.equal(count(database, "events"), 1);
  assert.equal(count(database, "registrations"), 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a second event refuses with 409 and deletes nothing", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  seedFullEventDataset(database, "ROUND_ONE", false);
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status)
    VALUES ('event_other', 'other-race', 'Other Duck Race', '2026-09-30', 'UTC', 'DRAFT');
  `);
  const env = makeEnv(sqliteD1(database));
  const before = Object.fromEntries(
    eventLinkedTables.map((table) => [table, count(database, table)]),
  );

  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
    env,
    admin,
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /only race dataset/);
  assert.equal(count(database, "events"), 2);
  for (const table of eventLinkedTables) {
    assert.equal(count(database, table), before[table], `expected ${table} to be untouched`);
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a second event created between preflight and batch makes the batch delete nothing", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  seedFullEventDataset(database, "ROUND_ONE", false);
  const d1 = sqliteD1(database);
  const raced = {
    prepare: (sql) => d1.prepare(sql),
    async batch(items) {
      // Another administrator creates a second event after the preflight check.
      database.exec(`
        INSERT INTO events (id, slug, name, event_date, timezone, status)
        VALUES ('event_other', 'other-race', 'Other Duck Race', '2026-09-30', 'UTC', 'DRAFT');
      `);
      return d1.batch(items);
    },
  };

  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
    makeEnv(raced),
    admin,
  );
  assert.equal(response.status, 409);
  assert.equal(count(database, "events"), 2);
  assert.equal(count(database, "registrations"), 1);
  assert.equal(count(database, "ducks"), 1);
  assert.equal(count(database, "duck_tags"), 1);
  assert.equal(count(database, "audit_events"), 1);
  assert.equal(count(database, "browser_registration_collections"), 1);
  assert.equal(count(database, "browser_collection_registrations"), 1);
  assert.equal(count(database, "race_commands"), 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a concurrent revision change makes the guarded batch delete nothing", async (context) => {
  const database = migratedDatabase();
  context.after(() => database.close());
  seedFullEventDataset(database, "REGISTRATION_OPEN", false);
  const d1 = sqliteD1(database);
  const raced = {
    prepare: (sql) => d1.prepare(sql),
    async batch(items) {
      // Another administrator bumps the revision between preflight and batch.
      database.exec("UPDATE events SET revision = revision + 1 WHERE id = 'event_test'");
      return d1.batch(items);
    },
  };

  const response = await handleEventOperations(
    forceDeleteRequest({ commandId: crypto.randomUUID(), revision: 0, confirmName: "Test Duck Race" }),
    makeEnv(raced),
    admin,
  );
  assert.equal(response.status, 409);
  assert.equal(count(database, "events"), 1);
  assert.equal(count(database, "registrations"), 1);
  assert.equal(count(database, "heats"), 1);
  assert.equal(count(database, "audit_events"), 1);
  assert.equal(count(database, "race_commands"), 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
