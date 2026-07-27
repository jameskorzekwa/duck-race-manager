import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createWorker } from "./index.ts";
import { randomToken } from "./registration.ts";

// Real migrated SQLite behind the real Worker handlers. Every data path in this
// file — following from a scanned tag, following from a duck number, removing a
// followed link, and naming an owned duck — is exercised end to end so the
// guarded writes, the projections, and the rendered pages are all checked
// against the same schema production runs.

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
  prepare(sql) {
    return new D1Statement(database, sql);
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
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((item) => /^\d{4}_.+\.sql$/.test(item)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const seedEvent = (database, status = "REGISTRATION_OPEN") => {
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event-ducks', 'duck-race', 'Duck Race', '2026-08-30', 'America/Denver',
            '${status}', 'FIRST_NAME_LAST_INITIAL');
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1);
  `);
};

const staffActor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Race Staff",
  isSystemAdmin: false,
  roles: ["REGISTRATION", "DUCK_MANAGER"],
  authentication: "bearer",
};

const makeEnv = (database, rateLimited = false) => ({
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
  DB: createD1(database),
  EMAIL_QUEUE: { async send() {} },
  PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: !rateLimited }; } },
  TURNSTILE_SECRET_KEY: "turnstile-test-secret",
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
  const env = makeEnv(database, rateLimited);
  const call = (worker) => (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    let body;
    if (options.body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, { waitUntil() {} });
  };
  return {
    api: call(createWorker(async () => null)),
    staffApi: call(createWorker(async () => staffActor)),
    database,
  };
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
      eventId: "event-ducks",
      commandId: options.commandId ?? crypto.randomUUID(),
      privateToken: options.privateToken ?? randomToken(),
      firstName,
      lastName,
      turnstileToken: "turnstile-test",
    },
  });
  const body = await jsonBody(response, 201, `register ${firstName}`);
  context.mock.restoreAll();
  return { ...body, cookie: cookieFrom(response) };
};

// Staff pairing, written directly so these tests stay about the participant
// surfaces. The rows are the same ones the pairing endpoint writes.
const pairDuck = (database, registrationId, visibleNumber, tagToken) => {
  const raceEntryId = database
    .prepare("SELECT id FROM race_entries WHERE registration_id = ?")
    .get(registrationId).id;
  const suffix = String(visibleNumber);
  database.prepare(
    `INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
     VALUES (?, ?, 'IN_USE', '2026-08-01T00:00:00Z')`,
  ).run(`duck-${suffix}`, visibleNumber);
  database.prepare(
    `INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
     VALUES (?, 'event-ducks', ?, '2026-08-01T00:00:00Z', 'staff')`,
  ).run(`event-duck-${suffix}`, `duck-${suffix}`);
  database.prepare(
    `INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
     VALUES (?, 'event-ducks', 'ASSIGN_DUCK', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).run(`pair-command-${suffix}`);
  database.prepare(
    `INSERT INTO duck_assignments
       (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
        assigned_by_staff_profile_id, source_command_id)
     VALUES (?, 'event-ducks', ?, ?, ?, '2026-08-01T00:00:00Z', 'staff', ?)`,
  ).run(`assignment-${suffix}`, raceEntryId, `event-duck-${suffix}`, `duck-${suffix}`, `pair-command-${suffix}`);
  database.prepare(
    `INSERT INTO duck_tags (id, duck_id, token, status, activated_at)
     VALUES (?, ?, ?, 'ACTIVE', '2026-08-01T00:00:00Z')`,
  ).run(`tag-${suffix}`, `duck-${suffix}`, tagToken);
  database.prepare("UPDATE registrations SET status = 'ACTIVE' WHERE id = ?").run(registrationId);
  return raceEntryId;
};

const tagToken = "t".repeat(32);
const linkRows = (database) => database
  .prepare("SELECT collection_id, registration_id, added_via FROM browser_collection_registrations ORDER BY added_at, registration_id")
  .all()
  .map((row) => ({ ...row }));
const duckNameOf = (database, registrationId) => database
  .prepare("SELECT duck_name FROM race_entries WHERE registration_id = ?")
  .get(registrationId).duck_name;
const clean = (database) =>
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

// ---------------------------------------------------------------------------
// Following from a scanned tag
// ---------------------------------------------------------------------------

