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
  bind(...args) { this.args = args; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

const createD1 = (database) => ({
  prepare(sql) { return new D1Statement(database, sql); },
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
  assert.ok(token, "expected browser collection cookie");
  return `__Host-quickducks_browser=${token}`;
};

const harness = (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  database.exec(`
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event-contact', 'contact-race', 'Contact Race', '2026-08-30', 'UTC',
            'REGISTRATION_OPEN', 'FIRST_NAME_LAST_INITIAL');
  `);
  const env = makeEnv(database);
  const liveFrames = [];
  env.RACE_UPDATES = {
    idFromName() { return "race-updates"; },
    get() {
      return {
        async fetch(_url, init) {
          liveFrames.push(String(init.body));
          return new Response(null, { status: 204 });
        },
      };
    },
  };
  const worker = createWorker(async () => null);
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie) headers.set("cookie", options.cookie);
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
  return { api, database, liveFrames };
};

const register = async (api, context, firstName, options = {}) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const privateToken = randomToken();
  const response = await api("/api/v1/registrations", {
    method: "POST",
    cookie: options.cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId: "event-contact",
      commandId: crypto.randomUUID(),
      privateToken,
      firstName,
      lastName: "Racer",
      email: options.email ?? `${firstName.toLowerCase()}@example.test`,
      phone: options.phone ?? "+15550102030",
      emailNotificationsEnabled: false,
      turnstileToken: "turnstile-test",
    },
  });
  const body = await jsonBody(response, 201, `register ${firstName}`);
  context.mock.restoreAll();
  return { ...body, privateToken, cookie: cookieFrom(response) };
};

const contactPath = (registrationId) =>
  `/api/v1/registrations/mine/${registrationId}/contact`;

const proofHeaders = (proof, origin) => ({
  ...(origin === undefined ? {} : { origin }),
  "x-quickducks-ownership-proof": proof,
});

