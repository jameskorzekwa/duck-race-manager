import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createWorker } from "./index.ts";
import { hashToken, randomToken } from "./registration.ts";

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
  database.exec(`
    INSERT INTO events
      (id, slug, name, event_date, timezone, status, email_required, public_name_policy)
    VALUES
      ('event-contact', 'contact-race', 'Contact Race', '2026-08-30', 'America/Denver',
       'REGISTRATION_OPEN', 0, 'FIRST_NAME_LAST_INITIAL');
  `);
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

const cookieFrom = (response) => {
  const token = response.headers.get("set-cookie")?.match(/__Host-quickducks_browser=([^;]+)/)?.[1];
  assert.ok(token, "expected browser collection cookie");
  return `__Host-quickducks_browser=${token}`;
};

const jsonBody = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

const harness = (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const worker = createWorker(async () => null);
  const env = makeEnv(database);
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie) headers.set("cookie", options.cookie);
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
  return { api, database };
};

const register = async (api, context, firstName, lastName, cookie) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const privateToken = randomToken();
  const response = await api("/api/v1/registrations", {
    method: "POST",
    cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId: "event-contact",
      commandId: crypto.randomUUID(),
      privateToken,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}@owner.example`,
      phone: "+15550102030",
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

const proofHeaders = (proof, mutation = false) => ({
  "x-quickducks-ownership-proof": proof,
  ...(mutation ? { origin: "https://quickducks.com" } : {}),
});

test("owner contact reads and updates are proof-scoped, persistent, and privacy-safe", async (context) => {
  const { api, database } = harness(context);
  const daisy = await register(api, context, "Daisy", "Duck");
  const donald = await register(api, context, "Donald", "Mallard", daisy.cookie);
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: donald.cookie }),
    200,
    "owner collection",
  );
  const daisyCard = mine.registrations.find((item) => item.registrationId === daisy.registrationId);
  const donaldCard = mine.registrations.find((item) => item.registrationId === donald.registrationId);
  assert.match(daisyCard.ownershipProof, /^[A-Za-z0-9_-]{43}$/);
  assert.match(donaldCard.ownershipProof, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(daisyCard.ownershipProof, donaldCard.ownershipProof);
  assert.equal(/daisy@owner\.example|\+15550102030/.test(JSON.stringify(mine)), false);

  const initialResponse = await api(contactPath(daisy.registrationId), {
      cookie: donald.cookie,
      headers: proofHeaders(daisyCard.ownershipProof),
    });
  const initial = await jsonBody(
    initialResponse,
    200,
    "authorized contact read",
  );
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  assert.equal(initialResponse.headers.get("set-cookie"), null, "private reads must not rotate collection state");
  assert.deepEqual(initial.contact, {
    email: "daisy@owner.example",
    phone: "+15550102030",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
    emailRequired: false,
    revision: 0,
  });
  assert.equal((await api(contactPath(daisy.registrationId), { cookie: donald.cookie })).status, 404);
  assert.equal((await api(contactPath(daisy.registrationId), {
    cookie: donald.cookie,
    headers: proofHeaders("invalid"),
  })).status, 404);
  assert.equal((await api(contactPath(donald.registrationId), {
    cookie: donald.cookie,
    headers: proofHeaders(daisyCard.ownershipProof),
  })).status, 404, "proof for Daisy must not read Donald");
  assert.equal((await api(contactPath(daisy.registrationId), {
    headers: proofHeaders(daisyCard.ownershipProof),
  })).status, 404, "proof copied without its device cookie must be useless");

  const commandId = crypto.randomUUID();
  const updateBody = {
    commandId,
    expectedRevision: initial.contact.revision,
    email: "  Daisy.Updated@Example.Test ",
    phone: "+15550999999",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
  };
  const updated = await jsonBody(
    await api(contactPath(daisy.registrationId), {
      method: "POST",
      cookie: donald.cookie,
      headers: proofHeaders(daisyCard.ownershipProof, true),
      body: updateBody,
    }),
    200,
    "authorized contact update",
  );
  assert.equal(updated.replayed, false);
  assert.deepEqual(updated.contact, {
    email: "daisy.updated@example.test",
    phone: "+15550999999",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
    emailRequired: false,
    revision: 1,
  });
  assert.deepEqual(
    { ...database.prepare(
      `SELECT email, phone, email_notifications_enabled, sms_notifications_enabled, revision
         FROM registrations WHERE id = ?`,
    ).get(daisy.registrationId) },
    {
      email: "daisy.updated@example.test",
      phone: "+15550999999",
      email_notifications_enabled: 1,
      sms_notifications_enabled: 1,
      revision: 1,
    },
  );

  const replay = await jsonBody(
    await api(contactPath(daisy.registrationId), {
      method: "POST",
      cookie: donald.cookie,
      headers: proofHeaders(daisyCard.ownershipProof, true),
      body: updateBody,
    }),
    200,
    "idempotent replay",
  );
  assert.equal(replay.replayed, true);
  const conflict = await api(contactPath(daisy.registrationId), {
    method: "POST",
    cookie: donald.cookie,
    headers: proofHeaders(daisyCard.ownershipProof, true),
    body: { ...updateBody, phone: "+15550000000" },
  });
  assert.equal(conflict.status, 409, "same command with different private material must conflict");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UPDATE_OWN_CONTACT'").get().count,
    1,
  );
  const command = database.prepare(
    "SELECT request_fingerprint FROM race_commands WHERE command_type = 'UPDATE_OWN_CONTACT'",
  ).get();
  assert.match(command.request_fingerprint, /^[A-Za-z0-9_-]{43}$/);
  const audit = database.prepare(
    "SELECT details_json FROM audit_events WHERE action = 'REGISTRATION_CONTACT_UPDATED'",
  ).get();
  assert.deepEqual(JSON.parse(audit.details_json).changed_fields.sort(), [
    "email",
    "email_notifications_enabled",
    "phone",
    "sms_notifications_enabled",
  ]);
  for (const privateValue of [
    "daisy.updated@example.test", "+15550999999", daisyCard.ownershipProof,
  ]) {
    assert.equal(command.request_fingerprint.includes(privateValue), false);
    assert.equal(audit.details_json.includes(privateValue), false);
  }

  const persisted = await jsonBody(
    await api(contactPath(daisy.registrationId), {
      cookie: donald.cookie,
      headers: proofHeaders(daisyCard.ownershipProof),
    }),
    200,
    "persisted contact read",
  );
  assert.deepEqual(persisted.contact, updated.contact);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("contact mutations validate transport and fields before writing", async (context) => {
  const { api, database } = harness(context);
  const owner = await register(api, context, "Daisy", "Duck");
  const mine = await jsonBody(await api("/api/v1/registrations/mine", { cookie: owner.cookie }), 200, "mine");
  const proof = mine.registrations[0].ownershipProof;
  const initialCommands = database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count;
  const initialAudits = database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count;
  database.exec("UPDATE events SET email_required = 1 WHERE id = 'event-contact'");
  const valid = {
    commandId: crypto.randomUUID(),
    expectedRevision: 0,
    email: "valid@example.test",
    phone: "+15550102030",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
  };
  const rejected = [
    ["missing origin", 403, { method: "POST", cookie: owner.cookie, headers: proofHeaders(proof), body: valid }],
    ["cross origin", 403, {
      method: "POST", cookie: owner.cookie,
      headers: { ...proofHeaders(proof), origin: "https://evil.example" }, body: valid,
    }],
    ["wrong content type", 415, {
      method: "POST", cookie: owner.cookie,
      headers: { ...proofHeaders(proof, true), "content-type": "text/plain" }, body: valid,
    }],
    ["invalid email", 422, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: { ...valid, commandId: crypto.randomUUID(), email: "not-email" },
    }],
    ["SMS without phone", 422, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: { ...valid, commandId: crypto.randomUUID(), phone: null, smsNotificationsEnabled: true },
    }],
    ["email updates without email", 422, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: { ...valid, commandId: crypto.randomUUID(), email: null, emailNotificationsEnabled: true },
    }],
    ["required email clearing", 422, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: {
        ...valid, commandId: crypto.randomUUID(), email: null,
        emailNotificationsEnabled: false,
      },
    }],
    ["unknown writable field", 400, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: { ...valid, commandId: crypto.randomUUID(), firstName: "Changed" },
    }],
    ["non-boolean preference", 422, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders(proof, true),
      body: { ...valid, commandId: crypto.randomUUID(), smsNotificationsEnabled: "yes" },
    }],
    ["mismatched proof", 404, {
      method: "POST", cookie: owner.cookie, headers: proofHeaders("A".repeat(43), true), body: valid,
    }],
    ["missing proof", 404, {
      method: "POST", cookie: owner.cookie, headers: { origin: "https://quickducks.com" }, body: valid,
    }],
  ];
  for (const [label, status, options] of rejected) {
    const response = await api(contactPath(owner.registrationId), options);
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands").get().count, initialCommands, label);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, initialAudits, label);
  }
});

test("follower and unrelated devices stay outside contact APIs and public projections", async (context) => {
  const { api, database } = harness(context);
  const owner = await register(api, context, "Daisy", "Duck");
  const ownerMine = await jsonBody(await api("/api/v1/registrations/mine", { cookie: owner.cookie }), 200, "owner mine");
  const proof = ownerMine.registrations[0].ownershipProof;
  const search = await jsonBody(
    await api("/api/v1/race-status/search?eventId=event-contact&name=Daisy%20Duck"),
    200,
    "public search",
  );
  assert.equal(search.results.length, 1);
  assert.equal(/owner\.example|\+15550102030|ownershipProof|emailNotificationsEnabled|smsNotificationsEnabled/.test(JSON.stringify(search)), false);
  const privateStatus = await jsonBody(
    await api(`/api/v1/registrations/${owner.privateToken}`),
    200,
    "private status projection",
  );
  const board = await jsonBody(await api("/api/v1/race-board"), 200, "public board projection");
  for (const projection of [privateStatus, board]) {
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes("daisy@owner.example"), false);
    assert.equal(serialized.includes("+15550102030"), false);
    assert.equal(/emailNotificationsEnabled|smsNotificationsEnabled|ownershipProof/.test(serialized), false);
  }
  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: search.results[0].followId },
  });
  await jsonBody(followResponse, 200, "follow");
  const followerCookie = cookieFrom(followResponse);
  const followerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: followerCookie }),
    200,
    "follower mine",
  );
  assert.equal(followerMine.registrations[0].followed, true);
  assert.equal("ownershipProof" in followerMine.registrations[0], false);
  assert.equal(/email|phone|NotificationsEnabled|ownershipProof/.test(JSON.stringify(followerMine)), false);
  assert.equal((await api(contactPath(owner.registrationId), {
    cookie: followerCookie,
    headers: proofHeaders(proof),
  })).status, 404, "copied owner proof must not authorize a follower cookie");
  assert.equal((await api(contactPath(owner.registrationId), {
    method: "POST",
    cookie: followerCookie,
    headers: proofHeaders(proof, true),
    body: {
      commandId: crypto.randomUUID(), expectedRevision: 0, email: null, phone: null,
      emailNotificationsEnabled: false, smsNotificationsEnabled: false,
    },
  })).status, 404);

  // A link retained from before proof support gains a lazily-derived proof and
  // correct participant access without re-registration or schema backfill.
  const legacyToken = "L".repeat(43);
  database.prepare(
    `INSERT INTO browser_registration_collections
      (id, token_hash, created_at, last_seen_at, expires_at)
     VALUES ('legacy-collection', ?, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2099-01-01T00:00:00Z')`,
  ).run(await hashToken(legacyToken));
  database.prepare(
    `INSERT INTO browser_collection_registrations (collection_id, registration_id, added_at)
     VALUES ('legacy-collection', ?, '2026-07-01T00:00:00Z')`,
  ).run(owner.registrationId);
  const legacyCookie = `__Host-quickducks_browser=${legacyToken}`;
  const legacyMine = await jsonBody(await api("/api/v1/registrations/mine", { cookie: legacyCookie }), 200, "legacy mine");
  assert.match(legacyMine.registrations[0].ownershipProof, /^[A-Za-z0-9_-]{43}$/);
  const legacyContact = await jsonBody(await api(contactPath(owner.registrationId), {
    cookie: legacyCookie,
    headers: proofHeaders(legacyMine.registrations[0].ownershipProof),
  }), 200, "legacy owner contact");
  assert.equal(legacyContact.contact.email, "daisy@owner.example");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