test("scanning a duck tag offers a follow to a browser that does not have that duck", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);

  // A visitor with no collection sees the offer, on the page and in the API.
  const page = await (await api(`/t/${tagToken}`)).text();
  assert.match(page, new RegExp(`data-duck-follow data-follow-id="${raceEntryId}"`));
  assert.match(page, /data-follow-button>Follow this duck<\/button>/);
  assert.doesNotMatch(page, /In My Ducks/);
  assert.equal(page.includes(owner.lookupCode), false);

  const scan = await jsonBody(await api(`/api/v1/ducks/${tagToken}`), 200, "tag scan");
  assert.equal(scan.destination, "RACE_STATUS");
  assert.equal(scan.raceStatus.followId, raceEntryId);
  assert.equal(scan.raceStatus.inMyDucks, false);
  assert.equal(scan.raceStatus.duck.visibleNumber, 12);
  assert.equal(/lookupCode|email|phone|privateStatusPath|duckName/i.test(JSON.stringify(scan)), false);

  // Following uses the existing endpoint and the existing collection semantics.
  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: scan.raceStatus.followId },
  });
  assert.deepEqual(await jsonBody(followResponse, 200, "follow"), {
    followed: true,
    alreadyInCollection: false,
  });
  const follower = cookieFrom(followResponse);
  assert.deepEqual(
    linkRows(database).map((row) => row.added_via),
    ["REGISTRATION", "FOLLOWED"],
  );

  // The same page now renders the already-added state with no second action.
  const added = await (await api(`/t/${tagToken}`, { cookie: follower })).text();
  assert.match(added, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(added, /data-follow-button/);
  const rescan = await jsonBody(
    await api(`/api/v1/ducks/${tagToken}`, { cookie: follower }),
    200,
    "tag rescan",
  );
  assert.equal(rescan.raceStatus.inMyDucks, true);

  // Following again is the same idempotent no-op the search path already has.
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/follow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { followId: raceEntryId },
      }),
      200,
      "repeat follow",
    ),
    { followed: true, alreadyInCollection: true },
  );
  assert.equal(linkRows(database).length, 2);

  // The registering browser already holds this duck, so it is offered nothing.
  const ownerPage = await (await api(`/t/${tagToken}`, { cookie: owner.cookie })).text();
  assert.match(ownerPage, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(ownerPage, /data-follow-button/);
  clean(database);
});

test("the public duck page offers the identical follow control and identifier", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);

  const page = await (await api("/duck/12")).text();
  assert.match(page, new RegExp(`data-duck-follow data-follow-id="${raceEntryId}"`));
  assert.match(page, /data-follow-button>Follow this duck<\/button>/);
  assert.equal(page.includes(tagToken), false, "the duck page never exposes the tag");

  const detail = await jsonBody(await api("/api/v1/ducks/number/12"), 200, "duck number");
  assert.equal(detail.raceStatus.followId, raceEntryId);
  assert.equal(detail.raceStatus.inMyDucks, false);

  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: detail.raceStatus.followId },
  });
  await jsonBody(followResponse, 200, "follow from duck page");
  const follower = cookieFrom(followResponse);

  const added = await (await api("/duck/12", { cookie: follower })).text();
  assert.match(added, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(added, /data-follow-button/);
  assert.equal(
    (await jsonBody(await api("/api/v1/ducks/number/12", { cookie: follower }), 200, "recheck"))
      .raceStatus.inMyDucks,
    true,
  );

  // The follower's collection carries the public projection and nothing more.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: follower }),
    200,
    "follower collection",
  );
  assert.equal(mine.registrations.length, 1);
  assert.equal(mine.registrations[0].followed, true);
  assert.equal(mine.registrations[0].lookupCode, null);
  assert.equal(mine.registrations[0].duckName, null);
  assert.equal(mine.registrations[0].nameable, false);
  clean(database);
});

