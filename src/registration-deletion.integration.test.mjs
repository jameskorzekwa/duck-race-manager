import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";
import { createWorker } from "./index.ts";
import { randomToken } from "./registration.ts";

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.args) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

const createD1 = (database) => ({
  statements: [],
  prepare(sql) {
    const statement = new D1Statement(database, sql);
    this.statements.push(statement);
    return statement;
  },
  async batch(statements) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = database.prepare(statement.sql).run(...statement.args);
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

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const seedEvent = (database, status = "REGISTRATION_OPEN") => {
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin)
    VALUES ('staff-registration', 'reg-sub', 'reg@example.com', 'Registration Staff', 0);
    INSERT INTO events (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event-delete', 'delete-race', 'Delete Race', '2026-09-12', 'America/Denver',
            '${status}', 'FIRST_NAME_LAST_INITIAL');
  `);
};

const staffActor = (roles, isSystemAdmin = false) => ({
  id: "staff-registration",
  cognitoSub: "reg-sub",
  email: "reg@example.com",
  displayName: "Registration Staff",
  isSystemAdmin,
  roles,
  authentication: "bearer",
});

const jsonBody = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

const cookieFrom = (response) => {
  const token = response.headers.get("set-cookie")?.match(/__Host-quickducks_browser=([^;]+)/)?.[1];
  assert.ok(token, "expected a browser collection cookie");
  return `__Host-quickducks_browser=${token}`;
};

const harness = (context, { rateLimited = false } = {}) => {
  const database = createDatabase();
  context.after(() => database.close());
  const published = [];
  const DB = createD1(database);
  const env = {
    APP_ORIGIN: "https://quickducks.com",
    AWS_REGION: "us-east-1",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_USER_POOL_CLIENT_ID: "client-example",
    COGNITO_DOMAIN: "https://quickducks-staff.example.com",
    DB,
    EMAIL_QUEUE: { async send() {} },
    PUBLIC_SEARCH_RATE_LIMITER: {
      async limit(options) {
        return { success: !rateLimited, key: options.key };
      },
    },
    RACE_UPDATES: {
      idFromName() { return "race-updates"; },
      get() {
        return {
          async fetch(_url, init) {
            published.push(JSON.parse(init.body));
            return new Response(null, { status: 204 });
          },
        };
      },
    },
    TURNSTILE_SECRET_KEY: "turnstile-test-secret",
  };
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const worker = createWorker(async () => null);
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    let body;
    if (options.body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, ctx);
  };
  const staff = (path, actor, options = {}) => {
    const headers = new Headers({
      authorization: "Bearer staff.test.token",
      ...(options.headers ?? {}),
    });
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return handleApi(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, async () => actor, ctx);
  };
  const settle = async () => {
    await Promise.allSettled(waits.splice(0, waits.length));
    return published;
  };
  return { api, database, env, DB, published, settle, staff };
};

const register = async (api, context, firstName, lastName, options = {}) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const response = await api("/api/v1/registrations", {
    method: "POST",
    cookie: options.cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId: "event-delete",
      commandId: crypto.randomUUID(),
      privateToken: randomToken(),
      firstName,
      lastName,
      turnstileToken: "turnstile-test",
    },
  });
  const body = await jsonBody(response, 201, `register ${firstName}`);
  context.mock.restoreAll();
  return { ...body, cookie: cookieFrom(response) };
};

const deleteRequest = (api, registrationId, options = {}) => api("/api/v1/registrations/mine/delete", {
  method: "POST",
  cookie: options.cookie,
  headers: { origin: "https://quickducks.com", ...(options.headers ?? {}) },
  body: options.body ?? { commandId: options.commandId ?? crypto.randomUUID(), registrationId },
});

const pairDuck = (database, raceEntryId, { ended = false } = {}) => {
  database.exec(`
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES ('duck-${raceEntryId}', ${Math.floor(Math.random() * 100000) + 1}, 'IN_USE', '2026-09-01T00:00:00Z');
    INSERT INTO event_ducks (id, event_id, duck_id, reserved_at)
    VALUES ('event-duck-${raceEntryId}', 'event-delete', 'duck-${raceEntryId}', '2026-09-01T00:00:00Z');
    INSERT INTO race_commands (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES ('assign-${raceEntryId}', 'event-delete', 'ASSIGN_DUCK', 'assignment-${raceEntryId}',
            '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from, valid_to, end_reason, source_command_id)
    VALUES ('assignment-${raceEntryId}', 'event-delete', '${raceEntryId}', 'event-duck-${raceEntryId}',
            'duck-${raceEntryId}', '2026-09-01T00:00:00Z',
            ${ended ? "'2026-09-01T01:00:00Z', 'STAFF_UNASSIGNED'" : "NULL, NULL"},
            'assign-${raceEntryId}');
  `);
};

// The roster-lock trigger refuses inserts into a locked heat, so the entry is
// seeded while the heat is still open and the lock is applied afterwards, the
// same order staff lifecycle uses.
const addToHeat = (database, raceEntryId, { locked = false } = {}) => {
  database.exec(`
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('heat-${raceEntryId}', 'event-delete', 'ROUND_ONE', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES ('heat-entry-${raceEntryId}', 'event-delete', 'heat-${raceEntryId}', '${raceEntryId}',
            'ROUND_ONE', 1, 'BALANCED_DRAW', '2026-09-01T00:00:00Z');
  `);
  if (locked) {
    database.prepare("UPDATE heats SET roster_locked_at = ? WHERE id = ?")
      .run("2026-09-01T00:00:00Z", `heat-${raceEntryId}`);
  }
};

const counts = (database, registrationId) => ({
  registrations: database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE id = ?").get(registrationId).count,
  raceEntries: database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE registration_id = ?").get(registrationId).count,
  links: database.prepare("SELECT COUNT(*) AS count FROM browser_collection_registrations WHERE registration_id = ?").get(registrationId).count,
});

const raceEntryId = (database, registrationId) =>
  database.prepare("SELECT id FROM race_entries WHERE registration_id = ?").get(registrationId).id;

// ---------------------------------------------------------------------------
// Path A: participant self-service deletion
// ---------------------------------------------------------------------------

test("the registering browser deletes its own unpaired registration completely", async (context) => {
  const { api, database, settle } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const keeper = await register(api, context, "Donald", "Mallard", { cookie: owner.cookie });
  const entryId = raceEntryId(database, owner.registrationId);

  // The collection projection marks exactly the removable entry.
  const before = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "collection before deletion",
  );
  assert.deepEqual(before.registrations.map((item) => item.deletable), [true, true]);
  assert.deepEqual(before.registrations.map((item) => item.paired), [false, false]);

  const response = await deleteRequest(api, owner.registrationId, { cookie: owner.cookie });
  const deleted = await jsonBody(response, 200, "delete own registration");
  assert.deepEqual(deleted, { deleted: true, replayed: false });
  // The response body carries no participant identity at all.
  assert.equal(/Daisy|Duck|lookup|token|email/i.test(JSON.stringify(deleted)), false);
  // Nothing about the collection cookie changes on a delete.
  assert.equal(response.headers.get("set-cookie"), null);

  // The registration, its race entry, and every collection link are gone.
  assert.deepEqual(counts(database, owner.registrationId), {
    registrations: 0,
    raceEntries: 0,
    links: 0,
  });
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE id = ?").get(entryId).count,
    0,
  );
  // The other registration in the same collection is untouched.
  assert.deepEqual(counts(database, keeper.registrationId), {
    registrations: 1,
    raceEntries: 1,
    links: 1,
  });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  // The command and audit rows survive their subject and carry no PII.
  const command = database.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'",
  ).get();
  assert.equal(command.result_id, owner.registrationId);
  assert.equal(command.event_id, "event-delete");
  const audit = database.prepare(
    "SELECT action, subject_type, subject_id, actor_type, details_json FROM audit_events WHERE action = 'REGISTRATION_DELETED'",
  ).get();
  assert.deepEqual(
    { ...audit, details_json: JSON.parse(audit.details_json) },
    {
      action: "REGISTRATION_DELETED",
      subject_type: "REGISTRATION",
      subject_id: owner.registrationId,
      actor_type: "PUBLIC",
      details_json: { deleted_via: "PUBLIC_COLLECTION" },
    },
  );
  assert.equal(/Daisy|Duck|@|lookup/i.test(audit.details_json), false);

  // The collection now returns only the surviving registration.
  const after = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "collection after deletion",
  );
  assert.deepEqual(after.registrations.map((item) => item.registrationId), [keeper.registrationId]);

  // Deletion publishes the participants refresh domain.
  const published = await settle();
  assert.deepEqual(published.at(-1).domains, ["participants"]);
  assert.equal(published.at(-1).type, "refresh");
});

test("deleting the same registration twice is a deterministic replayed success", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const commandId = crypto.randomUUID();

  assert.deepEqual(
    await jsonBody(await deleteRequest(api, owner.registrationId, { cookie: owner.cookie, commandId }), 200, "first delete"),
    { deleted: true, replayed: false },
  );
  // The retry has no registration and no collection link left to read, so it is
  // answered from command history alone rather than failing.
  assert.deepEqual(
    await jsonBody(await deleteRequest(api, owner.registrationId, { cookie: owner.cookie, commandId }), 200, "replayed delete"),
    { deleted: true, replayed: true },
  );
  // A replay from a browser that no longer holds the cookie is equally stable.
  assert.deepEqual(
    await jsonBody(await deleteRequest(api, owner.registrationId, { commandId }), 200, "cookieless replay"),
    { deleted: true, replayed: true },
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'").get().count,
    1,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'REGISTRATION_DELETED'").get().count,
    1,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a reused command identifier for different material conflicts instead of deleting", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const other = await register(api, context, "Donald", "Mallard", { cookie: owner.cookie });
  const commandId = crypto.randomUUID();

  await jsonBody(await deleteRequest(api, owner.registrationId, { cookie: owner.cookie, commandId }), 200, "first delete");
  const conflict = await deleteRequest(api, other.registrationId, { cookie: owner.cookie, commandId });
  assert.equal(conflict.status, 409);
  assert.equal(counts(database, other.registrationId).registrations, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a followed entry is never deletable and never offers a delete", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");

  const search = await jsonBody(
    await api("/api/v1/race-status/search?eventId=event-delete&name=Daisy"),
    200,
    "public search",
  );
  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: search.results[0].followId },
  });
  await jsonBody(followResponse, 200, "follow");
  const followerCookie = cookieFrom(followResponse);

  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: followerCookie }),
    200,
    "follower collection",
  );
  assert.equal(mine.registrations[0].followed, true);
  assert.equal(mine.registrations[0].deletable, false, "a followed entry is someone else's registration");

  const refused = await deleteRequest(api, owner.registrationId, { cookie: followerCookie });
  assert.equal(refused.status, 404);
  assert.match((await refused.json()).error, /cannot be deleted/);
  // Nothing was removed, not even the follower's own link.
  assert.deepEqual(counts(database, owner.registrationId), {
    registrations: 1,
    raceEntries: 1,
    links: 2,
  });
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a paired registration cannot be deleted by the browser that created it", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, raceEntryId(database, owner.registrationId));

  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "paired collection",
  );
  assert.equal(mine.registrations[0].paired, true);
  assert.equal(mine.registrations[0].deletable, false);

  const refused = await deleteRequest(api, owner.registrationId, { cookie: owner.cookie });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /already has a race duck/);
  assert.deepEqual(counts(database, owner.registrationId), {
    registrations: 1,
    raceEntries: 1,
    links: 1,
  });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an ended assignment and a heat place both keep a registration undeletable", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const unassigned = await register(api, context, "Daisy", "Duck");
  const rostered = await register(api, context, "Donald", "Mallard", { cookie: unassigned.cookie });
  // An ended assignment still restricts the parent delete and still means this
  // entry was paired at some point.
  pairDuck(database, raceEntryId(database, unassigned.registrationId), { ended: true });
  addToHeat(database, raceEntryId(database, rostered.registrationId), { locked: true });

  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: unassigned.cookie }),
    200,
    "collection",
  );
  assert.deepEqual(mine.registrations.map((item) => item.deletable), [false, false]);
  // Both still appear as awaiting, so the section alone never authorizes a delete.
  assert.deepEqual(mine.registrations.map((item) => item.paired), [false, false]);

  for (const registrationId of [unassigned.registrationId, rostered.registrationId]) {
    const refused = await deleteRequest(api, registrationId, { cookie: unassigned.cookie });
    assert.equal(refused.status, 409, registrationId);
    assert.equal(counts(database, registrationId).registrations, 1);
  }
  // The locked roster is untouched, so its guard trigger never fired.
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_entries").get().count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("another browser's cookie cannot delete a registration it does not own", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const stranger = await register(api, context, "Donald", "Mallard");
  assert.notEqual(owner.cookie, stranger.cookie);

  const refused = await deleteRequest(api, owner.registrationId, { cookie: stranger.cookie });
  assert.equal(refused.status, 404);
  // The same 404 covers an unknown identifier, so nothing reveals whether an
  // unrelated registration exists.
  const unknown = await deleteRequest(api, crypto.randomUUID(), { cookie: stranger.cookie });
  assert.equal(unknown.status, 404);
  assert.equal((await refused.json()).error, (await unknown.json()).error);
  // No cookie at all is the same answer.
  assert.equal((await deleteRequest(api, owner.registrationId)).status, 404);

  assert.equal(counts(database, owner.registrationId).registrations, 1);
  assert.equal(counts(database, stranger.registrationId).registrations, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("public deletion validates transport and shape before any database access", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const registrationId = owner.registrationId;

  const rejected = [
    ["wrong content type", 415, {
      headers: { "content-type": "text/plain" },
    }],
    ["missing origin", 403, { headers: { origin: null } }],
    ["cross origin", 403, { headers: { origin: "https://evil.example" } }],
    ["array body", 400, { body: [registrationId] }],
    ["non-uuid registration", 400, { body: { commandId: crypto.randomUUID(), registrationId: "registration-one" } }],
    ["non-v4 command", 400, { body: { commandId: "11111111-1111-1111-8111-111111111111", registrationId } }],
    ["missing command", 400, { body: { registrationId } }],
  ];
  for (const [label, status, options] of rejected) {
    const headers = new Headers({ origin: "https://quickducks.com" });
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    const response = await api("/api/v1/registrations/mine/delete", {
      method: "POST",
      cookie: owner.cookie,
      headers: Object.fromEntries(headers),
      body: options.body ?? { commandId: crypto.randomUUID(), registrationId },
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.equal(counts(database, registrationId).registrations, 1, `${label} must not write`);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an oversized public delete body is refused before parsing", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");

  const response = await api("/api/v1/registrations/mine/delete", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId, padding: "x".repeat(2000) },
  });
  assert.equal(response.status, 413);
  assert.equal(counts(database, owner.registrationId).registrations, 1);
});

test("a rate-limited public delete writes nothing", async (context) => {
  const limited = harness(context, { rateLimited: true });
  seedEvent(limited.database);
  limited.database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'event-delete', 'Daisy', 'Duck',
            'SUBMITTED', 'DAISY123', 'hash-one', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-one', 'event-delete', '11111111-1111-4111-8111-111111111111');
  `);

  const response = await deleteRequest(limited.api, "11111111-1111-4111-8111-111111111111");
  assert.equal(response.status, 429);
  assert.equal(
    limited.database.prepare("SELECT COUNT(*) AS count FROM registrations").get().count,
    1,
  );
  assert.equal(
    limited.database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count,
    0,
  );
});

test("the guarded public delete binds every external value and re-checks ownership in SQL", async (context) => {
  const { api, database, DB } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  DB.statements.length = 0;
  await deleteRequest(api, owner.registrationId, { cookie: owner.cookie });

  const guarded = DB.statements.find((statement) => statement.sql.includes("'DELETE_REGISTRATION'")
    && statement.sql.startsWith("INSERT INTO race_commands"));
  assert.ok(guarded, "the guarded command insert must exist");
  // Ownership, link kind, event status, and unpaired state are all re-checked
  // inside the authoritative write, not only in the preflight read.
  assert.match(guarded.sql, /bcr\.added_via = 'REGISTRATION'/);
  assert.match(guarded.sql, /bcr\.collection_id = \?/);
  assert.match(guarded.sql, /NOT EXISTS \(\s*SELECT 1 FROM duck_assignments/);
  assert.match(guarded.sql, /NOT EXISTS \(\s*SELECT 1 FROM heat_entries/);
  assert.equal(guarded.sql.includes(owner.registrationId), false, "identifiers must be bound");
  assert.equal(guarded.args.includes(owner.registrationId), true);

  // Every child delete is gated on that same command row existing.
  const deletes = DB.statements.filter((statement) => statement.sql.startsWith("DELETE FROM "));
  assert.deepEqual(
    deletes.map((statement) => statement.sql.match(/^DELETE FROM (\w+)/)[1]),
    ["email_attempts", "email_notifications", "browser_collection_registrations", "race_entries", "registrations"],
  );
  for (const statement of deletes) {
    assert.match(statement.sql, /rc\.command_type = 'DELETE_REGISTRATION'/);
    assert.equal(statement.sql.includes(owner.registrationId), false);
  }
});

// ---------------------------------------------------------------------------
// Path B: staff deletion
// ---------------------------------------------------------------------------

test("staff delete removes an unpaired registration and audits without PII", async (context) => {
  const { api, database, staff, settle } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const entryId = raceEntryId(database, owner.registrationId);
  database.exec(`
    INSERT INTO email_notifications (id, event_id, registration_id, notification_type)
    VALUES ('notification-one', 'event-delete', '${owner.registrationId}', 'REGISTRATION_RECEIVED');
    INSERT INTO email_attempts
      (id, event_id, notification_id, attempt_number, stage, status, started_at)
    VALUES ('attempt-one', 'event-delete', 'notification-one', 1, 'QUEUE', 'PENDING', '2026-09-01T00:00:00Z');
  `);

  const response = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    staffActor(["REGISTRATION"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  assert.deepEqual(await jsonBody(response, 200, "staff delete"), {
    deleted: true,
    registrationId: owner.registrationId,
    replayed: false,
  });

  assert.deepEqual(counts(database, owner.registrationId), {
    registrations: 0,
    raceEntries: 0,
    links: 0,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE id = ?").get(entryId).count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM email_notifications").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM email_attempts").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  const audit = database.prepare(
    "SELECT actor_type, subject_id, details_json FROM audit_events WHERE action = 'REGISTRATION_DELETED'",
  ).get();
  assert.equal(audit.actor_type, "STAFF");
  assert.equal(audit.subject_id, owner.registrationId);
  assert.deepEqual(JSON.parse(audit.details_json), {
    staff_profile_id: "staff-registration",
    created_via: "PUBLIC",
    previous_revision: 0,
  });
  assert.equal(/Daisy|Duck|@example|lookup/i.test(audit.details_json), false);

  const published = await settle();
  assert.deepEqual(published.at(-1).domains, ["participants", "ducks", "heats"]);
});

test("staff delete refuses while a duck is assigned and succeeds once unassigned", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const entryId = raceEntryId(database, owner.registrationId);
  pairDuck(database, entryId);

  const refused = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    staffActor(["REGISTRATION"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  const refusedBody = await jsonBody(refused, 409, "assigned refusal");
  assert.match(refusedBody.error, /Unassign the duck from inventory first/);
  assert.equal(counts(database, owner.registrationId).registrations, 1);
  // The assignment itself is intact: the delete never tears race data down.
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL").get().count,
    1,
  );

  // Ending the assignment is still not enough, because an ended row keeps the
  // race-entry parent restricted and still means the entry was paired.
  database.prepare(
    "UPDATE duck_assignments SET valid_to = ?, end_reason = 'STAFF_UNASSIGNED' WHERE race_entry_id = ?",
  ).run("2026-09-01T02:00:00Z", entryId);
  const stillRefused = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    staffActor(["REGISTRATION"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  assert.equal(stillRefused.status, 409);
  assert.equal(counts(database, owner.registrationId).registrations, 1);

  // A registration that never had a duck deletes normally.
  const clean = await register(api, context, "Donald", "Mallard");
  const allowed = await staff(
    `/api/v1/staff/registrations/${clean.registrationId}`,
    staffActor(["REGISTRATION"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staff delete refuses a participant on a heat roster without touching it", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  addToHeat(database, raceEntryId(database, owner.registrationId), { locked: true });

  const refused = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    staffActor(["RACE_DIRECTOR"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  const body = await jsonBody(refused, 409, "heat refusal");
  assert.match(body.error, /on a heat roster/);
  assert.match(body.error, /Unassign their duck/);
  // The locked roster is intact, so the roster-lock trigger was never provoked.
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_entries").get().count, 1);
  assert.equal(counts(database, owner.registrationId).registrations, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'DELETE_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staff delete enforces revision, replay, and lifecycle rules", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const actor = staffActor(["REGISTRATION"]);
  const call = (body) => staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    actor,
    { method: "DELETE", body },
  );

  assert.equal((await call({ commandId: "not-a-uuid", expectedRevision: 0 })).status, 400);
  assert.equal((await call({ commandId: crypto.randomUUID() })).status, 400);
  assert.equal((await call({ commandId: crypto.randomUUID(), expectedRevision: 7 })).status, 409);
  assert.equal((await staff(
    `/api/v1/staff/registrations/${crypto.randomUUID()}`,
    actor,
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  )).status, 404);
  assert.equal(counts(database, owner.registrationId).registrations, 1);

  const commandId = crypto.randomUUID();
  assert.deepEqual(await jsonBody(await call({ commandId, expectedRevision: 0 }), 200, "staff delete"), {
    deleted: true,
    registrationId: owner.registrationId,
    replayed: false,
  });
  assert.deepEqual(await jsonBody(await call({ commandId, expectedRevision: 0 }), 200, "staff replay"), {
    deleted: true,
    registrationId: owner.registrationId,
    replayed: true,
  });
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'REGISTRATION_DELETED'").get().count,
    1,
  );

  // A command identifier already spent on another operation conflicts.
  const other = await register(api, context, "Donald", "Mallard");
  const reused = await staff(
    `/api/v1/staff/registrations/${other.registrationId}`,
    actor,
    { method: "DELETE", body: { commandId, expectedRevision: 0 } },
  );
  assert.equal(reused.status, 409);
  assert.equal(counts(database, other.registrationId).registrations, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("staff delete is refused in a draft event state", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  database.prepare("UPDATE events SET status = 'DRAFT' WHERE id = 'event-delete'").run();

  const refused = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    staffActor(["REGISTRATION"]),
    { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
  );
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /cannot be deleted in this event state/);
  assert.equal(counts(database, owner.registrationId).registrations, 1);
});

test("staff delete is gated to the registration and race-director roles", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const registrations = [];
  for (const name of ["One", "Two", "Three", "Four"]) {
    registrations.push(await register(api, context, name, "Duck"));
  }

  // Anonymous callers never reach the handler at all.
  const anonymous = await handleApi(
    new Request(`https://quickducks.com/api/v1/staff/registrations/${registrations[0].registrationId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision: 0 }),
    }),
    { ...harness(context).env, DB: undefined },
    async () => null,
  );
  assert.equal(anonymous.status, 401);

  const denied = [
    ["no roles", []],
    ["duck manager", ["DUCK_MANAGER"]],
    ["announcer", ["ANNOUNCER"]],
    ["heat runner", ["HEAT_RUNNER"]],
    ["result taker", ["RESULT_TAKER"]],
  ];
  for (const [label, roles] of denied) {
    const response = await staff(
      `/api/v1/staff/registrations/${registrations[0].registrationId}`,
      staffActor(roles),
      { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
    );
    assert.equal(response.status, 403, label);
    assert.equal(counts(database, registrations[0].registrationId).registrations, 1, label);
  }

  const allowed = [
    ["registration", staffActor(["REGISTRATION"]), registrations[0]],
    ["race director", staffActor(["RACE_DIRECTOR"]), registrations[1]],
    ["administrator", staffActor([], true), registrations[2]],
  ];
  for (const [label, actor, registration] of allowed) {
    const response = await staff(
      `/api/v1/staff/registrations/${registration.registrationId}`,
      actor,
      { method: "DELETE", body: { commandId: crypto.randomUUID(), expectedRevision: 0 } },
    );
    assert.equal(response.status, 200, label);
    assert.equal(counts(database, registration.registrationId).registrations, 0, label);
  }
  assert.equal(counts(database, registrations[3].registrationId).registrations, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a cookie-authenticated staff delete still requires the exact application origin", async (context) => {
  const { api, database, staff } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const cookieActor = { ...staffActor(["REGISTRATION"]), authentication: "cookie" };

  for (const [label, origin] of [["missing origin", null], ["cross origin", "https://evil.example"]]) {
    const response = await staff(
      `/api/v1/staff/registrations/${owner.registrationId}`,
      cookieActor,
      {
        method: "DELETE",
        headers: origin === null ? {} : { origin },
        body: { commandId: crypto.randomUUID(), expectedRevision: 0 },
      },
    );
    assert.equal(response.status, 403, label);
    assert.equal(counts(database, owner.registrationId).registrations, 1, label);
  }

  const allowed = await staff(
    `/api/v1/staff/registrations/${owner.registrationId}`,
    cookieActor,
    {
      method: "DELETE",
      headers: { origin: "https://quickducks.com" },
      body: { commandId: crypto.randomUUID(), expectedRevision: 0 },
    },
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
