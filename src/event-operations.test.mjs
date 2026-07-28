import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { eventSlugFromName, handleEventOperations, normalizedTimezone } from "./event-operations.ts";

const staff = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["RACE_DIRECTOR"],
  authentication: "bearer",
};
const admin = { ...staff, id: "admin_test", isSystemAdmin: true, roles: [] };

const draftEvent = {
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
  final_heat_capacity: 50,
  public_name_policy: "FIRST_NAME_LAST_INITIAL",
  revision: 0,
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:00.000Z",
};

const readyStats = {
  submitted_registration_count: 0,
  active_entry_count: 4,
  active_entry_without_duck_count: 0,
  active_entry_without_round_one_heat_count: 0,
  pending_provisioning_count: 0,
  round_one_heat_count: 2,
  round_one_unready_heat_count: 0,
  round_one_unfinished_heat_count: 0,
  round_one_finalized_heat_count: 2,
  round_one_missing_result_count: 0,
  final_heat_count: 1,
  final_entry_count: 2,
  final_unready_heat_count: 0,
  final_unfinished_heat_count: 0,
  final_finalized_heat_count: 1,
  final_missing_result_count: 0,
  any_heat_count: 2,
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

const sqliteD1 = (database, beforeBatch = () => {}) => ({
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
    beforeBatch();
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

const jsonRequest = (path, method, body) => new Request(`https://quickducks.com${path}`, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("generates bounded ASCII URL-safe event slugs from names", () => {
  assert.equal(eventSlugFromName("  Crème   Brûlée / Duck---Race!  "), "creme-brulee-duck-race");
  assert.equal(eventSlugFromName("A...B -- C"), "a-b-c");

  const fallback = eventSlugFromName("東京 🦆");
  assert.equal(fallback, "event-o05wec");
  assert.match(fallback, /^event-[a-z0-9]+$/);
  assert.ok(fallback.length <= 80);

  const bounded = eventSlugFromName("Long event name ".repeat(20));
  assert.ok(bounded.length <= 80);
  assert.match(bounded, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("timezone validation accepts IANA identifiers the runtime resolves and rejects the rest", () => {
  // Every zone the browser can offer must be accepted by the server.
  for (const zone of [...Intl.supportedValuesOf("timeZone"), "UTC"]) {
    assert.equal(normalizedTimezone(zone), zone, `${zone} must be accepted`);
  }
  // Legacy links are not in that list but are stored on existing events.
  for (const zone of ["US/Mountain", "Asia/Calcutta", "GMT", "EST5EDT", "Etc/GMT+5"]) {
    assert.equal(normalizedTimezone(zone), zone);
  }
  // Surrounding whitespace is trimmed, and the identifier is stored verbatim.
  assert.equal(normalizedTimezone("  America/Denver  "), "America/Denver");
  assert.equal(normalizedTimezone("America/Denver\n"), "America/Denver");

  // Well-shaped but non-existent zones, offsets, junk, and non-strings fail.
  for (const value of [
    "Foo/Bar",
    "Mars/Olympus_Mons",
    "notazone",
    "America/Denver extra",
    "America//Denver",
    "America/Denver/",
    "/America/Denver",
    "America/North/Dakota/Beulah",
    "+05:00",
    "-07:00",
    "Z",
    "",
    "   ",
    "A".repeat(65),
    "<script>",
    "'; DROP TABLE events;--",
    "../../etc/passwd",
    "America/De nver",
    "America\nDenver",
    42,
    null,
    undefined,
    true,
    {},
    ["UTC"],
  ]) {
    assert.equal(normalizedTimezone(value), null, `${JSON.stringify(value)} must be rejected`);
  }

  // Accepted values always satisfy the organization-defaults length constraint.
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    assert.ok(zone.trim().length >= 1 && zone.trim().length <= 64);
  }
});

test("returns null for unrelated routes so a shared router can continue", async () => {
  const db = makeDb(() => null);
  const response = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/ducks/example"),
    makeEnv(db),
    staff,
  );

  assert.equal(response, null);
  assert.equal(db.statements.length, 0);
});

test("lists events and returns configuration plus operational summary in detail", async () => {
  const db = makeDb(
    (sql) => {
      if (sql.includes("AS registration_count")) {
        return { registration_count: 12, event_duck_count: 10, round_one_heat_count: 2, final_heat_count: 1 };
      }
      return draftEvent;
    },
    () => ({ results: [draftEvent] }),
  );
  const list = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events"),
    makeEnv(db),
    staff,
  );
  const detail = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test"),
    makeEnv(db),
    staff,
  );

  assert.equal((await list.json()).events[0].revision, 0);
  assert.deepEqual((await detail.json()).summary, {
    registrations: 12,
    eventDucks: 10,
    roundOneHeats: 2,
    finalHeats: 1,
  });
});

test("only an administrator can create an event", async () => {
  const db = makeDb(() => null);
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId: crypto.randomUUID(),
      slug: "test-race",
      name: "Test Duck Race",
      eventDate: "2026-08-30",
    }),
    makeEnv(db),
    staff,
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("an administrator creates one immediate-mode draft with a required ducks-per-heat size", async () => {
  const defaults = {
    timezone: "America/Denver",
    email_required: 1,
    heat_assignment_mode: "POST_CLOSE_BALANCED",
    round_one_heat_capacity: 8,
    final_heat_capacity: 16,
    public_name_policy: "FIRST_NAME_ONLY",
  };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql === "SELECT id FROM events LIMIT 1") return null;
    if (sql.includes("FROM organization_event_defaults")) return defaults;
    return null;
  });
  const commandId = crypto.randomUUID();
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId,
      slug: "../../CLIENT-CONTROLLED",
      name: "Ànnual Duck Race!!!",
      eventDate: "2026-09-01",
      roundOneHeatCapacity: 6,
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.event.status, "DRAFT");
  assert.equal(body.event.slug, "annual-duck-race");
  assert.equal(body.event.timezone, defaults.timezone);
  assert.equal(body.event.emailRequired, true);
  assert.equal(body.event.heatAssignmentMode, "IMMEDIATE_FIXED");
  assert.equal(body.event.roundOneHeatCapacity, 6);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /FROM organization_event_defaults/);
  assert.match(sql, /'IMMEDIATE_FIXED'/);
  assert.match(sql, /'CREATE_EVENT'/);
  assert.match(sql, /'EVENT_CREATED'/);
  assert.equal(sql.includes("Annual Duck Race"), false);
  assert.ok(db.batches[0].every((statement) => statement.args.length > 0));
  assert.equal(db.batches[0][0].args[1], "annual-duck-race");
  // An omitted timezone binds null so COALESCE keeps the retained default.
  assert.match(sql, /COALESCE\(\?, d\.timezone\)/);
  assert.equal(db.batches[0][0].args[4], null);
  assert.equal(db.batches[0][0].args[5], 6);
});

