import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createWorker } from "./index.ts";
import { randomToken } from "./registration.ts";

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

const seedEvent = (database, status = "REGISTRATION_OPEN", policy = "FIRST_NAME_LAST_INITIAL") => {
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event-follow', 'follow-race', 'Follow Race', '2026-08-30', 'America/Denver',
            '${status}', '${policy}');
  `);
};

const makeEnv = (database) => ({
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
  DB: createD1(database),
  EMAIL_QUEUE: { async send() {} },
  PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
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

const harness = (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const env = makeEnv(database);
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
    }), env, { waitUntil() {} });
  };
  return { api, database };
};

const register = async (api, context, firstName, lastName, options = {}) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const commandId = options.commandId ?? crypto.randomUUID();
  const privateToken = options.privateToken ?? randomToken();
  const response = await api("/api/v1/registrations", {
    method: "POST",
    cookie: options.cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId: "event-follow",
      commandId,
      privateToken,
      firstName,
      lastName,
      turnstileToken: "turnstile-test",
    },
  });
  const body = await jsonBody(response, options.status ?? 201, `register ${firstName}`);
  context.mock.restoreAll();
  return { ...body, commandId, privateToken, cookie: cookieFrom(response) };
};

const registerDaisy = (api, context) => register(api, context, "Daisy", "Duck");

const followDaisy = async (api, cookie) => {
  const search = await jsonBody(
    await api("/api/v1/race-status/search?eventId=event-follow&name=Daisy", { cookie }),
    200,
    "public search",
  );
  return search.results[0];
};

test("a followed search result joins My Ducks without ever exposing a lookup code", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await registerDaisy(api, context);

  // A second browser finds the participant through the public name search only.
  const searchResponse = await api(
    "/api/v1/race-status/search?eventId=event-follow&name=Daisy",
  );
  const search = await jsonBody(searchResponse, 200, "public search");
  assert.equal(searchResponse.headers.get("set-cookie"), null, "a read-only search must not issue a cookie");
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].participantDisplayName, "Daisy D.");
  assert.equal(search.results[0].inMyDucks, false);
  assert.match(search.results[0].followId, /^[0-9a-f-]{36}$/);
  assert.equal(/email|phone|lookup|privateStatusPath|token/i.test(JSON.stringify(search)), false);
  assert.equal(JSON.stringify(search).includes(owner.lookupCode), false);

  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: search.results[0].followId },
  });
  const follow = await jsonBody(followResponse, 200, "follow participant");
  assert.deepEqual(follow, { followed: true, alreadyInCollection: false });
  assert.equal(/lookup|name|token|registrationId/i.test(JSON.stringify(follow)), false);
  const followerCookie = cookieFrom(followResponse);
  assert.notEqual(followerCookie, owner.cookie);

  // The follower's collection carries public race status and nothing more.
  const followerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: followerCookie }),
    200,
    "follower collection",
  );
  assert.equal(followerMine.registrations.length, 1);
  const followed = followerMine.registrations[0];
  assert.equal(followed.followed, true);
  assert.equal(followed.lookupCode, null);
  assert.equal(followed.firstName, null);
  assert.equal(followed.lastName, null);
  // The projection never widens past the policy-filtered name the search showed.
  assert.equal(followed.displayName, "Daisy D.");
  assert.equal(followed.raceStatus.outcome, "AWAITING_DUCK_PAIRING");
  assert.equal(JSON.stringify(followerMine).includes(owner.lookupCode), false);
  assert.equal(JSON.stringify(followerMine).includes("Duck"), false, "the masked last name must not leak");
  assert.equal(/email|phone|privateStatusPath/i.test(JSON.stringify(followerMine)), false);

  // The presence probe still reveals the nav for a purely followed collection.
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/presence", { cookie: followerCookie }),
      200,
      "follower presence",
    ),
    { hasRegistrations: true },
  );

  // Searching again from the follower's browser reflects the existing entry.
  const repeatSearch = await jsonBody(
    await api("/api/v1/race-status/search?eventId=event-follow&name=Daisy", { cookie: followerCookie }),
    200,
    "repeat search",
  );
  assert.equal(repeatSearch.results[0].inMyDucks, true);
  assert.equal(JSON.stringify(repeatSearch).includes(owner.lookupCode), false);

  // Following twice is an idempotent no-op success.
  const repeatFollow = await jsonBody(
    await api("/api/v1/registrations/mine/follow", {
      method: "POST",
      cookie: followerCookie,
      headers: { origin: "https://quickducks.com" },
      body: { followId: search.results[0].followId },
    }),
    200,
    "repeat follow",
  );
  assert.deepEqual(repeatFollow, { followed: true, alreadyInCollection: true });

  // The registering browser keeps its own lookup code and unmasked name.
  const ownerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "owner collection",
  );
  assert.equal(ownerMine.registrations.length, 1);
  assert.equal(ownerMine.registrations[0].followed, false);
  assert.equal(ownerMine.registrations[0].lookupCode, owner.lookupCode);
  assert.equal(ownerMine.registrations[0].displayName, "Daisy Duck");

  assert.deepEqual(
    database.prepare(
      "SELECT added_via, COUNT(*) AS count FROM browser_collection_registrations GROUP BY added_via ORDER BY added_via",
    ).all().map((row) => ({ ...row })),
    [{ added_via: "FOLLOWED", count: 1 }, { added_via: "REGISTRATION", count: 1 }],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a followed link never suppresses a registration made in the same browser", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await registerDaisy(api, context);
  const match = await followDaisy(api);

  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: match.followId },
  });
  const followerCookie = cookieFrom(followResponse);

  // The following browser also registers a participant of its own, so its
  // collection mixes a followed entry with an owned entry.
  const own = await register(api, context, "Donald", "Mallard", { cookie: followerCookie });

  // Replaying Daisy's original registration from that browser is the supported
  // idempotent path, and it must upgrade the existing followed link.
  const replay = await register(api, context, "Daisy", "Duck", {
    cookie: followerCookie,
    commandId: owner.commandId,
    privateToken: owner.privateToken,
    status: 200,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.lookupCode, owner.lookupCode);

  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: followerCookie }),
    200,
    "mixed collection",
  );
  assert.deepEqual(mine.registrations.map((item) => item.followed), [false, false]);
  assert.deepEqual(
    mine.registrations.map((item) => item.lookupCode),
    [owner.lookupCode, own.lookupCode],
  );
  assert.deepEqual(mine.registrations.map((item) => item.displayName), ["Daisy Duck", "Donald Mallard"]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM browser_collection_registrations WHERE added_via = 'FOLLOWED'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the follow endpoint validates transport, shape, and public searchability before writing", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await registerDaisy(api, context);
  const followId = (await followDaisy(api)).followId;
  const countLinks = () => database.prepare(
    "SELECT COUNT(*) AS count FROM browser_collection_registrations",
  ).get().count;
  const before = countLinks();

  const rejected = [
    ["wrong content type", 415, {
      method: "POST",
      headers: { origin: "https://quickducks.com", "content-type": "text/plain" },
      body: { followId },
    }],
    ["missing origin", 403, { method: "POST", body: { followId } }],
    ["cross origin", 403, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: { followId },
    }],
    ["array body", 400, {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
      body: [followId],
    }],
    ["non-uuid identifier", 400, {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
      body: { followId: "registration-one" },
    }],
    ["unknown identifier", 404, {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
      body: { followId: crypto.randomUUID() },
    }],
  ];
  for (const [label, status, options] of rejected) {
    const response = await api("/api/v1/registrations/mine/follow", options);
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.equal(countLinks(), before, `${label} must not write`);
  }

  // A withdrawn registration disappears from the public search and cannot be
  // followed, even with an identifier captured while it was searchable.
  database.prepare("UPDATE registrations SET status = 'WITHDRAWN' WHERE lookup_code = ?").run(owner.lookupCode);
  const hiddenSearch = await jsonBody(
    await api("/api/v1/race-status/search?eventId=event-follow&name=Daisy"),
    200,
    "withdrawn search",
  );
  assert.deepEqual(hiddenSearch.results, []);
  const staleFollow = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId },
  });
  assert.equal(staleFollow.status, 404);
  assert.equal(countLinks(), before);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the follow endpoint refuses entries outside the current public event", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await registerDaisy(api, context);
  const followId = (await followDaisy(api)).followId;
  assert.ok(owner.lookupCode);

  database.prepare("UPDATE events SET status = 'RETURN_PROCESSING' WHERE id = 'event-follow'").run();
  const afterReturn = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId },
  });
  assert.equal(afterReturn.status, 404);

  database.prepare("UPDATE events SET status = 'ARCHIVED' WHERE id = 'event-follow'").run();
  const archived = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId },
  });
  assert.equal(archived.status, 404);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM browser_collection_registrations WHERE added_via = 'FOLLOWED'").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a rate-limited follow writes nothing", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  seedEvent(database);
  const env = { ...makeEnv(database), PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: false }; } } };
  const worker = createWorker(async () => null);

  const response = await worker.fetch(new Request("https://quickducks.com/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quickducks.com" },
    body: JSON.stringify({ followId: crypto.randomUUID() }),
  }), env, { waitUntil() {} });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM browser_registration_collections").get().count,
    0,
  );
});