test("a participant who left the public search can no longer be followed from a tag", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);
  database.prepare("UPDATE registrations SET status = 'WITHDRAWN' WHERE id = ?").run(owner.registrationId);

  // The public status still resolves, but the follow control is gone from both
  // the page and the API, exactly as the follow endpoint would refuse it.
  const page = await (await api(`/t/${tagToken}`)).text();
  assert.match(page, /Duck #12/);
  assert.doesNotMatch(page, /data-duck-follow data-follow-id/);
  assert.doesNotMatch(page, /data-follow-button|data-follow-added/);
  const scan = await jsonBody(await api(`/api/v1/ducks/${tagToken}`), 200, "withdrawn scan");
  assert.equal(scan.destination, "RACE_STATUS");
  assert.equal(Object.hasOwn(scan.raceStatus, "followId"), false);
  assert.equal(Object.hasOwn(scan.raceStatus, "inMyDucks"), false);
  clean(database);
});

// ---------------------------------------------------------------------------
// Unfollowing
// ---------------------------------------------------------------------------

const followFrom = async (api, raceEntryId, cookie) => {
  const response = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    cookie,
    headers: { origin: "https://quickducks.com" },
    body: { followId: raceEntryId },
  });
  await jsonBody(response, 200, "follow");
  return cookieFrom(response);
};

test("unfollowing removes only the followed link and never the registration", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const commandId = crypto.randomUUID();

  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/unfollow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { commandId, registrationId: owner.registrationId },
      }),
      200,
      "unfollow",
    ),
    { unfollowed: true, replayed: false },
  );

  // The link is gone; the registration, its race entry, and the owner's own
  // link are untouched.
  assert.deepEqual(linkRows(database).map((row) => row.added_via), ["REGISTRATION"]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE id = ?").get(owner.registrationId).count,
    1,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE id = ?").get(raceEntryId).count,
    1,
  );
  const ownerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "owner collection",
  );
  assert.equal(ownerMine.registrations.length, 1);
  assert.equal(ownerMine.registrations[0].lookupCode, owner.lookupCode);
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine", { cookie: follower }),
      200,
      "follower collection",
    ),
    { registrations: [] },
  );

  // Retrying the identical command is a deterministic success, and the same
  // identifier reused for different material conflicts.
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/unfollow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { commandId, registrationId: owner.registrationId },
      }),
      200,
      "replayed unfollow",
    ),
    { unfollowed: true, replayed: true },
  );
  assert.equal(
    (await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      cookie: follower,
      headers: { origin: "https://quickducks.com" },
      body: { commandId, registrationId: crypto.randomUUID() },
    })).status,
    409,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'",
    ).get().count,
    1,
  );
  clean(database);
});