test("event creation validates the ducks-per-heat bounds before touching the database", async () => {
  // A heat is only a race with at least three ducks, so 1 and 2 join the
  // already-rejected shapes below.
  for (const roundOneHeatCapacity of [undefined, null, 0, -3, 1, 2, 2.5, 10_001, "8"]) {
    const db = makeDb(() => null);
    const response = await handleEventOperations(
      jsonRequest("/api/v1/staff/events", "POST", {
        commandId: crypto.randomUUID(),
        name: "Bounded Race",
        eventDate: "2026-09-01",
        roundOneHeatCapacity,
      }),
      makeEnv(db),
      admin,
    );

    assert.equal(response.status, 400, `capacity ${String(roundOneHeatCapacity)} must be rejected`);
    assert.match((await response.json()).error, /ducks per heat/i);
    assert.equal(db.statements.length, 0);
    assert.equal(db.batches.length, 0);
  }
});

test("draft configuration enforces the minimum heat size and rejects the retired heat mode", async () => {
  const configured = { ...draftEvent, heat_assignment_mode: "IMMEDIATE_FIXED" };
  const attempt = async (patch) => {
    const db = makeDb((sql) => (sql.includes("FROM race_commands") ? null : configured));
    const response = await handleEventOperations(
      jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
        commandId: crypto.randomUUID(),
        revision: 0,
        ...patch,
      }),
      makeEnv(db),
      admin,
    );
    return { response, body: await response.json(), db };
  };

  for (const roundOneHeatCapacity of [0, 1, 2, -1, 2.5, 10_001, "5"]) {
    const { response, body, db } = await attempt({ roundOneHeatCapacity });
    assert.equal(response.status, 400, `capacity ${String(roundOneHeatCapacity)} must be rejected`);
    assert.equal(body.error, "roundOneHeatCapacity must be an integer between 3 and 10000.");
    assert.equal(db.batches.length, 0, "a rejected capacity never reaches the database");
  }

  // The exact minimum is accepted, and the final capacity keeps its own floor
  // of one because it counts round-one heats rather than ducks in a heat.
  const accepted = await attempt({ roundOneHeatCapacity: 3 });
  assert.equal(accepted.response.status, 200);
  const finalFloor = await attempt({ finalHeatCapacity: 0 });
  assert.equal(finalFloor.response.status, 400);
  assert.equal(finalFloor.body.error, "finalHeatCapacity must be an integer between 1 and 10000.");
  assert.equal((await attempt({ finalHeatCapacity: 1 })).response.status, 200);

  // The retired balanced mode is refused rather than silently ignored.
  const retired = await attempt({ heatAssignmentMode: "POST_CLOSE_BALANCED" });
  assert.equal(retired.response.status, 400);
  assert.equal(
    retired.body.error,
    "Heats are assigned during duck pairing; there is no other heat assignment mode.",
  );
  assert.equal(retired.db.batches.length, 0);
  assert.equal((await attempt({ heatAssignmentMode: "IMMEDIATE_FIXED" })).response.status, 200);
});

