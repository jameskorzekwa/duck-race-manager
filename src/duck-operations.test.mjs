import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleDuckOperations } from "./duck-operations.ts";
import { getPublicStatusByTag } from "./race-status.ts";

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

// The full ordered chain, so these run against the schema production runs.
const migrationNames = readdirSync(new URL("../db/migrations/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

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
    database.exec("BEGIN IMMEDIATE");
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
  // Returns are no longer tracked, so no disposition is projected or read.
  assert.equal("disposition" in body.ducks[0], false);
  assert.doesNotMatch(db.statements[0].sql, /duck_event_dispositions/);
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

test("provisioning start generates the number and token in an atomic pending-only batch", async () => {
  let db;
  db = makeDb((sql) => {
    if (sql.includes("FROM race_commands rc") && sql.includes("ORDER BY rc.requested_at")) return null;
    if (sql.includes("SELECT event_id, command_type")) return null;
    if (sql.includes("SELECT id FROM events")) return { id: "event_test" };
    if (sql.includes("FROM race_commands rc") && sql.includes("AND rc.id = ?") && db.batches.length === 1) {
      const tagInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO duck_tags"));
      const commandInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO race_commands"));
      return {
        provisioning_command_id: commandInsert.args[0],
        event_id: "event_test",
        duck_id: commandInsert.args[1],
        visible_number: 43,
        inventory_status: "NEW",
        physical_condition: "NEEDS_TAG",
        storage_location: "Intake table",
        tag_id: tagInsert.args[0],
        tag_token: tagInsert.args[2],
        tag_status: "RESERVED",
        event_duck_id: null,
      };
    }
    return null;
  });
  const commandId = crypto.randomUUID();
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        eventId: "event_test",
        location: "Intake table",
      }),
    }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.provisioningCommandId, commandId);
  assert.equal(body.visibleNumber, 43);
  assert.equal(body.status, "PENDING_WRITE");
  assert.match(body.tagUrl, /^https:\/\/quickducks\.com\/t\/[A-Za-z0-9_-]{43}$/);
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  const command = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO race_commands"));
  assert.match(command.sql, /START_DUCK_PROVISIONING/);
  assert.match(command.sql, /MAX\(visible_number\)/);
  assert.match(sql, /INSERT INTO ducks/);
  assert.match(sql, /'NEW'/);
  assert.match(sql, /'NEEDS_TAG'/);
  assert.match(sql, /INSERT INTO duck_tags/);
  assert.match(sql, /'RESERVED'/);
  assert.doesNotMatch(sql, /INSERT INTO event_ducks/);
  assert.doesNotMatch(sql, /INSERT INTO duck_inventory_events/);
  assert.match(sql, /INSERT INTO audit_events/);
  const tagInsert = db.batches[0].find((statement) => statement.sql.includes("INSERT INTO duck_tags"));
  const generatedToken = tagInsert.args[2];
  assert.equal(generatedToken.length, 43);
  assert.equal(body.tagUrl.endsWith(generatedToken), true);
  for (const statement of db.batches[0].filter((item) => item !== tagInsert)) {
    assert.equal(JSON.stringify(statement.args).includes(generatedToken), false);
  }
});

