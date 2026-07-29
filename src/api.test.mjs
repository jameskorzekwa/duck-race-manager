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
  public_name_policy: "FIRST_NAME_LAST_INITIAL",
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

const staffActor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR"],
  authentication: "bearer",
};

test("routes authenticated staff operation modules before the legacy fallback", async () => {
  const event = {
    id: "event_test",
    slug: "test-race",
    name: "Test Duck Race",
    event_date: "2026-08-30",
    timezone: "America/Denver",
    status: "DRAFT",
    registration_opens_at: null,
    registration_closes_at: null,
    email_required: 0,
    heat_assignment_mode: "POST_CLOSE_BALANCED",
    round_one_heat_capacity: 10,
    final_heat_capacity: 10,
    public_name_policy: "FIRST_NAME_LAST_INITIAL",
    revision: 0,
    created_at: "2026-07-26T00:00:00Z",
    updated_at: "2026-07-26T00:00:00Z",
  };
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/events"),
    makeEnv(makeDb(() => null, () => ({ results: [event] }))),
    async () => staffActor,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).events[0].id, event.id);
});

// The legacy fallback still owns real routes (registration search, scan-first
// pairing). Return review is not one of them any more, so the composed router
// must answer 404 rather than reaching a handler.
test("keeps legacy staff routes behind the composed operation router", async () => {
  const search = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/registrations/search?eventId=event_test&q=daisy"),
    makeEnv(makeDb(() => null)),
    async () => staffActor,
  );
  assert.equal(search.status, 200);

  const retired = await handleApi(
    new Request("https://quickducks.com/api/v1/staff/events/return-review"),
    makeEnv(makeDb(() => null)),
    async () => staffActor,
  );
  assert.equal(retired.status, 404);
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
    publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
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
  assert.equal("lookupCode" in body.results[0], false);
  assert.equal("privateStatusPath" in body.results[0], false);
  assert.equal("emailNotificationsEnabled" in body.results[0], false);
  assert.equal("smsNotificationsEnabled" in body.results[0], false);
  assert.equal("ownershipProof" in body.results[0], false);
  assert.doesNotMatch(db.statements[0].sql, /email|phone|lookup_code/i);
  assert.doesNotMatch(db.statements[0].sql, /LIKE/i);
  // An anonymous search binds an unmatchable collection id, so every result is
  // reported as not yet collected without touching the cookie.
  assert.deepEqual(db.statements[0].args, ["", "event_test", "Daisy", "Daisy", "Daisy"]);
  assert.equal(body.results[0].inMyDucks, false);
  assert.equal(body.results[0].followId, "entry_test");
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
          registration_status: raceEntryId === "entry_one" ? "ACTIVE" : "SUBMITTED",
          race_entry_id: raceEntryId,
          visible_number: raceEntryId === "entry_one" ? 42 : null,
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
          is_paired: 1,
        },
        {
          registration_id: "registration_two",
          race_entry_id: "entry_two",
          first_name: "Donald",
          last_name: "Duck",
          lookup_code: "DONALD45",
          status: "SUBMITTED",
          is_paired: 0,
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
  assert.deepEqual(body.registrations.map((item) => item.paired), [true, false]);
  assert.equal(body.registrations[0].raceStatus.duck.visibleNumber, 42);
  assert.equal(body.registrations[1].raceStatus.duck, null);
  assert.equal("email" in body.registrations[0], false);
  assert.equal("phone" in body.registrations[0], false);
  assert.equal("privateStatusPath" in body.registrations[0], false);
  assert.match(body.registrations[0].ownershipProof, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(body.registrations[0].ownershipProof, body.registrations[1].ownershipProof);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(db.statements[1].sql, /SET last_seen_at = \?, expires_at = \?/);
  assert.match(db.statements[2].sql, /FROM duck_assignments da/);
  assert.doesNotMatch(db.statements[2].sql, /email|phone|private_token/i);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
});