// The console detects the operator's zone and sends it with the create command,
// so a new race starts in the zone the operator is actually standing in.
test("event creation persists a submitted detected timezone instead of the retained default", async () => {
  const defaults = {
    timezone: "America/Denver",
    email_required: 0,
    heat_assignment_mode: "IMMEDIATE_FIXED",
    round_one_heat_capacity: 8,
    final_heat_capacity: 16,
    public_name_policy: "FIRST_NAME_ONLY",
  };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql === "SELECT id FROM events LIMIT 1") return null;
    if (sql.includes("FROM organization_event_defaults")) return defaults;
    return null;
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId: crypto.randomUUID(),
      name: "Detected Zone Race",
      eventDate: "2026-09-01",
      timezone: "Pacific/Auckland",
      roundOneHeatCapacity: 6,
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.event.timezone, "Pacific/Auckland");
  // The zone is a bound value, never interpolated into SQL.
  assert.equal(db.batches[0][0].args[4], "Pacific/Auckland");
  assert.equal(db.batches[0][0].sql.includes("Pacific/Auckland"), false);
  const auditDetails = JSON.parse(db.batches[0][2].args[5]);
  assert.equal(auditDetails.timezone, "Pacific/Auckland");
});

test("event creation validates a submitted timezone before any database access", async () => {
  for (const timezone of ["Not/AZone", "notazone", "", "   ", "America/Denver'; DROP TABLE events;--", "+05:00", 42, null, "Europe/".padEnd(70, "x")]) {
    const db = makeDb(() => null);
    const response = await handleEventOperations(
      jsonRequest("/api/v1/staff/events", "POST", {
        commandId: crypto.randomUUID(),
        name: "Bad Zone Race",
        eventDate: "2026-09-01",
        timezone,
        roundOneHeatCapacity: 6,
      }),
      makeEnv(db),
      admin,
    );

    assert.equal(response.status, 400, `timezone ${JSON.stringify(timezone)} must be rejected`);
    assert.match((await response.json()).error, /valid IANA timezone/);
    assert.equal(db.statements.length, 0);
    assert.equal(db.batches.length, 0);
  }
});

test("event creation without a timezone still inherits the retained organization default", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql === "SELECT id FROM events LIMIT 1") return null;
    if (sql.includes("FROM organization_event_defaults")) return { ...draftEvent, timezone: "America/Chicago", email_required: 0 };
    return null;
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId: crypto.randomUUID(),
      name: "Inherited Zone Race",
      eventDate: "2026-09-01",
      roundOneHeatCapacity: 6,
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).event.timezone, "America/Chicago");
  assert.equal(db.batches[0][0].args[4], null);
});

test("configuration accepts real IANA zone identifiers, including legacy links already stored", async () => {
  for (const timezone of [
    "UTC",
    "America/Denver",
    "Europe/London",
    "Pacific/Chatham",
    "America/Argentina/Buenos_Aires",
    "America/Indiana/Indianapolis",
    "Etc/GMT+5",
    "US/Mountain",
    "Asia/Calcutta",
  ]) {
    const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : draftEvent);
    const response = await handleEventOperations(
      jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
        commandId: crypto.randomUUID(),
        revision: 0,
        timezone,
      }),
      makeEnv(db),
      admin,
    );

    assert.equal(response.status, 200, `timezone ${timezone} must be accepted`);
    assert.equal((await response.json()).event.timezone, timezone);
    // The stored identifier is exactly what was submitted, never canonicalized.
    assert.equal(db.batches[0][1].args[3], timezone);
  }
});

test("configuration rejects timezone junk with 400 and never reaches the database", async () => {
  for (const timezone of [
    "notazone",
    "Not/AZone",
    "Mars/Olympus_Mons",
    "America/Denver extra",
    "<script>alert(1)</script>",
    "../../etc/passwd",
    "'; DROP TABLE events;--",
    "+05:00",
    "12345",
    "",
    "   ",
    "A".repeat(65),
    "America//Denver",
    "America/Denver/",
    "America/North/Dakota/Beulah",
    42,
    null,
    true,
    ["America/Denver"],
    { timezone: "America/Denver" },
  ]) {
    const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : draftEvent);
    const response = await handleEventOperations(
      jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
        commandId: crypto.randomUUID(),
        revision: 0,
        timezone,
      }),
      makeEnv(db),
      admin,
    );

    assert.equal(response.status, 400, `timezone ${JSON.stringify(timezone)} must be rejected`);
    assert.match((await response.json()).error, /valid IANA timezone/);
    assert.equal(db.statements.length, 0, `timezone ${JSON.stringify(timezone)} must not query`);
    assert.equal(db.batches.length, 0);
  }
});

test("a timezone stored before the tightened check still loads and saves unchanged", async () => {
  const legacyEvent = { ...draftEvent, timezone: "US/Mountain" };
  const db = makeDb((sql) => {
    if (sql.includes("AS registration_count")) {
      return { registration_count: 0, event_duck_count: 0, round_one_heat_count: 0, final_heat_count: 0 };
    }
    return legacyEvent;
  });
  const detail = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test"),
    makeEnv(db),
    staff,
  );
  assert.equal((await detail.json()).event.timezone, "US/Mountain");

  // An unrelated edit must not rewrite the stored zone.
  const configureDb = makeDb((sql) => sql.includes("FROM race_commands") ? null : legacyEvent);
  const configured = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 0,
      roundOneHeatCapacity: 9,
    }),
    makeEnv(configureDb),
    admin,
  );

  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).event.timezone, "US/Mountain");
  assert.equal(configureDb.batches[0][1].args[3], "US/Mountain");
});

