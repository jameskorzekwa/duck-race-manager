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
        async run() {
          return { success: true };
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
  PUBLIC_SEARCH_RATE_LIMITER: {
    async limit() {
      return { success: true };
    },
  },
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
  const db = makeDb((sql) => {
    if (sql.includes("FROM heats")) return null;
    return {
      event_id: "event_test",
      event_slug: "test-race",
      event_name: "Test Duck Race",
      event_date: "2026-08-30",
      event_status: "ROUND_ONE",
      public_name_policy: "FIRST_NAME_LAST_INITIAL",
      first_name: "Daisy",
      last_name: "Duck",
      registration_status: "ACTIVE",
      race_entry_id: "entry_test",
      visible_number: 42,
      round_one_heat_number: 8,
      round_one_heat_status: "PLANNED",
      round_one_place: null,
      final_heat_number: null,
      final_heat_status: null,
      final_place: null,
    };
  });
  const token = "a".repeat(32);
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/ducks/${token}`),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.destination, "RACE_STATUS");
  assert.equal(body.raceStatus.duck.visibleNumber, 42);
  assert.equal(body.raceStatus.participantDisplayName, "Daisy D.");
  assert.equal(body.raceStatus.assignedHeat.roundOne.number, 8);
  assert.equal("email" in body.raceStatus, false);
  assert.equal("phone" in body.raceStatus, false);
  assert.equal("lookupCode" in body.raceStatus, false);
});

test("does not disclose whether an anonymous unassigned tag exists", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/ducks/${"b".repeat(32)}`),
    makeEnv(db),
  );

  assert.deepEqual(await response.json(), { destination: "HOME" });
});

test("public name search returns race status without contact details", async () => {
  const statusRow = {
    event_id: "event_test",
    event_slug: "test-race",
    event_name: "Test Duck Race",
    event_date: "2026-08-30",
    event_status: "ROUND_ONE",
    public_name_policy: "FIRST_NAME_LAST_INITIAL",
    first_name: "Daisy",
    last_name: "Duck",
    registration_status: "ACTIVE",
    race_entry_id: "entry_test",
    visible_number: 42,
    round_one_heat_number: 8,
    round_one_heat_status: "RUNNING",
    round_one_place: null,
    final_heat_number: null,
    final_heat_status: null,
    final_place: null,
  };
  const db = makeDb(
    (sql) => sql.includes("FROM heats") ? null : statusRow,
    () => ({ results: [{ race_entry_id: "entry_test" }] }),
  );
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/race-status/search?eventId=event_test&name=Daisy"),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].participantDisplayName, "Daisy D.");
  assert.equal(body.results[0].outcome, "RUNNING");
  assert.equal("email" in body.results[0], false);
  assert.equal("phone" in body.results[0], false);
  assert.doesNotMatch(db.statements[0].sql, /email|phone|lookup_code/i);
  assert.doesNotMatch(db.statements[0].sql, /LIKE/i);
  assert.deepEqual(db.statements[0].args, ["event_test", "Daisy", "Daisy", "Daisy"]);
});

test("rate limits anonymous name search", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/race-status/search?eventId=event_test&name=Daisy"),
    makeEnv(db, {
      PUBLIC_SEARCH_RATE_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    }),
  );

  assert.equal(response.status, 429);
  assert.equal(db.statements.length, 0);
});

test("name search recovers an unpaired submission without inventory data", async () => {
  const db = makeDb(
    (sql) => sql.includes("FROM heats") ? null : {
      event_id: "event_test",
      event_slug: "test-race",
      event_name: "Test Duck Race",
      event_date: "2026-08-30",
      event_status: "REGISTRATION_OPEN",
      public_name_policy: "FIRST_NAME_LAST_INITIAL",
      first_name: "Daisy",
      last_name: "Duck",
      registration_status: "SUBMITTED",
      race_entry_id: "entry_unpaired",
      visible_number: null,
      round_one_heat_number: null,
      round_one_heat_status: null,
      round_one_place: null,
      final_heat_number: null,
      final_heat_status: null,
      final_place: null,
    },
    () => ({ results: [{ race_entry_id: "entry_unpaired" }] }),
  );
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/race-status/search?eventId=event_test&name=Daisy"),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.results[0].outcome, "AWAITING_DUCK_PAIRING");
  assert.equal(body.results[0].duck, null);
  assert.equal("email" in body.results[0], false);
  assert.equal("phone" in body.results[0], false);
});

