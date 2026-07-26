import assert from "node:assert/strict";
import test from "node:test";

import { handleApi } from "./api.ts";
import { hashToken, randomToken } from "./registration.ts";

const openEvent = {
  id: "event_test",
  slug: "test-race",
  name: "Test Duck Race",
  event_date: "2026-08-30",
  timezone: "America/Denver",
  status: "REGISTRATION_OPEN",
  registration_opens_at: null,
  registration_closes_at: null,
  email_required: 0,
};

const makeDb = (first) => {
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

const makeEnv = (db, extras = {}) => ({
  APP_ORIGIN: "https://quickducks.com",
  DB: db,
  ...extras,
});

test("returns the current event without private configuration", async () => {
  const db = makeDb(() => openEvent);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/events/current"),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.event, {
    id: "event_test",
    slug: "test-race",
    name: "Test Duck Race",
    eventDate: "2026-08-30",
    timezone: "America/Denver",
    status: "REGISTRATION_OPEN",
    registrationOpensAt: null,
    registrationClosesAt: null,
    emailRequired: false,
  });
  assert.doesNotMatch(db.statements[0].sql, /DRAFT/);
});

test("returns only safe public data for an NFC duck token", async () => {
  const db = makeDb(() => ({
    visible_number: 42,
    inventory_status: "IN_USE",
    tag_status: "ACTIVE",
  }));
  const token = "a".repeat(32);
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/ducks/${token}`),
    makeEnv(db),
  );
  const body = await response.json();

  assert.deepEqual(body, { visibleNumber: 42, tagStatus: "ACTIVE" });
  assert.equal("inventoryStatus" in body, false);
  assert.match(db.statements[0].sql, /t\.status IN \('ACTIVE', 'RETIRED'\)/);
  assert.doesNotMatch(db.statements[0].sql, /inventory_status/);
});

test("rejects cross-origin registration before touching the database", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: "{}",
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("fails closed when Turnstile is not configured", async () => {
  const db = makeDb((sql) => sql.includes("status = 'REGISTRATION_OPEN'") ? openEvent : null);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: JSON.stringify({
        eventId: openEvent.id,
        commandId: crypto.randomUUID(),
        privateToken: randomToken(),
        firstName: "Daisy",
        lastName: "Duck",
      }),
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Registration protection is not configured." });
});

test("rejects oversized registration bodies before querying D1", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "20000" },
      body: "{}",
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 413);
  assert.equal(db.statements.length, 0);
});

test("creates registration, race-entry, command, and audit records atomically", async (context) => {
  const db = makeDb((sql) => sql.includes("status = 'REGISTRATION_OPEN'") ? openEvent : null);
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const privateToken = randomToken();
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: JSON.stringify({
        eventId: openEvent.id,
        commandId: crypto.randomUUID(),
        privateToken,
        firstName: "Daisy",
        lastName: "Duck",
        email: "DAISY@example.com",
        emailNotificationsEnabled: true,
        duckKeepPreference: "RETURN",
        turnstileToken: "verified-test-token",
      }),
    }),
    makeEnv(db, { TURNSTILE_SECRET_KEY: "test-secret" }),
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "SUBMITTED");
  assert.equal(body.privateStatusPath, `/r/${privateToken}`);
  assert.equal(body.replayed, false);
  assert.match(body.lookupCode, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 4);
  assert.match(db.batches[0][0].sql, /INSERT INTO race_commands/);
  assert.match(db.batches[0][1].sql, /INSERT INTO registrations/);
  assert.match(db.batches[0][2].sql, /INSERT INTO race_entries/);
  assert.match(db.batches[0][3].sql, /INSERT INTO audit_events/);
});

test("rejects a Turnstile result for a different hostname", async (context) => {
  const db = makeDb((sql) => sql.includes("status = 'REGISTRATION_OPEN'") ? openEvent : null);
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "example.com",
  }));
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: JSON.stringify({
        eventId: openEvent.id,
        commandId: crypto.randomUUID(),
        privateToken: randomToken(),
        firstName: "Daisy",
        lastName: "Duck",
        turnstileToken: "token-for-another-site",
      }),
    }),
    makeEnv(db, { TURNSTILE_SECRET_KEY: "test-secret" }),
  );

  assert.equal(response.status, 422);
  assert.equal(db.batches.length, 0);
});

test("replays a completed command without reusing a Turnstile token", async () => {
  const privateToken = randomToken();
  const privateTokenHash = await hashToken(privateToken);
  const db = makeDb((sql) => {
    if (sql.includes("status = 'REGISTRATION_OPEN'")) return openEvent;
    if (sql.includes("FROM race_commands")) {
      return {
        result_id: "registration_existing",
        lookup_code: "DUCK2026",
        private_token_hash: privateTokenHash,
      };
    }
    return null;
  });
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: JSON.stringify({
        eventId: openEvent.id,
        commandId: crypto.randomUUID(),
        privateToken,
        firstName: "Daisy",
        lastName: "Duck",
      }),
    }),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.registrationId, "registration_existing");
  assert.equal(body.replayed, true);
  assert.equal(db.batches.length, 0);
  assert.equal(db.statements.length, 1);
});