test("event creation refuses to create a second race dataset", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands")) return null;
    if (sql === "SELECT id FROM events LIMIT 1") return { id: "existing_event" };
    return null;
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId: crypto.randomUUID(),
      name: "Second Race",
      eventDate: "2027-09-01",
      roundOneHeatCapacity: 10,
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 409);
  assert.equal(db.batches.length, 0);
});

test("configuration requires an administrator and the current revision", async () => {
  const regularDb = makeDb(() => draftEvent);
  const denied = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 0,
      timezone: "UTC",
    }),
    makeEnv(regularDb),
    staff,
  );
  assert.equal(denied.status, 403);

  const staleDb = makeDb((sql) => sql.includes("FROM race_commands") ? null : { ...draftEvent, revision: 3 });
  const stale = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 2,
      timezone: "UTC",
    }),
    makeEnv(staleDb),
    admin,
  );
  assert.equal(stale.status, 409);
  assert.equal(staleDb.batches.length, 0);
});

test("revision-checked configuration updates the event, retained defaults, command, and audit", async () => {
  const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : draftEvent);
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 0,
      name: "Café & Duck Dash",
      slug: "UNSAFE/client/value",
      timezone: "UTC",
      registrationOpensAt: "2026-08-01T12:00:00-06:00",
      registrationClosesAt: "2026-08-29T12:00:00-06:00",
      roundOneHeatCapacity: 12,
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.event.revision, 1);
  assert.equal(body.event.slug, "cafe-duck-dash");
  assert.equal(body.event.timezone, "UTC");
  assert.equal(body.event.registrationOpensAt, "2026-08-01T18:00:00.000Z");
  assert.match(db.batches[0][0].sql, /'CONFIGURE_EVENT'.*revision = \?/s);
  assert.match(db.batches[0][1].sql, /EXISTS \(\s*SELECT 1 FROM race_commands/s);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /WHERE id = \? AND status = 'DRAFT' AND revision = \?/);
  assert.match(sql, /UPDATE organization_event_defaults/);
  assert.match(sql, /'CONFIGURE_EVENT'/);
  assert.match(sql, /'EVENT_CONFIGURED'/);
  assert.equal(db.batches[0][1].args[0], "cafe-duck-dash");
});

test("configuration ignores submitted slugs and preserves a persisted slug when the name is unchanged", async () => {
  const legacyEvent = { ...draftEvent, slug: "Legacy_Slug" };
  const db = makeDb((sql) => sql.includes("FROM race_commands") ? null : legacyEvent);
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/configuration", "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 0,
      slug: "../../unsafe-client-slug",
      timezone: "UTC",
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.event.slug, "Legacy_Slug");
  assert.equal(db.batches[0][1].args[0], "Legacy_Slug");
});

test("readiness reports actionable blockers without changing the event", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("submitted_registration_count")) {
      return {
        ...readyStats,
        submitted_registration_count: 2,
        active_entry_without_round_one_heat_count: 1,
        pending_provisioning_count: 1,
        round_one_heat_count: 0,
        any_heat_count: 0,
      };
    }
    return { ...draftEvent, status: "REGISTRATION_CLOSED" };
  });
  const response = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    makeEnv(db),
    staff,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.readiness["start-round-one"].allowed, false);
  assert.match(body.readiness["start-round-one"].blockers.join(" "), /submitted participant/);
  assert.match(body.readiness["start-round-one"].blockers.join(" "), /pending NFC sticker/);
  assert.equal(body.readiness["reopen-registration"].allowed, true);
  assert.equal(db.batches.length, 0);
});

// The predicate this replaces treated any non-ACTIVE roster entry as a blocker,
// which made the race unstartable the moment somebody left. Now the entries are
// reported and the only refusal is a heat with nobody who could win.
test("readiness reports withdrawn racers on rosters and blocks only a heat nobody can win", async () => {
  const reported = async (stats, action, status) => {
    const db = makeDb((sql) => sql.includes("submitted_registration_count")
      ? { ...readyStats, ...stats }
      : { ...draftEvent, status });
    const response = await handleEventOperations(
      new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
      makeEnv(db),
      staff,
    );
    assert.equal(response.status, 200);
    assert.equal(db.batches.length, 0);
    return (await response.json()).readiness[action];
  };

  const roundOneWithLeavers = await reported(
    { round_one_inactive_roster_entry_count: 2, round_one_ineligible_heat_count: 0 },
    "start-round-one",
    "REGISTRATION_CLOSED",
  );
  assert.equal(roundOneWithLeavers.allowed, true);
  assert.deepEqual(roundOneWithLeavers.blockers, []);
  assert.deepEqual(roundOneWithLeavers.notes, [
    "2 racers on round-one rosters are withdrawn or disqualified. Those ducks stay in their "
    + "heat bags and race as normal, but cannot be recorded as winners.",
  ]);

  const roundOneUnwinnable = await reported(
    { round_one_inactive_roster_entry_count: 3, round_one_ineligible_heat_count: 1 },
    "start-round-one",
    "REGISTRATION_CLOSED",
  );
  assert.equal(roundOneUnwinnable.allowed, false);
  assert.deepEqual(roundOneUnwinnable.blockers, [
    "A heat in round one has no racer left who can win: every racer on that roster is "
    + "withdrawn or disqualified, so the heat could not produce a result. Reactivate a racer "
    + "before starting. The roster, the slot numbers, and the ducks in the bag stay exactly as they are.",
  ]);
  // Still reported alongside the blocker, so the operator sees the whole picture.
  assert.equal(roundOneUnwinnable.notes.length, 1);

  const finalWithLeaver = await reported(
    { final_inactive_roster_entry_count: 1, final_ineligible_heat_count: 0 },
    "start-final",
    "ROUND_ONE",
  );
  assert.equal(finalWithLeaver.allowed, true);
  assert.deepEqual(finalWithLeaver.blockers, []);
  assert.deepEqual(finalWithLeaver.notes, [
    "1 racer on the final roster is withdrawn or disqualified. That duck stays in its heat bag "
    + "and races as normal, but cannot be recorded as a winner.",
  ]);

  const finalUnwinnable = await reported(
    { final_inactive_roster_entry_count: 2, final_ineligible_heat_count: 1 },
    "start-final",
    "ROUND_ONE",
  );
  assert.equal(finalUnwinnable.allowed, false);
  assert.match(finalUnwinnable.blockers.join(" "), /no racer left who can win/);
});