test("one browser collection returns multiple independent registrations", async () => {
  const cookieToken = "C".repeat(43);
  const db = makeDb(
    (sql, args) => {
      if (sql.includes("browser_registration_collections")) {
        return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
      }
      if (sql.includes("FROM heats")) return null;
      if (sql.includes("FROM race_entries")) {
        const raceEntryId = args[0];
        return {
          event_id: "event_test",
          event_slug: "test-race",
          event_name: "Test Duck Race",
          event_date: "2026-08-30",
          event_status: "REGISTRATION_OPEN",
          public_name_policy: "FIRST_NAME_LAST_INITIAL",
          first_name: raceEntryId === "entry_one" ? "Daisy" : "Donald",
          last_name: "Duck",
          registration_status: "ACTIVE",
          race_entry_id: raceEntryId,
          visible_number: raceEntryId === "entry_one" ? 42 : 43,
          round_one_heat_number: null,
          round_one_heat_status: null,
          round_one_place: null,
          final_heat_number: null,
          final_heat_status: null,
          final_place: null,
        };
      }
      return null;
    },
    (sql) => sql.includes("browser_collection_registrations") ? {
      results: [
        {
          registration_id: "registration_one",
          race_entry_id: "entry_one",
          first_name: "Daisy",
          last_name: "Duck",
          lookup_code: "DAISY123",
          status: "ACTIVE",
        },
        {
          registration_id: "registration_two",
          race_entry_id: "entry_two",
          first_name: "Donald",
          last_name: "Duck",
          lookup_code: "DONALD45",
          status: "ACTIVE",
        },
      ],
    } : { results: [] },
  );
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations/mine", {
      headers: { cookie: `__Host-quickducks_browser=${cookieToken}` },
    }),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.registrations.length, 2);
  assert.deepEqual(body.registrations.map((item) => item.lookupCode), ["DAISY123", "DONALD45"]);
  assert.equal("email" in body.registrations[0], false);
  assert.equal("phone" in body.registrations[0], false);
  assert.match(db.statements[1].sql, /SET last_seen_at = \?, expires_at = \?/);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
});

test("private registration status still keeps email and phone staff-only", async () => {
  const db = makeDb(() => ({
    first_name: "Daisy",
    last_name: "Duck",
    status: "SUBMITTED",
    lookup_code: "DAISY123",
    submitted_at: "2026-07-26T00:00:00.000Z",
    event_name: "Test Duck Race",
    event_date: "2026-08-30",
    duck_keep_preference: "UNDECIDED",
  }));
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/registrations/${randomToken()}`),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.firstName, "Daisy");
  assert.equal("email" in body, false);
  assert.equal("phone" in body, false);
  assert.doesNotMatch(db.statements[0].sql, /email|phone/i);
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

test("rejects a non-object registration body without throwing", async () => {
  const db = makeDb(() => null);
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: "null",
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request body must be a JSON object." });
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
  assert.equal(db.batches[0].length, 6);
  assert.match(db.batches[0][0].sql, /INSERT INTO race_commands/);
  assert.match(db.batches[0][1].sql, /INSERT INTO registrations/);
  assert.match(db.batches[0][2].sql, /INSERT INTO race_entries/);
  assert.match(db.batches[0][3].sql, /INSERT INTO audit_events/);
  assert.match(db.batches[0][4].sql, /INSERT INTO browser_registration_collections/);
  assert.match(db.batches[0][5].sql, /INSERT OR IGNORE INTO browser_collection_registrations/);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
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
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
});