test("simultaneous migrated-SQLite provisioning starts recover or allocate without duplicates", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES
      ('staff_test', 'staff-sub', 'staff@example.com'),
      ('staff_other', 'other-sub', 'other@example.com'),
      ('staff_third', 'third-sub', 'third@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_OPEN');
  `);
  const env = makeEnv(sqliteD1(database));
  const otherActor = { ...actor, id: "staff_other", cognitoSub: "other-sub", email: "other@example.com" };
  const thirdActor = { ...actor, id: "staff_third", cognitoSub: "third-sub", email: "third@example.com" };
  const startRequest = (commandId) => new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, eventId: "event_test", location: "Concurrent intake" }),
  });
  const start = (staffActor, commandId) => handleDuckOperations(startRequest(commandId), env, staffActor);

  const sameActorCommands = [crypto.randomUUID(), crypto.randomUUID()];
  const sameActorResponses = await Promise.all(sameActorCommands.map((commandId) => start(actor, commandId)));
  assert.deepEqual(sameActorResponses.map((response) => response.status).sort(), [200, 201]);
  const sameActorResults = await Promise.all(sameActorResponses.map((response) => response.json()));
  assert.equal(sameActorResults[0].duckId, sameActorResults[1].duckId);
  assert.equal(sameActorResults[0].provisioningCommandId, sameActorResults[1].provisioningCommandId);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_DUCK_PROVISIONING'",
  ).get().count, 1);

  const differentStarts = [
    { staffActor: otherActor, commandId: crypto.randomUUID() },
    { staffActor: thirdActor, commandId: crypto.randomUUID() },
  ];
  const firstResponses = await Promise.all(
    differentStarts.map(({ staffActor, commandId }) => start(staffActor, commandId)),
  );
  const finalResponses = [];
  for (const [index, response] of firstResponses.entries()) {
    finalResponses.push(response.status === 409
      ? await start(differentStarts[index].staffActor, differentStarts[index].commandId)
      : response);
  }
  for (const response of finalResponses) {
    assert.equal(response.status === 200 || response.status === 201, true);
  }
  const differentResults = await Promise.all(finalResponses.map((response) => response.json()));
  assert.equal(new Set(differentResults.map((result) => result.duckId)).size, 2);
  assert.equal(new Set(differentResults.map((result) => result.visibleNumber)).size, 2);

  const duckCounts = database.prepare(
    "SELECT COUNT(*) AS count, COUNT(DISTINCT visible_number) AS unique_count FROM ducks",
  ).get();
  assert.equal(duckCounts.count, 3);
  assert.equal(duckCounts.unique_count, 3);
  const tagCounts = database.prepare(
    "SELECT COUNT(*) AS count, COUNT(DISTINCT token) AS unique_count FROM duck_tags",
  ).get();
  assert.equal(tagCounts.count, 3);
  assert.equal(tagCounts.unique_count, 3);
  assert.equal(database.prepare(
    "SELECT COUNT(DISTINCT json_extract(details_json, '$.staff_profile_id')) AS count FROM audit_events WHERE action = 'DUCK_PROVISIONING_STARTED'",
  ).get().count, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_ducks").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("duplicate preflight recognizes any known current-dataset tag without mutation", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const token = "k".repeat(43);
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff_test', 'staff-sub', 'staff@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_OPEN');
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck_existing', 42, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO duck_tags
      (id, duck_id, token, status, written_at, verified_at, activated_at)
    VALUES
      ('tag_existing', 'duck_existing', '${token}', 'ACTIVE',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
  `);
  const before = {
    ducks: database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count,
    tags: database.prepare("SELECT COUNT(*) AS count FROM duck_tags").get().count,
    commands: database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count,
    reservations: database.prepare("SELECT COUNT(*) AS count FROM event_ducks").get().count,
  };
  const duckBefore = database.prepare(
    "SELECT visible_number, inventory_status, physical_condition, revision FROM ducks WHERE id = 'duck_existing'",
  ).get();
  const classify = () => handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "event_test", tagUrl: `https://quickducks.com/t/${token}` }),
    }),
    makeEnv(sqliteD1(database)),
    actor,
  );

  const active = await classify();
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { kind: "already" });
  assert.deepEqual(database.prepare(
    "SELECT visible_number, inventory_status, physical_condition, revision FROM ducks WHERE id = 'duck_existing'",
  ).get(), duckBefore);
  database.exec("UPDATE duck_tags SET status = 'RETIRED', retired_at = '2026-07-26T01:00:00Z' WHERE id = 'tag_existing'");
  assert.deepEqual(await (await classify()).json(), { kind: "already" });
  assert.deepEqual(database.prepare(
    "SELECT visible_number, inventory_status, physical_condition, revision FROM ducks WHERE id = 'duck_existing'",
  ).get(), duckBefore);
  assert.equal(database.prepare("SELECT status FROM duck_tags WHERE id = 'tag_existing'").get().status, "RETIRED");
  assert.deepEqual({
    ducks: database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count,
    tags: database.prepare("SELECT COUNT(*) AS count FROM duck_tags").get().count,
    commands: database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count,
    reservations: database.prepare("SELECT COUNT(*) AS count FROM event_ducks").get().count,
  }, before);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  const purgedUrl = `https://quickducks.com/t/${"z".repeat(43)}`;
  const reusable = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "event_test", tagUrl: purgedUrl }),
    }),
    makeEnv(sqliteD1(database)),
    actor,
  );
  assert.deepEqual(await reusable.json(), { kind: "reusable" });
});