test("opening registration is blocked for a legacy event without a ducks-per-heat size", async () => {
  const legacyEvent = { ...draftEvent, round_one_heat_capacity: null };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
    if (sql.includes("submitted_registration_count")) {
      return { ...readyStats, round_one_heat_count: 0, any_heat_count: 0 };
    }
    return legacyEvent;
  });
  const readiness = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    makeEnv(db),
    staff,
  );
  const readinessBody = await readiness.json();

  assert.equal(readinessBody.readiness["open-registration"].allowed, false);
  assert.match(
    readinessBody.readiness["open-registration"].blockers.join(" "),
    /ducks race in each heat/i,
  );

  const transition = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );
  assert.equal(transition.status, 409);
  assert.match((await transition.json()).readiness.blockers.join(" "), /ducks race in each heat/i);
  assert.equal(db.batches.length, 0);
});

test("round-one readiness and transition reject more heats than final capacity", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
    if (sql.includes("submitted_registration_count")) return readyStats;
    return { ...draftEvent, status: "REGISTRATION_CLOSED", final_heat_capacity: 1 };
  });
  const readiness = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    makeEnv(db),
    staff,
  );
  const readinessBody = await readiness.json();

  assert.equal(readinessBody.readiness["start-round-one"].allowed, false);
  assert.match(readinessBody.readiness["start-round-one"].blockers.join(" "), /final capacity/i);

  const transition = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/start-round-one", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );
  assert.equal(transition.status, 409);
  assert.match((await transition.json()).readiness.blockers.join(" "), /final capacity/i);
  assert.equal(db.batches.length, 0);
});

const lifecycleCases = [
  ["open-registration", "DRAFT", "REGISTRATION_OPEN", "OPEN_REGISTRATION"],
  ["close-registration", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "CLOSE_REGISTRATION"],
  ["reopen-registration", "REGISTRATION_CLOSED", "REGISTRATION_OPEN", "REOPEN_REGISTRATION"],
  ["start-round-one", "REGISTRATION_CLOSED", "ROUND_ONE", "START_ROUND_ONE"],
  ["start-final", "ROUND_ONE", "FINAL", "START_FINAL"],
  ["complete", "FINAL", "COMPLETED", "COMPLETE_EVENT"],
];

for (const [action, fromStatus, toStatus, commandType] of lifecycleCases) {
  test(`runs explicit, readiness-checked ${commandType} command`, async () => {
    const stats = {
      ...readyStats,
      any_heat_count: action === "reopen-registration" ? 0 : readyStats.any_heat_count,
    };
    const db = makeDb((sql) => {
      if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
      if (sql.includes("submitted_registration_count")) return stats;
      return { ...draftEvent, status: fromStatus };
    });
    const response = await handleEventOperations(
      jsonRequest(`/api/v1/staff/events/event_test/${action}`, "POST", { commandId: crypto.randomUUID() }),
      makeEnv(db),
      action === "reopen-registration" ? admin : staff,
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.event.status, toStatus);
    const command = db.batches[0][0];
    const update = db.batches[0][1];
    assert.match(command.sql, new RegExp(`'${commandType}'`));
    if (action === "open-registration") {
      assert.match(command.sql, /e\.round_one_heat_capacity >= 1/);
    }
    if (action === "start-round-one") {
      assert.match(command.sql, /COUNT\(\*\).*ROUND_ONE.*<= e\.final_heat_capacity/s);
      assert.match(command.sql, /START_DUCK_PROVISIONING/);
      assert.match(command.sql, /d\.inventory_status = 'NEW'.*d\.physical_condition = 'NEEDS_TAG'.*dt\.status = 'RESERVED'/s);
      assert.match(command.sql, /event_ducks ed.*ed\.released_at IS NULL/s);
    }
    assert.match(update.sql, new RegExp(`status = '${toStatus}'`));
    assert.doesNotMatch(update.sql, /SET status = \?/);
    assert.equal(command.args.includes("event_test"), true);
  });
}

