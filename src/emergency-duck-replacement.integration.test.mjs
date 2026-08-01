import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
import { createWorker } from "./index.ts";
import { randomToken } from "./registration.ts";

// Emergency replacement is the last-resort repair for a lost or damaged duck
// during a race. These tests drive the real Worker handlers against a fully
// migrated SQLite database, from a race seeded through the same endpoints the
// staff console calls, so the states under test are states the application can
// actually produce.

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
  const migrationNames = readdirSync(migrationsUrl)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.ok(migrationNames.length > 0);
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const adminToken = "admin.test.token";
const staffToken = "staff.test.token";
// An operational account that holds no pairing grant at all, which is what
// proves the new command is least privilege rather than merely authenticated.
const announcerToken = "announcer.test.token";

const verifyStaffToken = async (token) => {
  if (token === adminToken) return { sub: "admin-sub" };
  if (token === staffToken) return { sub: "staff-sub" };
  if (token === announcerToken) return { sub: "announcer-sub" };
  throw new Error("Invalid test staff token");
};

const jsonBody = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

const createWorkerHarness = (database) => {
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 'Race Administrator', 1, 1),
      ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1),
      ('announcer', 'announcer-sub', 'announcer@example.com', 'Announcer', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES
      ('staff-registration', 'staff', 'REGISTRATION', '2026-07-26T00:00:00Z'),
      ('staff-ducks', 'staff', 'DUCK_MANAGER', '2026-07-26T00:00:00Z'),
      ('staff-heats', 'staff', 'HEAT_RUNNER', '2026-07-26T00:00:00Z'),
      ('staff-results', 'staff', 'RESULT_TAKER', '2026-07-26T00:00:00Z'),
      ('staff-director', 'staff', 'RACE_DIRECTOR', '2026-07-26T00:00:00Z'),
      ('announcer-only', 'announcer', 'ANNOUNCER', '2026-07-26T00:00:00Z');
  `);
  const updateTasks = [];
  const env = {
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
    RACE_UPDATES: {
      idFromName() { return "race-updates-id"; },
      get() {
        return { async fetch() { return new Response(null, { status: 204 }); } };
      },
    },
    TURNSTILE_SECRET_KEY: "turnstile-test-secret",
  };
  const worker = createWorker((request, currentEnv) =>
    authenticateStaff(request, currentEnv, verifyStaffToken));
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, { waitUntil(promise) { updateTasks.push(promise); } });
  };
  return {
    api,
    post: (path, body, token = staffToken) => api(path, { method: "POST", body, token }),
  };
};

// Provisions a duck through the blank-tag station and leaves it unpaired and
// reserved to the event, which is exactly the spare a staffer grabs when a
// racing duck is lost or damaged.
const provisionDuck = async (post, eventId, label) => {
  const provisioning = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
    commandId: crypto.randomUUID(),
    eventId,
  }), 201, `provision ${label}`);
  await jsonBody(await post("/api/v1/staff/inventory/provisioning/confirm", {
    commandId: crypto.randomUUID(),
    eventId,
    duckId: provisioning.duckId,
    provisioningCommandId: provisioning.provisioningCommandId,
    physicalWriteVerified: true,
  }), 201, `confirm ${label}`);
  return {
    duckId: provisioning.duckId,
    visibleNumber: provisioning.visibleNumber,
    tagToken: provisioning.tagUrl.split("/").at(-1),
  };
};

// Seeds a race that has actually started, with every racer paired and placed in
// a heat, plus unpaired spare ducks.
//
// `heatCapacity` must be at least MINIMUM_HEAT_SIZE (3) because that is the
// floor both `POST /api/v1/staff/events` and the configuration PATCH enforce; a
// heat is only worth racing with a real field in it.
//
// `racerCount` must also be at least MINIMUM_HEAT_SIZE. Heats fill as
// participants are paired and `close-registration` folds a short trailing heat
// into the one before it, so the layout never strands a partly full heat — but
// a race holding fewer than three paired participants in total has no layout
// that fixes it, and `start-round-one` reports exactly that as
// "A heat cannot be raced with fewer than 3 ducks." Seeding two racers
// therefore never reaches ROUND_ONE at all.
const MINIMUM_HEAT_SIZE = 3;

const raceInRoundOne = async (database, { racerCount, heatCapacity, spares }) => {
  assert.ok(
    heatCapacity >= MINIMUM_HEAT_SIZE && racerCount >= MINIMUM_HEAT_SIZE,
    `a startable round one needs at least ${MINIMUM_HEAT_SIZE} racers and a capacity of `
      + `${MINIMUM_HEAT_SIZE}, not ${racerCount} racers at ${heatCapacity}`,
  );
  const { api, post } = createWorkerHarness(database);
  const created = await jsonBody(await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug: "replacement-race",
    name: "Replacement Race",
    eventDate: "2026-09-12",
    roundOneHeatCapacity: heatCapacity,
  }, adminToken), 201, "create event");
  const eventId = created.event.id;
  await jsonBody(await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: created.event.revision,
      roundOneHeatCapacity: heatCapacity,
      finalHeatCapacity: 10,
      publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
    },
  }), 200, "configure event");
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "open registration");

  const participants = [];
  for (let index = 0; index < racerCount; index += 1) {
    const registration = await jsonBody(await post(`/api/v1/staff/events/${eventId}/registrations`, {
      commandId: crypto.randomUUID(),
      privateToken: randomToken(),
      firstName: `Racer${index}`,
      lastName: "Example",
      email: `racer${index}@example.com`,
    }), 201, `registration ${index}`);
    const participant = {
      registrationId: registration.registration.registrationId,
      lookupCode: registration.registration.lookupCode,
      raceEntryId: registration.registration.raceEntryId,
    };
    const duck = await provisionDuck(post, eventId, `duck ${index}`);
    Object.assign(participant, duck);
    await jsonBody(await post(`/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }), 201, `pair duck ${participant.visibleNumber}`);
    participants.push(participant);
  }

  const spareDucks = [];
  for (let index = 0; index < spares; index += 1) {
    spareDucks.push(await provisionDuck(post, eventId, `spare ${index}`));
  }

  await jsonBody(await post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "close registration");
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");

  return { api, post, eventId, participants, spareDucks };
};