test("provisioning routes retain the duck-manager role gate", async () => {
  const db = makeDb();
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
      }),
    }),
    makeEnv(db),
    { ...actor, roles: ["REGISTRATION"] },
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("aged abandoned provisioning takeover transfers exact ownership safely in migrated SQLite", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES
      ('staff_owner', 'owner-sub', 'owner@example.com', 0),
      ('staff_manager', 'manager-sub', 'manager@example.com', 0),
      ('staff_director', 'director-sub', 'director@example.com', 0),
      ('staff_admin', 'admin-sub', 'admin@example.com', 1),
      ('staff_owner_three', 'owner-three-sub', 'owner-three@example.com', 0),
      ('staff_director_two', 'director-two-sub', 'director-two@example.com', 0),
      ('staff_admin_two', 'admin-two-sub', 'admin-two@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_OPEN');
  `);
  const env = makeEnv(sqliteD1(database));
  const owner = { ...actor, id: "staff_owner", cognitoSub: "owner-sub", email: "owner@example.com" };
  const manager = { ...actor, id: "staff_manager", cognitoSub: "manager-sub", email: "manager@example.com" };
  const director = {
    ...actor,
    id: "staff_director",
    cognitoSub: "director-sub",
    email: "director@example.com",
    roles: ["RACE_DIRECTOR"],
  };
  const admin = {
    ...actor,
    id: "staff_admin",
    cognitoSub: "admin-sub",
    email: "admin@example.com",
    isSystemAdmin: true,
    roles: [],
  };
  const ownerThree = {
    ...actor,
    id: "staff_owner_three",
    cognitoSub: "owner-three-sub",
    email: "owner-three@example.com",
  };
  const directorTwo = {
    ...director,
    id: "staff_director_two",
    cognitoSub: "director-two-sub",
    email: "director-two@example.com",
  };
  const adminTwo = {
    ...admin,
    id: "staff_admin_two",
    cognitoSub: "admin-two-sub",
    email: "admin-two@example.com",
  };
  const startRequest = (commandId, location = null) => new Request(
    "https://quickducks.com/api/v1/staff/inventory/provisioning",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, eventId: "event_test", location }),
    },
  );
  const takeoverRequest = (commandId, provisioning, duckId = provisioning.duckId) => new Request(
    "https://quickducks.com/api/v1/staff/inventory/provisioning/takeover",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        eventId: "event_test",
        duckId,
        provisioningCommandId: provisioning.provisioningCommandId,
      }),
    },
  );
  const confirmRequest = (commandId, provisioning) => new Request(
    "https://quickducks.com/api/v1/staff/inventory/provisioning/confirm",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId,
        eventId: "event_test",
        duckId: provisioning.duckId,
        provisioningCommandId: provisioning.provisioningCommandId,
        physicalWriteVerified: true,
      }),
    },
  );
  const recoveryRequest = () => new Request(
    "https://quickducks.com/api/v1/staff/inventory/provisioning?eventId=event_test",
  );
  const classifyRequest = (tagUrl) => new Request(
    "https://quickducks.com/api/v1/staff/inventory/provisioning/classify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "event_test", tagUrl }),
    },
  );
  const ageOwnership = (duckId) => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    database.prepare(`
      UPDATE audit_events SET occurred_at = ?
       WHERE subject_type = 'DUCK' AND subject_id = ?
         AND action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
    `).run(old, duckId);
  };

  const originalStart = await handleDuckOperations(startRequest(crypto.randomUUID(), "Abandoned table"), env, owner);
  const original = await originalStart.json();
  const originalToken = original.tagUrl.split("/").at(-1);
  assert.equal(originalStart.status, 201);
  database.exec("UPDATE staff_profiles SET is_active = 0 WHERE id = 'staff_owner'");
  assert.equal(database.prepare("SELECT is_active FROM staff_profiles WHERE id = 'staff_owner'").get().is_active, 0);

  const tooEarlyRecovery = await handleDuckOperations(recoveryRequest(), env, director);
  assert.equal((await tooEarlyRecovery.json()).provisioning, null);
  const tooEarly = await handleDuckOperations(
    takeoverRequest(crypto.randomUUID(), original), env, director,
  );
  assert.equal(tooEarly.status, 409);
  assert.match((await tooEarly.json()).error, /10 minutes/);
  const managerDenied = await handleDuckOperations(
    takeoverRequest(crypto.randomUUID(), original), env, manager,
  );
  assert.equal(managerDenied.status, 403);

  ageOwnership(original.duckId);
  const availableRecovery = await handleDuckOperations(recoveryRequest(), env, director);
  const available = (await availableRecovery.json()).provisioning;
  assert.deepEqual(available, {
    provisioningCommandId: original.provisioningCommandId,
    duckId: original.duckId,
    visibleNumber: original.visibleNumber,
    status: "PENDING_WRITE",
    takeoverAvailable: true,
  });
  assert.equal("tagUrl" in available, false);

  const directorTakeoverCommand = crypto.randomUUID();
  const directorTakeover = await handleDuckOperations(
    takeoverRequest(directorTakeoverCommand, original), env, director,
  );
  const directorRecovered = await directorTakeover.json();
  assert.equal(directorTakeover.status, 201);
  assert.equal(directorRecovered.tagUrl, original.tagUrl);
  assert.equal(directorRecovered.replayed, false);
  const directorReplay = await handleDuckOperations(
    takeoverRequest(directorTakeoverCommand, original), env, director,
  );
  assert.equal(directorReplay.status, 200);
  assert.equal((await directorReplay.json()).replayed, true);
  const reusedTakeover = await handleDuckOperations(
    takeoverRequest(directorTakeoverCommand, original, "another-duck"), env, director,
  );
  assert.equal(reusedTakeover.status, 409);

  const originalRecovery = await handleDuckOperations(recoveryRequest(), env, owner);
  assert.equal((await originalRecovery.json()).provisioning, null);
  const originalClassification = await handleDuckOperations(classifyRequest(original.tagUrl), env, owner);
  assert.equal((await originalClassification.json()).kind, "already");
  const originalConfirmation = await handleDuckOperations(
    confirmRequest(crypto.randomUUID(), original), env, owner,
  );
  assert.equal(originalConfirmation.status, 404);
  const newOwnerRecovery = await handleDuckOperations(recoveryRequest(), env, director);
  assert.equal((await newOwnerRecovery.json()).provisioning.tagUrl, original.tagUrl);
  const newOwnerClassification = await handleDuckOperations(classifyRequest(original.tagUrl), env, director);
  assert.equal((await newOwnerClassification.json()).kind, "pending");
  const newOwnerConfirmation = await handleDuckOperations(
    confirmRequest(crypto.randomUUID(), directorRecovered), env, director,
  );
  assert.equal(newOwnerConfirmation.status, 201);
  assert.equal((await newOwnerConfirmation.json()).duck.inventoryStatus, "RESERVED_FOR_EVENT");

  const adminTargetResponse = await handleDuckOperations(startRequest(crypto.randomUUID()), env, manager);
  const adminTarget = await adminTargetResponse.json();
  assert.equal(adminTargetResponse.status, 201);
  ageOwnership(adminTarget.duckId);
  const adminTakeoverCommand = crypto.randomUUID();
  const adminTakeover = await handleDuckOperations(
    takeoverRequest(adminTakeoverCommand, adminTarget), env, admin,
  );
  assert.equal(adminTakeover.status, 201);
  assert.equal((await adminTakeover.json()).tagUrl, adminTarget.tagUrl);
  const adminReplay = await handleDuckOperations(
    takeoverRequest(adminTakeoverCommand, adminTarget), env, admin,
  );
  assert.equal(adminReplay.status, 200);
  assert.equal((await adminReplay.json()).replayed, true);

  const concurrentTargetResponse = await handleDuckOperations(
    startRequest(crypto.randomUUID()), env, ownerThree,
  );
  const concurrentTarget = await concurrentTargetResponse.json();
  assert.equal(concurrentTargetResponse.status, 201);
  ageOwnership(concurrentTarget.duckId);
  const contenders = [directorTwo, adminTwo];
  const concurrentTakeovers = await Promise.all(contenders.map((contender) => handleDuckOperations(
    takeoverRequest(crypto.randomUUID(), concurrentTarget), env, contender,
  )));
  assert.deepEqual(concurrentTakeovers.map((response) => response.status).sort(), [201, 409]);
  const winnerIndex = concurrentTakeovers.findIndex((response) => response.status === 201);
  const winner = contenders[winnerIndex];
  const loser = contenders[1 - winnerIndex];
  const winnerBody = await concurrentTakeovers[winnerIndex].json();
  await concurrentTakeovers[1 - winnerIndex].json();
  assert.equal(winnerBody.tagUrl, concurrentTarget.tagUrl);
  const winnerRecovery = await handleDuckOperations(recoveryRequest(), env, winner);
  assert.equal((await winnerRecovery.json()).provisioning.tagUrl, concurrentTarget.tagUrl);
  const loserRecovery = await handleDuckOperations(recoveryRequest(), env, loser);
  assert.equal((await loserRecovery.json()).provisioning, null);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM audit_events
     WHERE action = 'DUCK_PROVISIONING_TAKEN_OVER' AND subject_id = ?
  `).get(concurrentTarget.duckId).count, 1);

  const takeoverAudits = database.prepare(`
    SELECT subject_id, details_json FROM audit_events
     WHERE action = 'DUCK_PROVISIONING_TAKEN_OVER'
     ORDER BY occurred_at, id
  `).all();
  assert.equal(takeoverAudits.length, 3);
  const firstDetails = JSON.parse(takeoverAudits.find((row) => row.subject_id === original.duckId).details_json);
  assert.equal(firstDetails.prior_staff_profile_id, owner.id);
  assert.equal(firstDetails.new_staff_profile_id, director.id);
  assert.equal(firstDetails.staff_profile_id, director.id);
  const serializedAudits = JSON.stringify(takeoverAudits);
  assert.doesNotMatch(serializedAudits, /https:|tag[_A-Z-]*token|tag[_A-Z-]*url/i);
  for (const token of [originalToken, adminTarget.tagUrl.split("/").at(-1), concurrentTarget.tagUrl.split("/").at(-1)]) {
    assert.equal(serializedAudits.includes(token), false);
  }
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM audit_events WHERE action = 'DUCK_PROVISIONING_STARTED'
  `).get().count, 3);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'TAKE_OVER_DUCK_PROVISIONING'
  `).get().count, 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("provisioning start rejects an event after the pre-race phases without writing", async () => {
  const db = makeDb(() => null);
  const response = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), eventId: "event_test" }),
    }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /closed/);
  assert.equal(db.batches.length, 0);
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