test("a followed collection entry is projected without a lookup code or unmasked name", async () => {
  const cookieToken = "C".repeat(43);
  const db = makeDb(
    (sql, args) => {
      if (sql.includes("browser_registration_collections")) {
        return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
      }
      if (sql.includes("FROM heats")) return null;
      if (sql.includes("FROM race_entries")) {
        return {
          event_id: "event_test",
          event_slug: "test-race",
          event_name: "Test Duck Race",
          event_date: "2026-08-30",
          event_status: "REGISTRATION_OPEN",
          public_name_policy: "FIRST_NAME_LAST_INITIAL",
          first_name: args[0] === "entry_owned" ? "Daisy" : "Donald",
          last_name: args[0] === "entry_owned" ? "Duck" : "Mallard",
          registration_status: "SUBMITTED",
          race_entry_id: args[0],
          visible_number: null,
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
          registration_id: "registration_owned",
          race_entry_id: "entry_owned",
          first_name: "Daisy",
          last_name: "Duck",
          // Both codes must be encodable, or every row would get `qr: null` for
          // the wrong reason and the followed guard below could not fail.
          lookup_code: "DAASY234",
          status: "SUBMITTED",
          added_via: "REGISTRATION",
          public_name_policy: "FIRST_NAME_LAST_INITIAL",
          is_paired: 0,
        },
        {
          registration_id: "registration_followed",
          race_entry_id: "entry_followed",
          first_name: "Donald",
          last_name: "Mallard",
          lookup_code: "DUNALD45",
          status: "SUBMITTED",
          added_via: "FOLLOWED",
          public_name_policy: "FIRST_NAME_LAST_INITIAL",
          is_paired: 0,
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

  const [owned, followed] = body.registrations;
  assert.equal(owned.followed, false);
  assert.equal(owned.lookupCode, "DAASY234");
  assert.equal(owned.displayName, "Daisy Duck");
  assert.equal(followed.followed, true);
  assert.equal(followed.lookupCode, null);
  assert.equal(followed.firstName, null);
  assert.equal(followed.lastName, null);
  assert.match(owned.ownershipProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal("ownershipProof" in followed, false);
  // A QR is an encoding of the lookup code, so withholding the code but
  // sending its QR would hand back exactly what the projection just refused.
  // Asserting the owned side too keeps this pair failing for the right reason:
  // without it, dropping the followed guard would still pass.
  assert.equal(followed.qr, null, "a followed entry has no code to encode");
  assert.equal(owned.qr.size, 29);
  assert.match(owned.qr.path, /^[Mhvz0-9 -]+$/);
  // Following must never widen the name past the public search projection.
  assert.equal(followed.displayName, "Donald M.");
  assert.equal(JSON.stringify(body).includes("DUNALD45"), false);
  assert.equal(JSON.stringify(body).includes("Mallard"), false);
  assert.match(db.statements[2].sql, /bcr\.added_via, e\.public_name_policy/);
  assert.doesNotMatch(db.statements[2].sql, /email|phone|private_token/i);
});

test("name search marks results already saved in this browser's collection", async () => {
  const cookieToken = "C".repeat(43);
  const db = makeDb(
    (sql) => {
      if (sql.includes("FROM browser_registration_collections")) {
        return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
      }
      if (sql.includes("FROM heats")) return null;
      return {
        event_id: "event_test",
        event_slug: "test-race",
        event_name: "Test Duck Race",
        event_date: "2026-08-30",
        event_status: "REGISTRATION_OPEN",
        public_name_policy: "FIRST_NAME_LAST_INITIAL",
        first_name: "Daisy",
        last_name: "Duck",
        registration_status: "SUBMITTED",
        race_entry_id: "entry_test",
        visible_number: null,
        round_one_heat_number: null,
        round_one_heat_status: null,
        round_one_place: null,
        final_heat_number: null,
        final_heat_status: null,
        final_place: null,
      };
    },
    () => ({ results: [{ race_entry_id: "entry_test", in_collection: 1 }] }),
  );
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/race-status/search?eventId=event_test&name=Daisy", {
      headers: { cookie: `__Host-quickducks_browser=${cookieToken}` },
    }),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.results[0].inMyDucks, true);
  assert.equal(body.results[0].followId, "entry_test");
  assert.equal("lookupCode" in body.results[0], false);
  // Search stays read-only: it never refreshes or reissues the collection cookie.
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(db.statements[1].args[0], "collection_test");
  assert.equal(db.statements.some((statement) => /UPDATE browser_registration_collections/.test(statement.sql)), false);
});

const followRequest = (body, headers = {}) => new Request(
  "https://quickducks.com/api/v1/registrations/mine/follow",
  {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quickducks.com", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  },
);

test("follow validates transport and identifier shape before touching the database", async () => {
  const followId = "11111111-1111-4111-8111-111111111111";
  const rejected = [
    [415, followRequest({ followId }, { "content-type": "text/plain" })],
    [403, followRequest({ followId }, { origin: "https://evil.example" })],
    [413, followRequest({ followId }, { "content-length": "9999" })],
    [400, followRequest("not-json")],
    [400, followRequest([followId])],
    [400, followRequest({ followId: "registration-one" })],
    [400, followRequest({ followId: 42 })],
    [400, followRequest({})],
  ];

  for (const [status, request] of rejected) {
    const db = makeDb(() => assert.fail("invalid follow requests must not query D1"));
    const response = await handleApi(request, makeEnv(db));
    assert.equal(response.status, status, await response.text());
    assert.equal(db.statements.length, 0);
    assert.equal(db.batches.length, 0);
  }

  // A request without any Origin header is rejected too, because the browser
  // collection cookie is the only credential this mutation has.
  const anonymousDb = makeDb(() => assert.fail("origin-less follow must not query D1"));
  const anonymous = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations/mine/follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ followId }),
    }),
    makeEnv(anonymousDb),
  );
  assert.equal(anonymous.status, 403);
  assert.equal(anonymousDb.statements.length, 0);
});