// The lifecycle is exactly six statuses reached by exactly six transitions.
// COMPLETED is terminal: results stay public until an administrator deletes
// the event, so nothing may advance past it.
test("readiness publishes exactly the six-status lifecycle", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
    if (sql.includes("submitted_registration_count")) return readyStats;
    return { ...draftEvent, status: "COMPLETED" };
  });
  const response = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    makeEnv(db),
    staff,
  );
  const body = await response.json();

  assert.deepEqual(Object.keys(body.readiness), [
    "open-registration",
    "close-registration",
    "reopen-registration",
    "start-round-one",
    "start-final",
    "complete",
  ]);
  const statuses = new Set();
  for (const state of Object.values(body.readiness)) {
    statuses.add(state.fromStatus);
    statuses.add(state.toStatus);
  }
  assert.deepEqual([...statuses].sort(), [
    "COMPLETED",
    "DRAFT",
    "FINAL",
    "REGISTRATION_CLOSED",
    "REGISTRATION_OPEN",
    "ROUND_ONE",
  ]);
});

test("the retired start-return-processing transition is gone", async () => {
  const db = makeDb(() => {
    throw new Error("a removed transition must not read the database");
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/start-return-processing", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );

  // No lifecycle handler claims the path, so the module falls through.
  assert.equal(response, null);
  assert.equal(db.statements.length, 0);
  assert.equal(db.batches.length, 0);
});

// A retired status must not be reachable through idempotency replay logic
// either: the completed-transition probe only recognises current commands.
test("lifecycle replay history never references retired commands", async () => {
  const seen = [];
  const db = makeDb((sql) => {
    seen.push(sql);
    if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
    if (sql.includes("candidate.command_type IN")) return null;
    if (sql.includes("submitted_registration_count")) return readyStats;
    return { ...draftEvent, status: "COMPLETED" };
  });
  await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/complete", "POST", { commandId: crypto.randomUUID() }),
    makeEnv(db),
    staff,
  );
  const sql = seen.join("\n");
  assert.doesNotMatch(sql, /START_RETURN_PROCESSING|RECORD_DUCK_DISPOSITION|FINALIZE_RETURN_BATCH/);
  assert.doesNotMatch(sql, /MARK_EVENT_PURGE_READY|CANCEL_EVENT_PURGE_READY/);
});

test("atomic round-one start rejects provisioning begun after readiness preflight", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_staff_identity.sql",
    "0002_registration_foundation.sql",
    "0003_assignment_and_heat_status.sql",
    "0004_pairing_status_and_purge.sql",
    "0005_staff_access_management.sql",
    "0006_participant_operations.sql",
    "0007_duck_inventory_operations.sql",
    "0008_event_operations.sql",
    "0009_heat_result_operations.sql",
  ]) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email)
    VALUES ('staff_test', 'staff-sub', 'staff@example.com');
    INSERT INTO events
      (id, slug, name, timezone, status, final_heat_capacity)
    VALUES ('event_test', 'test-race', 'Test Race', 'America/Denver', 'REGISTRATION_CLOSED', 2);
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('heat', 'event_test', 'ROUND_ONE', 1, 'PLANNED');
  `);
  // A heat is raceable only at the minimum heat size, so this fixture seeds a
  // full three-duck heat and keeps testing the provisioning race it is named for.
  for (const slot of [1, 2, 3]) {
    database.exec(`
      INSERT INTO registrations
        (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
         submitted_at, status_changed_at)
      VALUES
        ('registration-${slot}', 'event_test', 'Daisy', 'Duck', 'ACTIVE', 'DAISY12${slot}',
         'private-hash-${slot}', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
      INSERT INTO race_entries (id, event_id, registration_id)
      VALUES ('entry-${slot}', 'event_test', 'registration-${slot}');
      INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
      VALUES
        ('pair-command-${slot}', 'event_test', 'PAIR_DUCK', 'assignment-${slot}',
         '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
      INSERT INTO ducks
        (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
      VALUES ('duck-${slot}', ${10 + slot}, 'IN_USE', '2026-07-26T00:00:00Z', 'GOOD');
      INSERT INTO event_ducks
        (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
      VALUES ('event-duck-${slot}', 'event_test', 'duck-${slot}', '2026-07-26T00:00:00Z', 'staff_test');
      INSERT INTO duck_assignments
        (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
         assigned_by_staff_profile_id, source_command_id)
      VALUES
        ('assignment-${slot}', 'event_test', 'entry-${slot}', 'event-duck-${slot}', 'duck-${slot}',
         '2026-07-26T00:00:00Z', 'staff_test', 'pair-command-${slot}');
      INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
      VALUES
        ('heat-entry-${slot}', 'event_test', 'heat', 'entry-${slot}', 'ROUND_ONE', ${slot},
         'PAIRING', '2026-07-26T00:00:00Z');
    `);
  }

  let insertedPending = false;
  const env = makeEnv(sqliteD1(database, () => {
    if (insertedPending) return;
    insertedPending = true;
    database.exec(`
      INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
      VALUES
        ('pending-start', 'event_test', 'START_DUCK_PROVISIONING', 'pending-duck',
         '2026-07-26T00:01:00Z', '2026-07-26T00:01:00Z');
      INSERT INTO ducks
        (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
      VALUES ('pending-duck', 2, 'NEW', '2026-07-26T00:01:00Z', 'NEEDS_TAG');
      INSERT INTO duck_tags (id, duck_id, token, status)
      VALUES ('pending-tag', 'pending-duck', 'pending-token', 'RESERVED');
    `);
  }));

  const before = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    env,
    staff,
  );
  assert.equal((await before.json()).readiness["start-round-one"].allowed, true);

  const transition = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/start-round-one", "POST", {
      commandId: crypto.randomUUID(),
    }),
    env,
    staff,
  );
  assert.equal(transition.status, 409);
  assert.equal(database.prepare("SELECT status FROM events WHERE id = 'event_test'").get().status, "REGISTRATION_CLOSED");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'START_ROUND_ONE'").get().count, 0);

  const after = await handleEventOperations(
    new Request("https://quickducks.com/api/v1/staff/events/event_test/readiness"),
    env,
    staff,
  );
  const afterReadiness = (await after.json()).readiness["start-round-one"];
  assert.equal(afterReadiness.allowed, false);
  assert.match(afterReadiness.blockers.join(" "), /Finish the pending NFC sticker/);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a lifecycle command does not write when readiness blockers remain", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands") && sql.includes("request_fingerprint")) return null;
    if (sql.includes("submitted_registration_count")) {
      return { ...readyStats, submitted_registration_count: 1 };
    }
    return { ...draftEvent, status: "REGISTRATION_CLOSED" };
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/start-round-one", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).readiness.allowed, false);
  assert.equal(db.batches.length, 0);
});

test("a lifecycle command replay returns the saved result without a second write", async () => {
  const commandId = "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370";
  const fingerprint = JSON.stringify({ operation: "CLOSE_REGISTRATION", eventId: "event_test" });
  const db = makeDb((sql) => sql.includes("FROM race_commands")
    ? {
      event_id: "event_test",
      command_type: "CLOSE_REGISTRATION",
      result_id: "event_test",
      request_fingerprint: fingerprint,
    }
    : { ...draftEvent, status: "REGISTRATION_CLOSED", revision: 2 });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/close-registration", "POST", { commandId }),
    makeEnv(db),
    staff,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  assert.equal(db.batches.length, 0);
});

test("a new lifecycle command reports an already-completed transition without writing", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("SELECT event_id, command_type")) return null;
    if (sql.includes("SELECT rc.id")) return { id: "open-command" };
    if (sql.includes("submitted_registration_count")) return readyStats;
    return { ...draftEvent, status: "REGISTRATION_OPEN", revision: 1 };
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.event.status, "REGISTRATION_OPEN");
  assert.equal(body.event.revision, 1);
  assert.equal(body.replayed, false);
  assert.equal(body.transitioned, false);
  assert.equal(body.alreadyAtTarget, true);
  assert.equal(db.batches.length, 0);
});

// End to end against the real migrated schema: the detected zone the console
// sends survives creation, reload, and a later configuration edit.
test("migrated SQLite stores the created timezone and round-trips it through configuration", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec("INSERT INTO staff_profiles (id, cognito_sub, email, display_name) VALUES ('admin_test', 'admin-sub', 'admin@example.com', 'Admin')");
  const env = makeEnv(sqliteD1(database));
  const seededDefault = database.prepare("SELECT timezone FROM organization_event_defaults WHERE singleton_id = 1").get().timezone;

  const created = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId: crypto.randomUUID(),
      name: "Zone Round Trip",
      eventDate: "2026-09-01",
      timezone: "Pacific/Auckland",
      roundOneHeatCapacity: 6,
    }),
    env,
    admin,
  );
  const createdBody = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdBody.event.timezone, "Pacific/Auckland");
  assert.notEqual("Pacific/Auckland", seededDefault, "the detected zone differs from the retained default");
  const storedRow = database.prepare("SELECT timezone FROM events WHERE id = ?").get(createdBody.event.id);
  assert.equal(storedRow.timezone, "Pacific/Auckland");

  // Reading the event back returns the stored zone for the picker to display.
  const detail = await handleEventOperations(
    new Request(`https://quickducks.com/api/v1/staff/events/${createdBody.event.id}`),
    env,
    admin,
  );
  assert.equal((await detail.json()).event.timezone, "Pacific/Auckland");

  // A configuration save persists a new zone and retains it as the default.
  const configured = await handleEventOperations(
    jsonRequest(`/api/v1/staff/events/${createdBody.event.id}/configuration`, "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 0,
      timezone: "America/Argentina/Buenos_Aires",
    }),
    env,
    admin,
  );
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).event.timezone, "America/Argentina/Buenos_Aires");
  assert.equal(
    database.prepare("SELECT timezone FROM events WHERE id = ?").get(createdBody.event.id).timezone,
    "America/Argentina/Buenos_Aires",
  );
  assert.equal(
    database.prepare("SELECT timezone FROM organization_event_defaults WHERE singleton_id = 1").get().timezone,
    "America/Argentina/Buenos_Aires",
  );

  // Rejected junk leaves the stored zone untouched.
  const rejected = await handleEventOperations(
    jsonRequest(`/api/v1/staff/events/${createdBody.event.id}/configuration`, "PATCH", {
      commandId: crypto.randomUUID(),
      revision: 1,
      timezone: "Mars/Olympus_Mons",
    }),
    env,
    admin,
  );
  assert.equal(rejected.status, 400);
  assert.equal(
    database.prepare("SELECT timezone FROM events WHERE id = ?").get(createdBody.event.id).timezone,
    "America/Argentina/Buenos_Aires",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("migrated SQLite makes concurrent, replayed, and stale lifecycle commands idempotent", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status)
    VALUES ('event_test', 'test-race', 'Test Duck Race', '2026-08-30', 'America/Denver', 'DRAFT');
  `);
  const env = makeEnv(sqliteD1(database));
  const firstCommandId = crypto.randomUUID();
  const secondCommandId = crypto.randomUUID();

  const concurrent = await Promise.all([
    handleEventOperations(
      jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", { commandId: firstCommandId }),
      env,
      staff,
    ),
    handleEventOperations(
      jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", { commandId: secondCommandId }),
      env,
      staff,
    ),
  ]);
  const concurrentBodies = await Promise.all(concurrent.map((response) => response.json()));
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201]);
  assert.equal(concurrentBodies.filter((body) => body.transitioned).length, 1);
  assert.equal(concurrentBodies.filter((body) => body.alreadyAtTarget).length, 1);
  const openedEvent = database.prepare("SELECT status, revision FROM events WHERE id = 'event_test'").get();
  assert.equal(openedEvent.status, "REGISTRATION_OPEN");
  assert.equal(openedEvent.revision, 1);
  const savedOpenCommandId = database.prepare(
    "SELECT id FROM race_commands WHERE event_id = 'event_test' AND command_type = 'OPEN_REGISTRATION'",
  ).get().id;
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE event_id = 'event_test' AND command_type = 'OPEN_REGISTRATION'",
  ).get().count, 1);

  const replay = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", { commandId: savedOpenCommandId }),
    env,
    staff,
  );
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.alreadyAtTarget, true);

  const staleNewCommand = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", { commandId: crypto.randomUUID() }),
    env,
    staff,
  );
  const staleNewBody = await staleNewCommand.json();
  assert.equal(staleNewCommand.status, 200);
  assert.equal(staleNewBody.replayed, false);
  assert.equal(staleNewBody.transitioned, false);
  assert.equal(staleNewBody.alreadyAtTarget, true);

  assert.equal((await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/close-registration", "POST", { commandId: crypto.randomUUID() }),
    env,
    staff,
  )).status, 201);
  assert.equal((await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/reopen-registration", "POST", { commandId: crypto.randomUUID() }),
    env,
    admin,
  )).status, 201);

  const wrongInboundTransition = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/open-registration", "POST", { commandId: crypto.randomUUID() }),
    env,
    staff,
  );
  const wrongInboundBody = await wrongInboundTransition.json();
  assert.equal(wrongInboundTransition.status, 409);
  assert.match(wrongInboundBody.readiness.blockers.join(" "), /Event status must be DRAFT/);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM race_commands WHERE event_id = 'event_test' AND command_type = 'OPEN_REGISTRATION'",
  ).get().count, 1);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = 'event_test' AND action = 'REGISTRATION_OPENED'",
  ).get().count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("only an administrator can reopen registration", async () => {
  const db = makeDb(() => null);
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test/reopen-registration", "POST", {
      commandId: crypto.randomUUID(),
    }),
    makeEnv(db),
    staff,
  );

  assert.equal(response.status, 403);
  assert.equal(db.statements.length, 0);
});

test("the retired empty-draft deletion route is not handled", async () => {
  const db = makeDb(() => draftEvent);
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test", "DELETE", {
      commandId: crypto.randomUUID(),
      revision: 0,
      confirmation: "DELETE Test Duck Race",
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response, null);
  assert.equal(db.statements.length, 0);
  assert.equal(db.batches.length, 0);
});

test("event operations migration retains defaults independently of event deletion", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_staff_identity.sql",
    "0002_registration_foundation.sql",
    "0003_assignment_and_heat_status.sql",
    "0004_pairing_status_and_purge.sql",
    "0005_staff_access_management.sql",
  ]) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO events
      (id, slug, name, timezone, status, email_required, heat_assignment_mode,
       round_one_heat_capacity, final_heat_capacity, public_name_policy)
    VALUES
      ('event', 'test-race', 'Test Race', 'America/Denver', 'DRAFT', 1,
       'IMMEDIATE_FIXED', 8, 24, 'FIRST_NAME_ONLY');
  `);
  database.exec(readFileSync(new URL("../db/migrations/0008_event_operations.sql", import.meta.url), "utf8"));

  const defaults = database.prepare(
    `SELECT timezone, email_required, heat_assignment_mode,
            round_one_heat_capacity, final_heat_capacity, public_name_policy
       FROM organization_event_defaults`,
  ).get();
  assert.deepEqual({ ...defaults }, {
    timezone: "America/Denver",
    email_required: 1,
    heat_assignment_mode: "IMMEDIATE_FIXED",
    round_one_heat_capacity: 8,
    final_heat_capacity: 24,
    public_name_policy: "FIRST_NAME_ONLY",
  });
  assert.equal(database.prepare("SELECT revision FROM events WHERE id = 'event'").get().revision, 0);
  database.exec("DELETE FROM events WHERE id = 'event'");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM organization_event_defaults").get().count, 1);
  database.close();
});