const activeAssignments = (database, raceEntryId) =>
  database.prepare(
    "SELECT id, duck_id FROM duck_assignments WHERE race_entry_id = ? AND valid_to IS NULL",
  ).all(raceEntryId);

const inspect = (api, tagToken, token = staffToken) =>
  api(`/api/v1/staff/ducks/${tagToken}`, { token });

const replace = (post, tagToken, body, token = staffToken) =>
  post(`/api/v1/staff/ducks/${tagToken}/replacements`, body, token);

// The pairing a staffer's browser read before it offered the flow.
const currentPairing = async (api, participant) => {
  const body = await jsonBody(
    await inspect(api, participant.tagToken),
    200,
    `inspect duck ${participant.visibleNumber}`,
  );
  return body.assignment;
};

test("a round-one duck is replaced and the participant keeps their heat and identity", async () => {
  const database = createDatabase();
  const { api, post, eventId, participants, spareDucks } = await raceInRoundOne(database, {
    racerCount: 3,
    heatCapacity: 3,
    spares: 1,
  });
  const racer = participants[0];
  const spare = spareDucks[0];

  const before = await currentPairing(api, racer);
  assert.equal(before.raceEntryId, racer.raceEntryId);

  const heatBefore = database.prepare(
    `SELECT h.round, h.heat_number, he.slot_number
       FROM heat_entries he JOIN heats h ON h.id = he.heat_id
      WHERE he.race_entry_id = ?`,
  ).get(racer.raceEntryId);

  const replaced = await jsonBody(await replace(post, spare.tagToken, {
    commandId: crypto.randomUUID(),
    eventId,
    raceEntryId: racer.raceEntryId,
    currentAssignmentId: before.id,
  }), 201, "replace the duck");

  // The confirmation readback names both duck identities and the participant.
  assert.equal(replaced.replayed, false);
  assert.equal(replaced.duck.visibleNumber, spare.visibleNumber);
  assert.equal(replaced.previousDuck.visibleNumber, racer.visibleNumber);
  assert.equal(replaced.participant.lookupCode, racer.lookupCode);
  assert.equal(replaced.heat.round, "ROUND_ONE");
  assert.equal(replaced.heat.number, heatBefore.heat_number);

  // Exactly one active association, and it is the replacement.
  const active = activeAssignments(database, racer.raceEntryId);
  assert.equal(active.length, 1);
  assert.equal(active[0].duck_id, spare.duckId);

  // The prior association is preserved as closed history, not deleted.
  const closed = database.prepare(
    "SELECT end_reason, valid_to, ended_by_staff_profile_id FROM duck_assignments WHERE id = ?",
  ).get(before.id);
  assert.equal(closed.end_reason, "EMERGENCY_REPLACEMENT");
  assert.ok(closed.valid_to !== null);
  assert.equal(closed.ended_by_staff_profile_id, "staff");

  // The started roster is untouched: same heat, same slot.
  const heatAfter = database.prepare(
    `SELECT h.round, h.heat_number, he.slot_number
       FROM heat_entries he JOIN heats h ON h.id = he.heat_id
      WHERE he.race_entry_id = ?`,
  ).get(racer.raceEntryId);
  assert.deepEqual(heatAfter, heatBefore);

  // Scanning the replacement resolves to the participant; scanning the duck it
  // replaced no longer acts as that participant's race tag.
  const newTag = await jsonBody(await inspect(api, spare.tagToken), 200, "scan the replacement");
  assert.equal(newTag.assignment.raceEntryId, racer.raceEntryId);
  assert.equal(newTag.assignment.active, true);
  const oldTag = await jsonBody(await inspect(api, racer.tagToken), 200, "scan the replaced duck");
  assert.equal(oldTag.assignment, null);
  // With no open assignment the replaced duck is offered no winner action, so
  // it cannot record a later result for the participant who moved off it.
  assert.equal(oldTag.winnerAction, null);

  const audited = database.prepare(
    "SELECT details_json FROM audit_events WHERE action = 'DUCK_REPLACED'",
  ).get();
  const details = JSON.parse(audited.details_json);
  assert.equal(details.previous_duck_id, racer.duckId);
  assert.equal(details.replacement_duck_id, spare.duckId);
  assert.equal(details.previous_assignment_id, before.id);
  // Audit carries safe identifiers only, never participant contact details.
  assert.ok(!JSON.stringify(details).includes("@example.com"));

  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();
});