test("blank-tag provisioning, recovery, confirmation, and inventory lifecycle execute against migrated SQLite", async () => {
  const database = createDatabase();
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff_test', 'staff-sub', 'staff@example.com');
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff_other', 'other-sub', 'other@example.com');
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'DRAFT');
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck_seed', 41, 'AVAILABLE', '2026-07-26T00:00:00Z', 'GOOD');
  `);
  const env = makeEnv(sqliteD1(database));
  const otherActor = { ...actor, id: "staff_other", cognitoSub: "other-sub", email: "other@example.com" };
  const startCommandId = crypto.randomUUID();
  const startPayload = {
    commandId: startCommandId,
    eventId: "event_test",
    location: "Intake",
  };
  const startRequest = (payload = startPayload) => new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const confirmRequest = (commandId, provisioning) => new Request("https://quickducks.com/api/v1/staff/inventory/provisioning/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId,
      eventId: "event_test",
      duckId: provisioning.duckId,
      provisioningCommandId: provisioning.provisioningCommandId,
      physicalWriteVerified: true,
    }),
  });
  const classifyRequest = (tagUrl) => new Request("https://quickducks.com/api/v1/staff/inventory/provisioning/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId: "event_test", tagUrl }),
  });

  const start = await handleDuckOperations(startRequest(), env, actor);
  const provisioning = await start.json();
  const token = provisioning.tagUrl.split("/").at(-1);
  assert.equal(start.status, 201);
  assert.equal(provisioning.visibleNumber, 42);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 1);
  const pendingDuck = database.prepare(
    "SELECT inventory_status, physical_condition, storage_location FROM ducks WHERE id = ?",
  ).get(provisioning.duckId);
  assert.equal(pendingDuck.inventory_status, "NEW");
  assert.equal(pendingDuck.physical_condition, "NEEDS_TAG");
  assert.equal(pendingDuck.storage_location, "Intake");
  assert.equal(database.prepare("SELECT status FROM duck_tags WHERE duck_id = ?").get(provisioning.duckId).status, "RESERVED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_ducks WHERE duck_id = ?").get(provisioning.duckId).count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_inventory_events WHERE duck_id = ?").get(provisioning.duckId).count, 0);
  assert.equal(await getPublicStatusByTag(env, token), null);
  assert.equal(database.prepare("SELECT details_json FROM audit_events").all().some((row) => row.details_json.includes(token)), false);
  assert.equal(database.prepare("SELECT request_fingerprint FROM race_commands").all().some((row) => row.request_fingerprint.includes(token)), false);

  const replay = await handleDuckOperations(startRequest(), env, actor);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.tagUrl, provisioning.tagUrl);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count, 2);

  const recovery = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning?eventId=event_test"),
    env,
    actor,
  );
  assert.equal((await recovery.json()).provisioning.duckId, provisioning.duckId);
  const otherRecovery = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning?eventId=event_test"),
    env,
    otherActor,
  );
  assert.equal((await otherRecovery.json()).provisioning, null);
  const otherEventRecovery = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning?eventId=event_other"),
    env,
    actor,
  );
  assert.equal((await otherEventRecovery.json()).provisioning, null);

  const recoveredStart = await handleDuckOperations(startRequest({
    commandId: crypto.randomUUID(), eventId: "event_test", location: "Intake",
  }), env, actor);
  assert.equal((await recoveredStart.json()).duckId, provisioning.duckId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ducks").get().count, 2);

  const pendingClassification = await handleDuckOperations(classifyRequest(provisioning.tagUrl), env, actor);
  assert.equal((await pendingClassification.json()).kind, "pending");
  const unknownClassification = await handleDuckOperations(
    classifyRequest(`https://quickducks.com/t/${"z".repeat(43)}`), env, actor,
  );
  assert.equal((await unknownClassification.json()).kind, "reusable");

  const confirmCommandId = crypto.randomUUID();
  database.exec("UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event_test'");
  const blockedConfirm = await handleDuckOperations(confirmRequest(confirmCommandId, provisioning), env, actor);
  assert.equal(blockedConfirm.status, 409);
  assert.equal(database.prepare("SELECT status FROM duck_tags WHERE duck_id = ?").get(provisioning.duckId).status, "RESERVED");
  database.exec("UPDATE events SET status = 'REGISTRATION_CLOSED' WHERE id = 'event_test'");

  const confirmed = await handleDuckOperations(confirmRequest(confirmCommandId, provisioning), env, actor);
  const intakeBody = await confirmed.json();
  assert.equal(confirmed.status, 201);
  assert.equal(intakeBody.duck.inventoryStatus, "RESERVED_FOR_EVENT");
  assert.equal(intakeBody.duck.condition, "GOOD");
  assert.equal(intakeBody.tag.status, "ACTIVE");
  const activeTag = database.prepare(
    "SELECT status, written_at, verified_at, activated_at FROM duck_tags WHERE duck_id = ?",
  ).get(provisioning.duckId);
  assert.equal(activeTag.status, "ACTIVE");
  assert.equal([activeTag.written_at, activeTag.verified_at, activeTag.activated_at].every(Boolean), true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_ducks WHERE duck_id = ?").get(provisioning.duckId).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_inventory_events WHERE duck_id = ? AND action = 'DUCK_INTAKE'").get(provisioning.duckId).count, 1);
  assert.equal(database.prepare("SELECT details_json FROM audit_events").all().some((row) => row.details_json.includes(token)), false);

  const confirmReplay = await handleDuckOperations(confirmRequest(confirmCommandId, provisioning), env, actor);
  assert.equal(confirmReplay.status, 200);
  assert.equal((await confirmReplay.json()).replayed, true);
  const doubleConfirm = await handleDuckOperations(confirmRequest(crypto.randomUUID(), provisioning), env, actor);
  assert.equal(doubleConfirm.status, 200);
  assert.equal((await doubleConfirm.json()).replayed, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CONFIRM_DUCK_PROVISIONING'").get().count, 1);

  const activeClassification = await handleDuckOperations(classifyRequest(provisioning.tagUrl), env, actor);
  assert.equal((await activeClassification.json()).kind, "already");
  const clearedRecovery = await handleDuckOperations(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning?eventId=event_test"), env, actor,
  );
  assert.equal((await clearedRecovery.json()).provisioning, null);

  const edit = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 1,
        visibleNumber: 43,
        location: "Ready rack",
      }),
    }),
    env,
    actor,
  );
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).duck.revision, 2);

  const replace = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}/tags/replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 2,
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
        expectedRevision: 3,
        reason: "Tag removed for repair",
        physicalTagRemoved: true,
      }),
    }),
    env,
    actor,
  );
  assert.equal(retire.status, 201);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_tags WHERE duck_id = ? AND status = 'ACTIVE'").get(intakeBody.duck.id).count, 0);
  const retiredDuck = database.prepare("SELECT inventory_status, physical_condition FROM ducks WHERE id = ?").get(intakeBody.duck.id);
  assert.equal(retiredDuck.inventory_status, "QUARANTINED");
  assert.equal(retiredDuck.physical_condition, "NEEDS_TAG");

  const release = await handleDuckOperations(
    new Request(`https://quickducks.com/api/v1/staff/inventory/ducks/${intakeBody.duck.id}/reservations/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        expectedRevision: 4,
        reason: "Removed from this race",
      }),
    }),
    env,
    actor,
  );
  assert.equal(release.status, 201);
  assert.equal((await release.json()).duck.inventoryStatus, "QUARANTINED");
  assert.equal(database.prepare("SELECT released_at IS NOT NULL AS released FROM event_ducks WHERE duck_id = ?").get(intakeBody.duck.id).released, 1);

  const concurrentStart = await handleDuckOperations(startRequest({
    commandId: crypto.randomUUID(), eventId: "event_test", location: null,
  }), env, actor);
  const concurrentProvisioning = await concurrentStart.json();
  const activeWhilePending = await handleDuckOperations(classifyRequest(provisioning.tagUrl), env, actor);
  const activeWhilePendingBody = await activeWhilePending.json();
  assert.equal(activeWhilePendingBody.kind, "already");
  const concurrentResults = await Promise.all([
    handleDuckOperations(confirmRequest(crypto.randomUUID(), concurrentProvisioning), env, actor),
    handleDuckOperations(confirmRequest(crypto.randomUUID(), concurrentProvisioning), env, actor),
  ]);
  assert.deepEqual(concurrentResults.map((response) => response.status).sort(), [200, 201]);
  assert.deepEqual((await Promise.all(concurrentResults.map((response) => response.json()))).map((body) => body.replayed).sort(), [false, true]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM event_ducks WHERE duck_id = ?").get(concurrentProvisioning.duckId).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'CONFIRM_DUCK_PROVISIONING'").get().count, 2);
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