test("follow rate limits before reading the event or race entry", async () => {
  const db = makeDb(() => assert.fail("rate-limited follow must not query D1"));
  const response = await handleApi(
    followRequest({ followId: "11111111-1111-4111-8111-111111111111" }),
    makeEnv(db, {
      PUBLIC_SEARCH_RATE_LIMITER: {
        async limit({ key }) {
          assert.match(key, /^follow:/);
          return { success: false };
        },
      },
    }),
  );

  assert.equal(response.status, 429);
  assert.equal(db.statements.length, 0);
});

test("follow adds a searchable public entry as a FOLLOWED collection link", async () => {
  const followId = "11111111-1111-4111-8111-111111111111";
  const db = makeDb((sql) => {
    if (sql.includes("FROM events")) return openEvent;
    if (sql.includes("FROM race_entries re")) return { registration_id: "registration_followed" };
    return null;
  });
  const response = await handleApi(followRequest({ followId }), makeEnv(db));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { followed: true, alreadyInCollection: false });
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const lookup = db.statements.find((statement) => statement.sql.includes("FROM race_entries re"));
  // The identifier is only accepted when it still resolves to a publicly
  // searchable entry of the current public event.
  assert.match(lookup.sql, /r\.status IN \('SUBMITTED', 'ACTIVE'\)/);
  assert.match(lookup.sql, /e\.status IN \('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED'\)/);
  assert.deepEqual(lookup.args, [followId, openEvent.id]);
  assert.doesNotMatch(lookup.sql, /lookup_code|private_token|email|phone/i);

  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.match(db.batches[0][0].sql, /INSERT INTO browser_registration_collections/);
  assert.match(db.batches[0][1].sql, /INSERT OR IGNORE INTO browser_collection_registrations/);
  assert.match(db.batches[0][1].sql, /VALUES \(\?, \?, \?, 'FOLLOWED'\)/);
  assert.equal(db.batches[0][1].args[1], "registration_followed");
});

test("follow rejects an identifier that is not publicly searchable", async () => {
  const noEvent = makeDb(() => null);
  const missingEvent = await handleApi(
    followRequest({ followId: "11111111-1111-4111-8111-111111111111" }),
    makeEnv(noEvent),
  );
  assert.equal(missingEvent.status, 404);
  assert.equal(noEvent.batches.length, 0);

  const noEntry = makeDb((sql) => sql.includes("FROM events") ? openEvent : null);
  const missingEntry = await handleApi(
    followRequest({ followId: "11111111-1111-4111-8111-111111111111" }),
    makeEnv(noEntry),
  );
  assert.equal(missingEntry.status, 404);
  assert.equal(noEntry.batches.length, 0);
  assert.equal((await missingEntry.json()).error, "That participant cannot be added.");
});