test("unfollow refuses an owned registration, a foreign cookie, and a bad transport", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const stranger = await register(api, context, "Donald", "Mallard");
  const before = linkRows(database);
  assert.equal(before.length, 3);

  const refused = [
    // A registration this browser created is never removable through unfollow;
    // it has its own delete flow.
    ["owned registration", 404, {
      cookie: owner.cookie,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    // Another browser's followed link is invisible here.
    ["foreign cookie", 404, {
      cookie: stranger.cookie,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    ["no cookie at all", 404, {
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    // An unrelated registration is the same 404, so nothing is disclosed.
    ["unknown registration", 404, {
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: crypto.randomUUID() },
    }],
    ["non-uuid registration", 400, {
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: "registration-one" },
    }],
    ["non-v4 command", 400, {
      cookie: follower,
      body: { commandId: "not-a-command", registrationId: owner.registrationId },
    }],
    ["array body", 400, { cookie: follower, body: [owner.registrationId] }],
    ["invalid json", 400, { cookie: follower, body: "{" }],
  ];
  for (const [label, status, options] of refused) {
    const response = await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
      ...options,
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.deepEqual(linkRows(database), before, `${label} must not write`);
  }

  // Transport failures are refused before anything else, including the
  // command history.
  const transport = [
    ["missing origin", 403, {}],
    ["cross origin", 403, { headers: { origin: "https://evil.example" } }],
    ["wrong content type", 415, {
      headers: { origin: "https://quickducks.com", "content-type": "text/plain" },
    }],
  ];
  for (const [label, status, options] of transport) {
    const response = await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
      ...options,
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.deepEqual(linkRows(database), before, `${label} must not write`);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'").get().count,
    0,
  );
  clean(database);
});

test("a rate-limited unfollow writes nothing at all", async (context) => {
  const limited = harness(context, { rateLimited: true });
  seedEvent(limited.database);
  // Registration does not use this binding, so the browser still has a link to
  // attempt an unfollow against.
  const owner = await register(limited.api, context, "Daisy", "Duck");
  const response = await limited.api("/api/v1/registrations/mine/unfollow", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
  });

  assert.equal(response.status, 429);
  assert.equal(
    limited.database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(limited.database.prepare("PRAGMA foreign_key_check").all(), []);
});

// ---------------------------------------------------------------------------
// Naming an owned duck
// ---------------------------------------------------------------------------

const nameDuck = (api, cookie, registrationId, duckName, commandId = crypto.randomUUID()) =>
  api("/api/v1/registrations/mine/duck-name", {
    method: "POST",
    cookie,
    headers: { origin: "https://quickducks.com" },
    body: { commandId, registrationId, duckName },
  });

test("the owner names their paired duck and only their own card shows it", async (context) => {
  const { api, staffApi, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);

  const commandId = crypto.randomUUID();
  assert.deepEqual(
    await jsonBody(
      await nameDuck(api, owner.cookie, owner.registrationId, "  Sir   Quacks-a-Lot  ", commandId),
      200,
      "name duck",
    ),
    { named: true, duckName: "Sir Quacks-a-Lot", replayed: false },
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Sir Quacks-a-Lot");

  // The owner's own collection is the one and only place the name appears.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "owner collection",
  );
  assert.equal(mine.registrations[0].duckName, "Sir Quacks-a-Lot");
  assert.equal(mine.registrations[0].nameable, true);
  assert.equal(mine.registrations[0].paired, true);

  // Every public and staff surface keeps the canonical duck number.
  const surfaces = [
    ["tag scan api", await (await api(`/api/v1/ducks/${tagToken}`)).text()],
    ["duck number api", await (await api("/api/v1/ducks/number/12")).text()],
    ["race board", await (await api("/api/v1/race-board")).text()],
    ["public search", await (await api("/api/v1/race-status/search?eventId=event-ducks&name=Daisy")).text()],
    ["tag page", await (await api(`/t/${tagToken}`)).text()],
    ["duck page", await (await api("/duck/12")).text()],
    ["staff duck view", await (await staffApi(`/api/v1/staff/ducks/${tagToken}`)).text()],
  ];
  for (const [label, body] of surfaces) {
    assert.equal(body.includes("Sir Quacks-a-Lot"), false, `${label} must not carry the duck name`);
    assert.equal(/duckName|duck_name/.test(body), false, `${label} must not carry the field`);
  }

  // The follower's collection keeps the field in its uniform shape, always
  // null, so a followed card can never render someone else's chosen name.
  const followerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: follower }),
    200,
    "follower collection",
  );
  assert.equal(followerMine.registrations.length, 1);
  assert.equal(followerMine.registrations[0].followed, true);
  assert.equal(followerMine.registrations[0].duckName, null);
  assert.equal(followerMine.registrations[0].nameable, false);
  assert.equal(JSON.stringify(followerMine).includes("Sir Quacks-a-Lot"), false);
  assert.match(surfaces.find(([label]) => label === "duck page")[1], /Duck #12/);
  assert.match(surfaces.find(([label]) => label === "staff duck view")[1], /"visibleNumber":12/);

  // The audit records the changed field, never the free text.
  const audit = database
    .prepare("SELECT subject_id, actor_type, details_json FROM audit_events WHERE action = 'DUCK_NAME_SET'")
    .all()
    .map((row) => ({ ...row }));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, owner.registrationId);
  assert.equal(audit[0].actor_type, "PUBLIC");
  assert.equal(audit[0].details_json.includes("Sir Quacks-a-Lot"), false);
  assert.deepEqual(JSON.parse(audit[0].details_json).changed_fields, ["duck_name"]);
  // The command log stores a hash of the accepted name, not the name.
  const command = database
    .prepare("SELECT request_fingerprint FROM race_commands WHERE id = ?")
    .get(commandId);
  assert.match(command.request_fingerprint, /^[0-9a-f]{64}$/);

  // Replaying the identical command returns the same result and writes nothing
  // new; reusing it for a different name conflicts.
  assert.deepEqual(
    await jsonBody(
      await nameDuck(api, owner.cookie, owner.registrationId, "Sir Quacks-a-Lot", commandId),
      200,
      "replayed name",
    ),
    { named: true, duckName: "Sir Quacks-a-Lot", replayed: true },
  );
  assert.equal(
    (await nameDuck(api, owner.cookie, owner.registrationId, "Something Else", commandId)).status,
    409,
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Sir Quacks-a-Lot");

  // Renaming with a fresh command replaces the previous name.
  await jsonBody(
    await nameDuck(api, owner.cookie, owner.registrationId, "Bubbles"),
    200,
    "rename",
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Bubbles");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
    2,
  );
  clean(database);
});

test("duck names are validated and trimmed before any database access", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);

  const rejected = [
    ["blank", 422, ""],
    ["whitespace only", 422, "   \t  "],
    ["one character over the limit", 422, "a".repeat(41)],
    ["control characters", 422, "Bub\u0000bles"],
    ["zero-width joiner", 422, "Bub\u200dbles"],
    ["not a string", 400, 12],
    ["missing", 400, undefined],
  ];
  for (const [label, status, duckName] of rejected) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: { origin: "https://quickducks.com" },
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId, duckName },
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.equal(duckNameOf(database, owner.registrationId), null, `${label} must not write`);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
      0,
      `${label} must not record a command`,
    );
  }

  // The boundary values are accepted, trimmed and collapsed.
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, "a"), 200, "one character");
  assert.equal(duckNameOf(database, owner.registrationId), "a");
  const longest = "b".repeat(40);
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, ` ${longest} `), 200, "limit");
  assert.equal(duckNameOf(database, owner.registrationId), longest);
  clean(database);
});