test("a matching replacement retry replays and a reused command id for other material is refused", async () => {
  const database = createDatabase();
  const { api, post, eventId, participants, spareDucks } = await raceInRoundOne(database, {
    racerCount: 3,
    heatCapacity: 3,
    spares: 2,
  });
  const racer = participants[0];
  const other = participants[1];
  const before = await currentPairing(api, racer);
  const commandId = crypto.randomUUID();
  const material = {
    commandId,
    eventId,
    raceEntryId: racer.raceEntryId,
    currentAssignmentId: before.id,
  };

  const first = await jsonBody(
    await replace(post, spareDucks[0].tagToken, material),
    201,
    "first replacement",
  );

  // The interrupted client repeats itself with the same command and the same
  // material: it replays instead of replacing a second time.
  const retry = await jsonBody(
    await replace(post, spareDucks[0].tagToken, material),
    200,
    "matching retry",
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.assignmentId, first.assignmentId);
  assert.equal(retry.previousDuck.visibleNumber, racer.visibleNumber);
  assert.equal(activeAssignments(database, racer.raceEntryId).length, 1);

  // The same identifier presented for different material is a conflict, and
  // leaves the other participant untouched.
  const otherPairing = await currentPairing(api, other);
  await jsonBody(await replace(post, spareDucks[1].tagToken, {
    commandId,
    eventId,
    raceEntryId: other.raceEntryId,
    currentAssignmentId: otherPairing.id,
  }), 409, "reused command id for other material");
  const otherActive = activeAssignments(database, other.raceEntryId);
  assert.equal(otherActive.length, 1);
  assert.equal(otherActive[0].id, otherPairing.id);

  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();
});

test("replacement refuses a paired duck, a stale pairing, an unknown participant, and a bad command", async () => {
  const database = createDatabase();
  const { api, post, eventId, participants, spareDucks } = await raceInRoundOne(database, {
    racerCount: 3,
    heatCapacity: 3,
    spares: 1,
  });
  const racer = participants[0];
  const other = participants[1];
  const spare = spareDucks[0];
  const before = await currentPairing(api, racer);

  const attempt = (tagToken, body) => replace(post, tagToken, {
    commandId: crypto.randomUUID(),
    eventId,
    raceEntryId: racer.raceEntryId,
    currentAssignmentId: before.id,
    ...body,
  });

  // A replacement duck that is already racing for somebody else would strand
  // that participant, so it is refused rather than chained.
  await jsonBody(await attempt(other.tagToken, {}), 409, "already paired replacement");

  // Stale pairing state: the browser named an assignment that is not the one
  // currently open for this participant.
  await jsonBody(
    await attempt(spare.tagToken, { currentAssignmentId: crypto.randomUUID() }),
    409,
    "stale pairing",
  );

  // A participant who is not in this event cannot be replaced into.
  await jsonBody(
    await attempt(spare.tagToken, { raceEntryId: crypto.randomUUID() }),
    409,
    "unknown participant",
  );

  // Significant mutations require an RFC 4122 v4 command identifier.
  await jsonBody(await attempt(spare.tagToken, { commandId: "not-a-uuid" }), 400, "bad command id");

  // None of the refusals moved anything.
  const active = activeAssignments(database, racer.raceEntryId);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, before.id);
  assert.equal(activeAssignments(database, other.raceEntryId).length, 1);

  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();
});