test("follow is idempotent for an entry already in the collection", async () => {
  const cookieToken = "C".repeat(43);
  const db = makeDb((sql) => {
    if (sql.includes("FROM browser_registration_collections")) {
      return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
    }
    if (sql.includes("FROM events")) return openEvent;
    if (sql.includes("FROM race_entries re")) return { registration_id: "registration_followed" };
    if (sql.includes("SELECT 1 AS present")) return { present: 1 };
    return null;
  });
  const response = await handleApi(
    followRequest(
      { followId: "11111111-1111-4111-8111-111111111111" },
      { cookie: `__Host-quickducks_browser=${cookieToken}` },
    ),
    makeEnv(db),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { followed: true, alreadyInCollection: true });
  assert.match(db.batches[0][0].sql, /UPDATE browser_registration_collections/);
  assert.match(db.batches[0][1].sql, /INSERT OR IGNORE INTO browser_collection_registrations/);
});

test("browser collection presence probe refreshes the cookie without selecting private records", async () => {
  const cookieToken = "C".repeat(43);
  const db = makeDb((sql) => {
    if (sql.includes("FROM browser_registration_collections")) {
      return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
    }
    if (sql.includes("SELECT 1 AS has_registration")) return { has_registration: 1 };
    return null;
  });
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations/mine/presence", {
      headers: { cookie: `__Host-quickducks_browser=${cookieToken}` },
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hasRegistrations: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
  assert.match(db.statements[1].sql, /SET last_seen_at = \?, expires_at = \?/);
  assert.match(db.statements[2].sql, /SELECT 1 AS has_registration/);
  assert.match(db.statements[2].sql, /LIMIT 1/);
  assert.doesNotMatch(db.statements[2].sql, /JOIN|first_name|last_name|lookup_code|email|phone|private_token|race_entry/i);
  assert.equal(db.statements.some((statement) => statement.sql.includes("FROM race_entries")), false);
});

test("browser collection presence probe clears an invalid cookie without querying registration data", async () => {
  const db = makeDb(() => assert.fail("invalid collection cookie must not query D1"));
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations/mine/presence", {
      headers: { cookie: "__Host-quickducks_browser=invalid" },
    }),
    makeEnv(db),
  );

  assert.deepEqual(await response.json(), { hasRegistrations: false });
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(db.statements.length, 0);
});