test("only the owner of a paired duck may name it", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const unpaired = await register(api, context, "Donald", "Mallard");

  const refused = [
    // A follower holds the public projection only, so their link can never name
    // someone else's duck.
    ["follower", 404, { cookie: follower, registrationId: owner.registrationId }],
    ["no cookie", 404, { registrationId: owner.registrationId }],
    ["unrelated registration", 404, { cookie: owner.cookie, registrationId: crypto.randomUUID() }],
    // Owned, but there is no duck to name yet.
    ["own unpaired entry", 409, { cookie: unpaired.cookie, registrationId: unpaired.registrationId }],
  ];
  for (const [label, status, options] of refused) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: options.cookie,
      headers: { origin: "https://quickducks.com" },
      body: {
        commandId: crypto.randomUUID(),
        registrationId: options.registrationId,
        duckName: "Not Allowed",
      },
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
  }
  assert.equal(duckNameOf(database, owner.registrationId), null);
  assert.equal(duckNameOf(database, unpaired.registrationId), null);

  // The unpaired owner's own collection reports the same refusal in advance.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: unpaired.cookie }),
    200,
    "unpaired collection",
  );
  assert.equal(mine.registrations[0].nameable, false);
  assert.equal(mine.registrations[0].duckName, null);

  // Cross-origin and missing-origin naming is refused outright.
  for (const [label, origin] of [["missing origin", undefined], ["cross origin", "https://evil.example"]]) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: origin === undefined ? {} : { origin },
      body: {
        commandId: crypto.randomUUID(),
        registrationId: owner.registrationId,
        duckName: "Not Allowed",
      },
    });
    assert.equal(response.status, 403, label);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
    0,
  );
  clean(database);
});

test("the schema refuses a stored duck name that the API would never accept", async (context) => {
  const { database } = harness(context);
  seedEvent(database);
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-1', 'event-ducks', 'Daisy', 'Duck', 'ACTIVE', 'DAASY234', 'hash-1',
            '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event-ducks', 'registration-1');
  `);

  for (const value of ["", "   ", " Bubbles", "Bubbles ", "c".repeat(41)]) {
    assert.throws(
      () => database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run(value),
      /CHECK constraint failed/,
      JSON.stringify(value),
    );
  }
  database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run("Bubbles");
  assert.equal(duckNameOf(database, "registration-1"), "Bubbles");
  // The column stays optional, so a Worker that never writes it still works.
  database.prepare("UPDATE race_entries SET duck_name = NULL WHERE id = 'entry-1'").run();
  assert.equal(duckNameOf(database, "registration-1"), null);
  clean(database);
});