test("owned contact reads and updates require participant-specific proof", async (context) => {
  const { api, database, liveFrames } = harness(context);
  const first = await register(api, context, "Alpha", {
    email: "alpha.owner@example.test",
    phone: "+15550100001",
  });
  const second = await register(api, context, "Beta", {
    cookie: first.cookie,
    email: "beta.owner@example.test",
    phone: "+15550100002",
  });
  const unrelated = await register(api, context, "Gamma", {
    email: "gamma.owner@example.test",
    phone: "+15550100003",
  });
  const cookie = second.cookie;
  liveFrames.length = 0;

  const initialResponse = await api(contactPath(first.registrationId), {
    cookie,
    headers: proofHeaders(first.privateToken),
  });
  const initial = await jsonBody(initialResponse, 200, "owner contact read");
  assert.deepEqual(initial, {
    registrationId: first.registrationId,
    email: "alpha.owner@example.test",
    phone: "+15550100001",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
    revision: 0,
  });
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  assert.equal(/proof|token|lookup|name/i.test(JSON.stringify(initial)), false);

  for (const [label, options] of [
    ["missing proof", { cookie }],
    ["invalid proof", { cookie, headers: proofHeaders("x".repeat(43)) }],
    ["proof for another participant", { cookie, headers: proofHeaders(second.privateToken) }],
    ["proof without collection", { headers: proofHeaders(first.privateToken) }],
    ["proof with an unrelated collection", { cookie: unrelated.cookie, headers: proofHeaders(first.privateToken) }],
  ]) {
    await jsonBody(await api(contactPath(first.registrationId), options), 404, label);
  }
  await jsonBody(await api(contactPath(second.registrationId), {
    cookie,
    headers: proofHeaders(first.privateToken),
  }), 404, "participant A proof against participant B");

  const commandId = crypto.randomUUID();
  const updatePayload = {
    commandId,
    expectedRevision: initial.revision,
    email: "  ALPHA.NEW@EXAMPLE.TEST ",
    phone: " +15550109999 ",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
  };
  for (const [label, options] of [
    ["missing proof contact mutation", { cookie }],
    ["invalid proof contact mutation", { cookie, headers: proofHeaders("invalid") }],
    ["mismatched proof contact mutation", { cookie, headers: proofHeaders(second.privateToken) }],
    ["proof without collection contact mutation", { headers: proofHeaders(first.privateToken) }],
    ["unrelated collection contact mutation", {
      cookie: unrelated.cookie,
      headers: proofHeaders(first.privateToken),
    }],
  ]) {
    await jsonBody(await api(contactPath(first.registrationId), {
      method: "PATCH",
      ...options,
      headers: {
        ...options.headers,
        origin: "https://quickducks.com",
      },
      body: updatePayload,
    }), 404, label);
  }
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UPDATE_PARTICIPANT_CONTACT'",
  ).get().count, 0, "denied mutations write no command");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'PARTICIPANT_CONTACT_UPDATED'",
  ).get().count, 0, "denied mutations write no audit event");
  const updated = await jsonBody(await api(contactPath(first.registrationId), {
    method: "PATCH",
    cookie,
    headers: proofHeaders(first.privateToken, "https://quickducks.com"),
    body: updatePayload,
  }), 200, "owner contact update");
  assert.deepEqual(updated, {
    registrationId: first.registrationId,
    email: "alpha.new@example.test",
    phone: "+15550109999",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
    revision: 1,
    replayed: false,
  });
  assert.deepEqual(liveFrames, [], "private contact updates publish no WebSocket data");
  assert.deepEqual(
    { ...database.prepare(`
      SELECT email, phone, email_notifications_enabled, sms_notifications_enabled, revision
        FROM registrations WHERE id = ?
    `).get(first.registrationId) },
    {
      email: "alpha.new@example.test",
      phone: "+15550109999",
      email_notifications_enabled: 1,
      sms_notifications_enabled: 1,
      revision: 1,
    },
  );
  const persisted = await jsonBody(await api(contactPath(first.registrationId), {
    cookie,
    headers: proofHeaders(first.privateToken),
  }), 200, "persisted owner contact read");
  assert.deepEqual(persisted, {
    registrationId: first.registrationId,
    email: "alpha.new@example.test",
    phone: "+15550109999",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
    revision: 1,
  });

  const staleCommandId = crypto.randomUUID();
  await jsonBody(await api(contactPath(first.registrationId), {
    method: "PATCH",
    cookie,
    headers: proofHeaders(first.privateToken, "https://quickducks.com"),
    body: { ...updatePayload, commandId: staleCommandId, phone: "+15550107777" },
  }), 409, "stale contact revision");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE id = ?",
  ).get(staleCommandId).count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE command_id = ?",
  ).get(staleCommandId).count, 0);

  const replay = await jsonBody(await api(contactPath(first.registrationId), {
    method: "PATCH",
    cookie,
    headers: proofHeaders(first.privateToken, "https://quickducks.com"),
    body: updatePayload,
  }), 200, "idempotent replay");
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE command_id = ?",
  ).get(commandId).count, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE id = ?",
  ).get(commandId).count, 1);

  await jsonBody(await api(contactPath(first.registrationId), {
    method: "PATCH",
    cookie,
    headers: proofHeaders(first.privateToken, "https://quickducks.com"),
    body: { ...updatePayload, phone: "+15550108888" },
  }), 409, "command reuse with different material");

  const audit = database.prepare(
    "SELECT details_json FROM audit_events WHERE command_id = ?",
  ).get(commandId).details_json;
  assert.deepEqual(JSON.parse(audit).changed_fields, [
    "email",
    "phone",
    "email_notifications_enabled",
    "sms_notifications_enabled",
  ]);
  const command = database.prepare(
    "SELECT request_fingerprint FROM race_commands WHERE id = ?",
  ).get(commandId).request_fingerprint;
  for (const secret of ["alpha.new@example.test", "+15550109999", first.privateToken]) {
    assert.equal(audit.includes(secret), false);
    assert.equal(command.includes(secret), false);
  }
  database.prepare(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status, queued_at)
    VALUES ('queued-reminder', 'event-contact', ?, 'HEAT_UPCOMING', 'QUEUED',
            '2026-07-30T00:00:00.000Z')
  `).run(first.registrationId);
  const optedOut = await jsonBody(await api(contactPath(first.registrationId), {
    method: "PATCH",
    cookie,
    headers: proofHeaders(first.privateToken, "https://quickducks.com"),
    body: {
      commandId: crypto.randomUUID(),
      expectedRevision: 1,
      email: "alpha.new@example.test",
      phone: "+15550109999",
      emailNotificationsEnabled: false,
      smsNotificationsEnabled: true,
    },
  }), 200, "opt out with a queued reminder");
  assert.equal(optedOut.emailNotificationsEnabled, false);
  assert.equal(optedOut.revision, 2);
  const cancelledReminder = { ...database.prepare(`
    SELECT status, terminal_at, status_reason
      FROM email_notifications WHERE id = 'queued-reminder'
  `).get() };
  assert.equal(cancelledReminder.status, "CANCELLED");
  assert.equal(cancelledReminder.status_reason, "PARTICIPANT_OPTED_OUT");
  assert.ok(cancelledReminder.terminal_at);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("contact mutation validates transport and private projections stay isolated", async (context) => {
  const { api, database } = harness(context);
  const owner = await register(api, context, "Private", {
    email: "private.sentinel@example.test",
    phone: "+15550999999",
  });
  const path = contactPath(owner.registrationId);
  const valid = {
    commandId: crypto.randomUUID(),
    expectedRevision: 0,
    email: "private.sentinel@example.test",
    phone: "+15550999999",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
  };
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken),
    body: valid,
  }), 403, "missing Origin");
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken, "https://evil.example"),
    body: valid,
  }), 403, "cross Origin");
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken, "https://quickducks.com"),
    body: { ...valid, firstName: "Not allowed" },
  }), 400, "unknown field");
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken, "https://quickducks.com"),
    body: { ...valid, commandId: crypto.randomUUID(), email: "not-email" },
  }), 422, "invalid email");
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken, "https://quickducks.com"),
    body: {
      ...valid,
      commandId: crypto.randomUUID(),
      phone: null,
      smsNotificationsEnabled: true,
    },
  }), 422, "SMS consent without phone");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UPDATE_PARTICIPANT_CONTACT'",
  ).get().count, 0);

  // A second browser follows through the public flow. Its link is public-only,
  // so it cannot mint proof or read contact even though it knows the stable ID
  // returned by its own My Ducks projection.
  const search = await jsonBody(await api(
    "/api/v1/race-status/search?eventId=event-contact&name=Private",
  ), 200, "public search");
  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: search.results[0].followId },
  });
  await jsonBody(followResponse, 200, "follow");
  const followerCookie = cookieFrom(followResponse);
  await jsonBody(await api("/api/v1/registrations/mine/contact-proof", {
    method: "POST",
    cookie: followerCookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      commandId: crypto.randomUUID(),
      registrationId: owner.registrationId,
      ownershipProof: randomToken(),
    },
  }), 404, "follower proof mint");
  await jsonBody(await api(path, {
    cookie: followerCookie,
    headers: proofHeaders(owner.privateToken),
  }), 404, "follower contact read");
  await jsonBody(await api(path, {
    method: "PATCH",
    cookie: followerCookie,
    headers: proofHeaders(owner.privateToken, "https://quickducks.com"),
    body: { ...valid, commandId: crypto.randomUUID() },
  }), 404, "follower contact mutation");

  const followerMine = await jsonBody(await api("/api/v1/registrations/mine", {
    cookie: followerCookie,
  }), 200, "follower collection");
  const privateStatus = await jsonBody(await api(`/api/v1/registrations/${owner.privateToken}`), 200, "private status");
  const board = await jsonBody(await api("/api/v1/race-board"), 200, "public board");
  for (const projection of [search, followerMine, privateStatus, board]) {
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes("private.sentinel@example.test"), false);
    assert.equal(serialized.includes("+15550999999"), false);
    assert.equal(/smsNotificationsEnabled|emailNotificationsEnabled|ownershipProof/i.test(serialized), false);
  }

  // The compatibility endpoint initializes only old NULL links. Losing a proof
  // from a current browser must fail closed rather than silently rotating it
  // from the broader collection cookie.
  const replacementCommandId = crypto.randomUUID();
  await jsonBody(await api("/api/v1/registrations/mine/contact-proof", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      commandId: replacementCommandId,
      registrationId: owner.registrationId,
      ownershipProof: randomToken(),
    },
  }), 404, "established proof replacement");
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE id = ?",
  ).get(replacementCommandId).count, 0);
  await jsonBody(await api(path, {
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken),
  }), 200, "established proof remains active");

  // A pre-migration retained owner link has no proof hash. It can mint a new
  // participant-bound proof without registration, then use only that proof.
  database.prepare(`
    UPDATE browser_collection_registrations
       SET ownership_proof_hash = NULL
     WHERE registration_id = ? AND added_via = 'REGISTRATION'
  `).run(owner.registrationId);
  const legacyProof = randomToken();
  const proofCommandId = crypto.randomUUID();
  const proofPayload = {
    commandId: proofCommandId,
    registrationId: owner.registrationId,
    ownershipProof: legacyProof,
  };
  const minted = await jsonBody(await api("/api/v1/registrations/mine/contact-proof", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: proofPayload,
  }), 200, "legacy proof mint");
  assert.deepEqual(minted, {
    registrationId: owner.registrationId,
    ownershipProofAccepted: true,
    replayed: false,
  });
  const replayedMint = await jsonBody(await api("/api/v1/registrations/mine/contact-proof", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: proofPayload,
  }), 200, "legacy proof mint replay");
  assert.equal(replayedMint.replayed, true);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE command_id = ?",
  ).get(proofCommandId).count, 1);
  await jsonBody(await api(path, {
    cookie: owner.cookie,
    headers: proofHeaders(legacyProof),
  }), 200, "legacy retained owner read");
  await jsonBody(await api(path, {
    cookie: owner.cookie,
    headers: proofHeaders(owner.privateToken),
  }), 404, "rotated old proof denied");
});