test("private registration status still keeps email and phone staff-only", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM registrations r")) {
      return {
        first_name: "Daisy",
        last_name: "Duck",
        status: "ACTIVE",
        lookup_code: "DAISY123",
        submitted_at: "2026-07-26T00:00:00.000Z",
        event_name: "Test Duck Race",
        event_date: "2026-08-30",
        race_entry_id: "entry_test",
        duck_keep_preference: "KEEP",
      };
    }
    if (sql.includes("FROM heats")) {
      return { round: "ROUND_ONE", heat_number: 4, status: "RUNNING" };
    }
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
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/registrations/${randomToken()}`),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(body.firstName, "Daisy");
  assert.equal(body.lastName, "Duck");
  assert.equal(body.lookupCode, "DAISY123");
  assert.equal("duckKeepPreference" in body, false);
  assert.deepEqual(body.raceStatus.duck, { visibleNumber: 42 });
  assert.equal(body.raceStatus.assignedHeat.roundOne.number, 8);
  assert.deepEqual(body.raceStatus.currentHeat, { round: "ROUND_ONE", number: 4, status: "RUNNING" });
  assert.equal(body.raceStatus.outcome, "NOT_RACED");
  assert.equal("email" in body, false);
  assert.equal("phone" in body, false);
  assert.equal("emailNotificationsEnabled" in body, false);
  assert.equal("smsNotificationsEnabled" in body, false);
  assert.equal("ownershipProof" in body, false);
  assert.ok(db.statements.every((statement) => !/email|phone/i.test(statement.sql)));
  assert.ok(db.statements.every((statement) => !statement.sql.includes("duck_keep_preference")));
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
  let publicationCalls = 0;
  let publicationTask;
  let publicationFrame;
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const privateToken = randomToken();
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/registrations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://quickducks.com",
      },
      body: JSON.stringify({
        eventId: openEvent.id,
        commandId: crypto.randomUUID(),
        privateToken,
        firstName: "Daisy",
        lastName: "Duck",
        email: "DAISY@example.com",
        emailNotificationsEnabled: true,
        duckKeepPreference: "KEEP",
        turnstileToken: "verified-test-token",
      }),
    }),
    makeEnv(db, {
      TURNSTILE_SECRET_KEY: "test-secret",
      RACE_UPDATES: {
        idFromName() { return "race-updates"; },
        get() {
          return {
            async fetch(_url, init) {
              publicationCalls += 1;
              publicationFrame = init.body;
              throw new Error("notification unavailable");
            },
          };
        },
      },
    }),
    undefined,
    { waitUntil(promise) { publicationTask = promise; } },
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
  assert.doesNotMatch(db.batches[0][2].sql, /duck_keep_preference/);
  assert.equal(db.batches[0][2].args.length, 3);
  assert.match(db.batches[0][3].sql, /INSERT INTO audit_events/);
  assert.equal(db.batches[0][3].args.at(-1), JSON.stringify({ created_via: "PUBLIC" }));
  assert.match(db.batches[0][4].sql, /INSERT INTO browser_registration_collections/);
  // Registering in this browser always claims the link as REGISTRATION, so an
  // earlier followed link can never keep hiding this browser's own lookup code.
  assert.match(db.batches[0][5].sql, /INSERT INTO browser_collection_registrations/);
  assert.match(db.batches[0][5].sql, /VALUES \(\?, \?, \?, 'REGISTRATION'\)/);
  assert.match(db.batches[0][5].sql, /DO UPDATE SET added_via = 'REGISTRATION'/);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-quickducks_browser=/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.ok(publicationTask);
  await assert.doesNotReject(publicationTask);
  assert.equal(publicationCalls, 1);
  assert.deepEqual(JSON.parse(publicationFrame).domains, ["participants"]);
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
        lookup_code: "DCKS2345",
        private_token_hash: privateTokenHash,
        first_name: "Daisy",
        last_name: "Duck",
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

const publicEventRow = {
  id: "event_test",
  name: "Test Duck Race",
  event_date: "2026-08-30",
  status: "ROUND_ONE",
  public_name_policy: "FIRST_NAME_LAST_INITIAL",
};

// The row deliberately carries private columns the projection never selects, so
// the assertions prove the response is a projection rather than a row dump.
const duckNumberRow = {
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
  visible_number: 128,
  duck_name: "Sir Quacks-a-Lot",
  round_one_heat_number: 7,
  round_one_heat_status: "FINALIZED",
  round_one_place: 1,
  final_heat_number: null,
  final_heat_status: null,
  final_place: null,
  email: "daisy@example.com",
  phone: "555-0100",
  lookup_code: "DUCK8234",
  private_token_hash: "hash-value",
  email_notifications_enabled: 1,
  sms_notifications_enabled: 1,
  ownership_proof: "proof-value",
  tag_token: "tag-token-value",
  inventory_location: "Shed B",
  staff_notes: "Ask about the cracked bill.",
};

const duckNumberDb = ({ event = publicEventRow, row = duckNumberRow, heat = null } = {}) => makeDb((sql) => {
  if (sql.includes("FROM race_entries")) return row;
  if (sql.includes("FROM heats")) return heat;
  if (sql.includes("FROM events")) return event;
  return null;
});

const collectStrings = (value, keys = [], values = []) => {
  if (typeof value === "string") values.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, keys, values);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collectStrings(item, keys, values);
    }
  }
  return { keys, values };
};

test("resolves a public duck number to the shared public projection only", async () => {
  const db = duckNumberDb({ heat: { round: "ROUND_ONE", heat_number: 5, status: "RUNNING" } });
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/ducks/number/128"),
    makeEnv(db),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    raceStatus: {
      event: {
        id: "event_test",
        slug: "test-race",
        name: "Test Duck Race",
        eventDate: "2026-08-30",
        status: "ROUND_ONE",
      },
      participantDisplayName: "Daisy D.",
      duck: { visibleNumber: 128 },
      // The participant-chosen name is public, and it always travels beside the
      // canonical duck number rather than replacing it.
      duckName: "Sir Quacks-a-Lot",
      assignedHeat: {
        roundOne: { number: 7, status: "FINALIZED" },
        final: null,
      },
      currentHeat: { round: "ROUND_ONE", number: 5, status: "RUNNING" },
      outcome: "ROUND_ONE_WINNER",
      // The follow signals ride on the same object the public name search
      // already puts them on, and carry nothing else.
      followId: "entry_test",
      inMyDucks: false,
    },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the public duck number projection exposes no contact, code, token, or staff data", async () => {
  const response = await handleApi(
    new Request("https://quickducks.com/api/v1/ducks/number/128"),
    makeEnv(duckNumberDb()),
  );
  const serialized = await response.text();
  const { keys, values } = collectStrings(JSON.parse(serialized));

  for (const forbidden of [
    "email", "phone", "lookupCode", "lookup_code", "privateToken", "privateTokenHash",
    "private_token_hash", "token", "tagToken", "tag_token", "privateStatusPath",
    "emailNotificationsEnabled", "smsNotificationsEnabled", "ownershipProof", "ownership_proof",
    "inventoryLocation", "inventory_location", "notes", "staffNotes", "staff_notes",
    "auditEvents", "firstName", "lastName", "registrationId", "duck_name",
  ]) {
    assert.equal(keys.includes(forbidden), false, `key ${forbidden} must not be projected`);
  }
  // The duck name is now deliberately public, mapped to camelCase like every
  // other projected field, and it never replaces the duck number.
  assert.equal(keys.includes("duckName"), true);
  assert.equal(values.includes("Sir Quacks-a-Lot"), true);
  // `followId` is the one added identifier, and it is the same inert race entry
  // identifier the public name search already returns for the same entries. It
  // unlocks nothing but the follow endpoint, which revalidates it.
  assert.deepEqual(
    keys.filter((key) => key === "followId" || key === "inMyDucks").sort(),
    ["followId", "inMyDucks"],
  );
  for (const forbidden of [
    "daisy@example.com", "555-0100", "DUCK8234", "hash-value", "proof-value",
    "tag-token-value", "Shed B", "Ask about the cracked bill.",
  ]) {
    assert.equal(values.includes(forbidden), false, `value ${forbidden} must not be projected`);
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not appear in the response body`);
  }
  // The policy display name is the only participant identity that ships.
  assert.equal(values.includes("Daisy D."), true);
  assert.equal(serialized.includes("Duck"), true);
  assert.equal(/"last_?[Nn]ame"/.test(serialized), false);
});