test("replacement is refused to an operational account that holds no pairing grant", async () => {
  const database = createDatabase();
  const { api, post, eventId, participants, spareDucks } = await raceInRoundOne(database, {
    racerCount: 3,
    heatCapacity: 3,
    spares: 1,
  });
  const racer = participants[0];
  const before = await currentPairing(api, racer);

  const denied = await replace(post, spareDucks[0].tagToken, {
    commandId: crypto.randomUUID(),
    eventId,
    raceEntryId: racer.raceEntryId,
    currentAssignmentId: before.id,
  }, announcerToken);
  assert.equal(denied.status, 403);

  const active = activeAssignments(database, racer.raceEntryId);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, before.id);

  database.close();
});

test("the replacement participant list offers paired racers with their duck and heat context", async () => {
  const database = createDatabase();
  const { api, eventId, participants } = await raceInRoundOne(database, {
    racerCount: 3,
    heatCapacity: 3,
    spares: 1,
  });
  const racer = participants[0];

  const paired = await jsonBody(await api(
    `/api/v1/staff/registrations/search?eventId=${eventId}&q=&paired=true`,
    { token: staffToken },
  ), 200, "paired search");
  assert.equal(paired.registrations.length, 3);
  const listed = paired.registrations.find((row) => row.raceEntryId === racer.raceEntryId);
  // Enough context to avoid replacing the wrong pairing.
  assert.equal(listed.assignedDuckNumber, racer.visibleNumber);
  assert.equal(listed.heat.round, "ROUND_ONE");
  assert.ok(listed.assignmentId.length > 0);

  // The default list is still the unpaired working queue every other caller
  // reads, and it does not grow the replacement-only fields.
  const unpaired = await jsonBody(await api(
    `/api/v1/staff/registrations/search?eventId=${eventId}&q=`,
    { token: staffToken },
  ), 200, "default search");
  assert.deepEqual(unpaired.registrations, []);

  database.close();
});

test("a duck is replaced during the final and the finalist keeps their final place", async () => {
  const database = createDatabase();
  // Two full round-one heats at the minimum legal size, so each heat produces a
  // winner and the final has a real field. Heats fill in pairing order, so the
  // first participant paired holds slot 1 of heat 1 and is the racer promoted
  // by that heat's published first place.
  const { api, post, eventId, participants, spareDucks } = await raceInRoundOne(database, {
    racerCount: 6,
    heatCapacity: 3,
    spares: 1,
  });

  const listed = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list heats");
  for (const heat of listed.heats.filter((entry) => entry.round === "ROUND_ONE")) {
    const detail = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, {
      token: staffToken,
    }), 200, `round-one heat ${heat.number}`);
    let revision = detail.heat.revision;
    for (const operation of ["ready", "call", "start", "finish"]) {
      const body = await jsonBody(await post(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`,
        { commandId: crypto.randomUUID(), revision },
      ), 201, `${operation} heat ${heat.number}`);
      revision = body.heat.revision;
    }
    await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`,
      {
        commandId: crypto.randomUUID(),
        revision,
        results: [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }],
      },
    ), 201, `publish heat ${heat.number}`);
  }
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");

  const finalist = participants[0];
  const spare = spareDucks[0];
  const before = await currentPairing(api, finalist);
  const finalEntryBefore = database.prepare(
    `SELECT he.slot_number, h.heat_number
       FROM heat_entries he JOIN heats h ON h.id = he.heat_id
      WHERE he.race_entry_id = ? AND h.round = 'FINAL'`,
  ).get(finalist.raceEntryId);
  assert.ok(finalEntryBefore !== undefined, "the racer reached the final");

  const replaced = await jsonBody(await replace(post, spare.tagToken, {
    commandId: crypto.randomUUID(),
    eventId,
    raceEntryId: finalist.raceEntryId,
    currentAssignmentId: before.id,
  }), 201, "replace during the final");
  assert.equal(replaced.heat.round, "FINAL");
  assert.equal(replaced.previousDuck.visibleNumber, finalist.visibleNumber);

  // Advancement and the final slot followed the participant, and the round-one
  // result that is already recorded still points at the duck that won it.
  const finalEntryAfter = database.prepare(
    `SELECT he.slot_number, h.heat_number
       FROM heat_entries he JOIN heats h ON h.id = he.heat_id
      WHERE he.race_entry_id = ? AND h.round = 'FINAL'`,
  ).get(finalist.raceEntryId);
  assert.deepEqual(finalEntryAfter, finalEntryBefore);
  const recorded = database.prepare(
    "SELECT duck_assignment_id FROM heat_results WHERE race_entry_id = ?",
  ).get(finalist.raceEntryId);
  assert.equal(recorded.duck_assignment_id, before.id);

  const active = activeAssignments(database, finalist.raceEntryId);
  assert.equal(active.length, 1);
  assert.equal(active[0].duck_id, spare.duckId);

  const newTag = await jsonBody(await inspect(api, spare.tagToken), 200, "scan the replacement");
  assert.equal(newTag.assignment.raceEntryId, finalist.raceEntryId);

  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();
});