test("the public duck number lookup is bound and scoped to the current public event", async () => {
  const db = duckNumberDb();
  await handleApi(new Request("https://quickducks.com/api/v1/ducks/number/128"), makeEnv(db));

  const eventStatement = db.statements.find((statement) => statement.sql.includes("FROM events"));
  const statusStatement = db.statements.find((statement) => statement.sql.includes("FROM race_entries"));

  // The event selection is the same one the public board renders.
  assert.match(eventStatement.sql, /status IN \('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED'\)/);
  assert.doesNotMatch(eventStatement.sql, /DRAFT|RETURN_PROCESSING|ARCHIVED/);

  // Every external value is bound, and the row is pinned to that event.
  assert.deepEqual(statusStatement.args, ["event_test", 128]);
  assert.match(statusStatement.sql, /WHERE re\.event_id = \?/);
  assert.match(statusStatement.sql, /AND d\.visible_number = \?/);
  assert.match(statusStatement.sql, /e\.status IN \('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED'\)/);
  assert.equal(statusStatement.sql.includes("128"), false);
  // The projection is the shared one: no private column is ever selected.
  assert.doesNotMatch(statusStatement.sql, /r\.email|r\.phone|lookup_code|private_token_hash|dt\.token/);
});

// Every public selection lists its statuses explicitly. With the lifecycle down
// to six statuses, the public allow-list is the five post-draft ones and the
// retired names must not appear in any public query.
//
// Registration statuses are swept in the same pass and held to their own
// allow-list: a public surface may only ever show a participant who is still
// racing, so `SUBMITTED` and `ACTIVE` are the complete set and a public query
// that silently readmits `WITHDRAWN` or `DISQUALIFIED` fails here.
test("public event, status, and board selections allow exactly the five public statuses", async () => {
  const publicStatuses = "'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED'";
  const racingStatuses = "'SUBMITTED', 'ACTIVE'";
  const collected = [];
  // Each public entry point is swept on its own so dropping COMPLETED from any
  // single one of them fails here instead of hiding behind the others.
  const sweep = async (label, request, db) => {
    await handleApi(request, makeEnv(db));
    const swept = db.statements.map((statement) => statement.sql);
    collected.push(...swept);
    const selections = swept.filter((sql) => /FROM events|JOIN events/.test(sql) && /status IN \(/.test(sql));
    assert.ok(selections.length > 0, `${label} must pin an explicit public status allow-list`);
    for (const sql of selections) {
      for (const [, qualifier, group] of sql.matchAll(/(?:(\w+)\.)?status IN \(([^)]*)\)/gs)) {
        const list = group.replace(/\s+/g, " ").trim();
        const registrationStatus = qualifier === "r" || qualifier === "followed";
        assert.equal(
          list,
          registrationStatus ? racingStatuses : publicStatuses,
          `${label}: ${sql}`,
        );
      }
    }
    return selections.length;
  };

  let eventSelections = 0;
  eventSelections += await sweep(
    "current event",
    new Request("https://quickducks.com/api/v1/events/current"),
    makeDb(() => openEvent),
  );
  eventSelections += await sweep(
    "duck number lookup",
    new Request("https://quickducks.com/api/v1/ducks/number/128"),
    duckNumberDb(),
  );
  eventSelections += await sweep(
    "tag scan",
    new Request(`https://quickducks.com/api/v1/ducks/${"a".repeat(32)}`),
    duckNumberDb(),
  );
  eventSelections += await sweep(
    "public race board",
    new Request("https://quickducks.com/api/v1/race-board"),
    makeDb((sql) => sql.includes("FROM events") ? publicEventRow : null),
  );
  eventSelections += await sweep(
    "my registrations",
    new Request("https://quickducks.com/api/v1/registrations/mine", {
      headers: { cookie: `__Host-quickducks_browser=${"C".repeat(43)}` },
    }),
    makeDb(
      (sql) => {
        if (sql.includes("browser_registration_collections")) {
          return { id: "collection_test", expires_at: "2099-01-01T00:00:00.000Z" };
        }
        if (sql.includes("FROM heats")) return null;
        if (sql.includes("FROM race_entries")) return duckNumberRow;
        return null;
      },
      (sql) => sql.includes("browser_collection_registrations") ? {
        results: [{
          registration_id: "registration_one",
          race_entry_id: "entry_one",
          first_name: "Daisy",
          last_name: "Duck",
          lookup_code: "DAISY123",
          status: "ACTIVE",
          added_via: "REGISTRATION",
          public_name_policy: "FIRST_NAME_LAST_INITIAL",
          is_paired: 1,
        }],
      } : { results: [] },
    ),
  );
  assert.ok(eventSelections >= 5, "every public path pins an explicit status allow-list");
  // COMPLETED stays publicly visible; the retired statuses are gone entirely.
  for (const sql of collected) {
    assert.doesNotMatch(sql, /RETURN_PROCESSING|ARCHIVED/, sql);
  }
});

test("unknown, unpaired, and out-of-event duck numbers are indistinguishable 404s", async () => {
  const cases = [
    ["unpaired or unknown number", duckNumberDb({ row: null })],
    ["no current public event", duckNumberDb({ event: null })],
  ];

  for (const [label, db] of cases) {
    const response = await handleApi(
      new Request("https://quickducks.com/api/v1/ducks/number/9999"),
      makeEnv(db),
    );
    assert.equal(response.status, 404, label);
    assert.deepEqual(await response.json(), { error: "Not found." }, label);
  }
});

test("non-canonical duck numbers never reach the database", async () => {
  for (const value of ["0", "012", "1234567890", "00"]) {
    const db = duckNumberDb();
    const response = await handleApi(
      new Request(`https://quickducks.com/api/v1/ducks/number/${value}`),
      makeEnv(db),
    );

    assert.equal(response.status, 404, value);
    assert.equal(db.statements.length, 0, `${value} must not query D1`);
  }
});

test("the duck number endpoint never intercepts the tag scan route", async () => {
  const token = "b".repeat(32);
  const db = makeDb((sql) => {
    if (sql.includes("FROM heats")) return null;
    if (sql.includes("duck_tags")) return { ...duckNumberRow, visible_number: 77 };
    return null;
  });
  const response = await handleApi(
    new Request(`https://quickducks.com/api/v1/ducks/${token}`),
    makeEnv(db),
  );
  const body = await response.json();

  // The tag route keeps its own shape, its own token predicate, and its own
  // anonymous "HOME" fallback.
  assert.equal(body.destination, "RACE_STATUS");
  assert.equal(body.raceStatus.duck.visibleNumber, 77);
  assert.match(db.statements[0].sql, /JOIN duck_tags dt ON dt\.duck_id = d\.id/);
  assert.deepEqual(db.statements[0].args, [token]);

  const short = await handleApi(
    new Request("https://quickducks.com/api/v1/ducks/128"),
    makeEnv(makeDb(() => null)),
  );
  assert.deepEqual(await short.json(), { destination: "HOME" });
});
