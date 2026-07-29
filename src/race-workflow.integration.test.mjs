import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
import { createWorker } from "./index.ts";
import { LIVE_UPDATE_DOMAINS } from "./live-updates.ts";
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
  const migrationNames = readdirSync(migrationsUrl)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.ok(migrationNames.length > 0);
  for (const name of migrationNames) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return { database, migrationNames };
};

const adminToken = "admin.test.token";
const staffToken = "staff.test.token";

const verifyStaffToken = async (token) => {
  if (token === adminToken) return { sub: "admin-sub" };
  if (token === staffToken) return { sub: "staff-sub" };
  throw new Error("Invalid test staff token");
};

const jsonBody = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

// One Worker, one migrated database, and the same handler entry point the
// deployed site uses. Both tests below drive it; nothing here writes event-domain
// SQL directly.
const createWorkerHarness = (database) => {
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 'Race Administrator', 1, 1),
      ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES
      ('staff-registration', 'staff', 'REGISTRATION', '2026-07-26T00:00:00Z'),
      ('staff-ducks', 'staff', 'DUCK_MANAGER', '2026-07-26T00:00:00Z'),
      ('staff-heats', 'staff', 'HEAT_RUNNER', '2026-07-26T00:00:00Z'),
      ('staff-results', 'staff', 'RESULT_TAKER', '2026-07-26T00:00:00Z'),
      ('staff-director', 'staff', 'RACE_DIRECTOR', '2026-07-26T00:00:00Z');
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
    updateTasks,
    post: (path, body, token = staffToken) => api(path, { method: "POST", body, token }),
  };
};

// Drives a whole race through the real handlers up to the moment the final is
// `AWAITING_RESULT`, which is where every completion question below starts.
// Nothing here writes event-domain SQL: the event, the registrations, the
// ducks, the pairings, the heats, and the round-one podium all come out of the
// same endpoints the console calls, so the layout under test is a layout the
// application can actually produce.
//
// `racerCount / heatCapacity` round-one heats each promote their winner, so the
// caller chooses the finalist count by choosing those two numbers.
const raceToAwaitingFinal = async (
  database,
  { name, slug, racerCount, heatCapacity, releasedSpareDucks = 0 },
) => {
  const { api, post } = createWorkerHarness(database);
  const created = await jsonBody(await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug,
    name,
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
    }), 201, `walk-up registration ${index}`);
    const participant = {
      registrationId: registration.registration.registrationId,
      lookupCode: registration.registration.lookupCode,
      raceEntryId: registration.registration.raceEntryId,
    };
    const provisioning = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(),
      eventId,
    }), 201, "provision duck");
    participant.visibleNumber = provisioning.visibleNumber;
    participant.tagToken = provisioning.tagUrl.split("/").at(-1);
    await jsonBody(await post("/api/v1/staff/inventory/provisioning/confirm", {
      commandId: crypto.randomUUID(),
      eventId,
      duckId: provisioning.duckId,
      provisioningCommandId: provisioning.provisioningCommandId,
      physicalWriteVerified: true,
    }), 201, "confirm duck");
    await jsonBody(await post(`/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }), 201, `pair duck ${participant.visibleNumber}`);
    participants.push(participant);
  }

  // Spare ducks reserved for the event and then handed back to inventory
  // because they turned out not to be needed. This is an ordinary registration-
  // desk action with no participant attached, and it is the plainest way an
  // event acquires an `event_ducks` row with `released_at` set.
  const releasedSpares = [];
  for (let index = 0; index < releasedSpareDucks; index += 1) {
    const provisioning = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(),
      eventId,
    }), 201, "provision a spare duck");
    await jsonBody(await post("/api/v1/staff/inventory/provisioning/confirm", {
      commandId: crypto.randomUUID(),
      eventId,
      duckId: provisioning.duckId,
      provisioningCommandId: provisioning.provisioningCommandId,
      physicalWriteVerified: true,
    }), 201, "confirm the spare duck");
    const spare = await jsonBody(await api(
      `/api/v1/staff/inventory/ducks/${provisioning.duckId}`,
      { token: staffToken },
    ), 200, "load the spare duck");
    await jsonBody(await post(
      `/api/v1/staff/inventory/ducks/${provisioning.duckId}/reservations/release`,
      {
        commandId: crypto.randomUUID(),
        eventId,
        expectedRevision: spare.duck.revision,
        reason: "This spare duck is not needed for the race after all.",
      },
    ), 201, "release the spare duck back to inventory");
    releasedSpares.push({ duckId: provisioning.duckId, visibleNumber: provisioning.visibleNumber });
  }

  await jsonBody(await post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "close registration");
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");

  const transition = async (heat, operation) => {
    const body = await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`,
      { commandId: crypto.randomUUID(), revision: heat.revision },
    ), 201, `${operation} heat ${heat.number}`);
    heat.revision = body.heat.revision;
    heat.status = body.heat.status;
  };

  const listed = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list heats");
  const roundOneHeats = listed.heats.filter((heat) => heat.round === "ROUND_ONE");
  assert.equal(roundOneHeats.length, racerCount / heatCapacity, "the requested round-one layout");
  for (const heat of roundOneHeats) {
    const detail = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, {
      token: staffToken,
    }), 200, `round-one heat ${heat.number}`);
    heat.revision = detail.heat.revision;
    for (const operation of ["ready", "call", "start", "finish"]) await transition(heat, operation);
    const published = await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`,
      {
        commandId: crypto.randomUUID(),
        revision: heat.revision,
        results: [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }],
      },
    ), 201, `publish round-one heat ${heat.number}`);
    heat.revision = published.heat.revision;
  }

  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  const finalHeat = (await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list final")).heats.find((heat) => heat.round === "FINAL");
  const finalDetail = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final roster");
  finalHeat.revision = finalDetail.heat.revision;
  for (const operation of ["ready", "call", "start", "finish"]) await transition(finalHeat, operation);
  assert.equal(finalHeat.status, "AWAITING_RESULT");

  // The participant record for each finalist, in the roster order the promotion
  // wrote, so a caller can name a podium finisher by position.
  const finalists = finalDetail.roster.map((entry) =>
    participants.find((participant) => participant.raceEntryId === entry.raceEntryId));
  const registrationRevision = async (participant) => (await jsonBody(await api(
    `/api/v1/staff/registrations/${participant.registrationId}`,
    { token: staffToken },
  ), 200, "load a registration before changing its status")).registration.revision;
  const leaveRace = async (participant, operation) => jsonBody(await post(
    `/api/v1/staff/registrations/${participant.registrationId}/${operation}`,
    { commandId: crypto.randomUUID(), expectedRevision: await registrationRevision(participant) },
  ), 201, `${operation} racer ${participant.visibleNumber}`);
  const completionReadiness = async () => (await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/readiness`,
    { token: staffToken },
  ), 200, "completion readiness")).readiness.complete;
  return {
    api,
    post,
    eventId,
    participants,
    finalists,
    finalHeat,
    leaveRace,
    releasedSpares,
    completionReadiness,
  };
};

// ---------------------------------------------------------------------------
// Scanned final podium
//
// The final is published the same way round one is: staff scan each finishing
// duck's permanent tag and the duck's own inspection page offers the places that
// are still open. Round one has one place, so its scan publishes a winner; the
// final has up to three, so the staffer says which one this duck took and the
// scan that fills the last place publishes the whole podium in one command.
//
// These tests drive the real Worker handlers against a migrated database, from a
// race that reached AWAITING_FINAL through the same endpoints the console calls.
// ---------------------------------------------------------------------------

// The scan a staffer's phone performs: open the tag, read what the duck's
// inspection page would offer, and press one of its place buttons.
const podiumScan = (api, post) => ({
  inspect: async (participant) => jsonBody(
    await api(`/api/v1/staff/ducks/${participant.tagToken}`, { token: staffToken }),
    200,
    `inspect duck ${participant.visibleNumber}`,
  ),
  record: (participant, context, place, options = {}) => post(
    `/api/v1/staff/ducks/${participant.tagToken}/heat-winner`,
    {
      commandId: options.commandId ?? crypto.randomUUID(),
      eventId: context.eventId,
      heatId: context.heatId,
      raceEntryId: context.raceEntryId,
      revision: options.revision ?? context.revision,
      place,
    },
    options.token ?? staffToken,
  ),
});

// The scanned context a duck's inspection page hands to its place buttons.
const winnerContext = async (scan, participant) => {
  const inspection = await scan.inspect(participant);
  assert.ok(inspection.winnerAction, `duck ${participant.visibleNumber} offers a result action`);
  return inspection;
};

test("a final podium is built one scanned duck at a time and published by the last place", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, finalists, finalHeat } = await raceToAwaitingFinal(database, {
    name: "Scanned Podium Race",
    slug: "scanned-podium-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const scan = podiumScan(api, post);
  const [first, second, third] = finalists;

  // Every place is open, and the page says so rather than assuming the duck in
  // hand is the winner. Places are deliberately taken out of order: staff scan
  // the ducks they can reach, not the ducks in finishing order.
  const thirdScan = await winnerContext(scan, third);
  assert.equal(thirdScan.winnerAction.round, "FINAL");
  assert.equal(thirdScan.winnerAction.heatId, finalHeat.id);
  assert.deepEqual(thirdScan.winnerAction.podium.availablePlaces, [1, 2, 3]);
  assert.equal(thirdScan.winnerAction.podium.requiredPlaces, 3);
  assert.deepEqual(thirdScan.winnerAction.podium.placements, []);
  assert.equal(thirdScan.winnerAction.podium.selectedPlace, null);
  assert.equal(thirdScan.winnerAction.podium.complete, false);

  const recordedThird = await jsonBody(
    await scan.record(third, thirdScan.winnerAction, 3),
    201,
    "record third place",
  );
  // Recording a place is not a result. The heat is still waiting, nothing is
  // published, and the public board still shows no podium.
  assert.equal(recordedThird.heat.status, "AWAITING_RESULT");
  assert.deepEqual(recordedThird.results, []);
  assert.deepEqual(recordedThird.podium.placements.map((placement) => placement.place), [3]);
  assert.equal(recordedThird.podium.placements[0].visibleNumber, third.visibleNumber);
  assert.equal(recordedThird.podium.complete, false);
  assert.deepEqual(
    (await jsonBody(await api("/api/v1/race-board"), 200, "board mid-podium")).event.podium,
    [],
  );

  // The next duck is offered only what is left, and the place already taken is
  // reported so the staffer can see who is standing where.
  const firstScan = await winnerContext(scan, first);
  assert.deepEqual(firstScan.winnerAction.podium.availablePlaces, [1, 2]);
  assert.deepEqual(firstScan.winnerAction.podium.placements.map((placement) => placement.place), [3]);
  await jsonBody(await scan.record(first, firstScan.winnerAction, 1), 201, "record first place");

  const secondScan = await winnerContext(scan, second);
  assert.deepEqual(secondScan.winnerAction.podium.availablePlaces, [2]);
  const published = await jsonBody(
    await scan.record(second, secondScan.winnerAction, 2),
    201,
    "record second place and publish",
  );
  // The last place publishes the whole podium in the same command.
  assert.equal(published.heat.status, "FINALIZED");
  assert.deepEqual(published.results.map((result) => result.place), [1, 2, 3]);
  assert.deepEqual(published.results.map((result) => result.duck.visibleNumber), [
    first.visibleNumber,
    second.visibleNumber,
    third.visibleNumber,
  ]);
  // Provisional places do not outlive the result they became.
  assert.deepEqual(published.podium.placements, []);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    0,
  );

  const board = await jsonBody(await api("/api/v1/race-board"), 200, "published podium board");
  assert.deepEqual(board.event.podium.map((entry) => entry.duckNumber), [
    first.visibleNumber,
    second.visibleNumber,
    third.visibleNumber,
  ]);
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete event");
  assert.equal(completed.event.status, "COMPLETED");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("a scanned podium place is idempotent, exclusive, and undoable", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, finalists, finalHeat } = await raceToAwaitingFinal(database, {
    name: "Podium Retry Race",
    slug: "podium-retry-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const scan = podiumScan(api, post);
  const [first, second, third] = finalists;

  const firstScan = await winnerContext(scan, first);
  const commandId = crypto.randomUUID();
  const recorded = await jsonBody(
    await scan.record(first, firstScan.winnerAction, 1, { commandId }),
    201,
    "record first place",
  );
  assert.equal(recorded.replayed, false);

  // A retry of the same scan replays rather than recording a second place or
  // being read as a new command.
  const replay = await jsonBody(
    await scan.record(first, firstScan.winnerAction, 1, { commandId, revision: firstScan.winnerAction.revision }),
    200,
    "replay the same scan",
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.podium.placements.map((placement) => placement.place), [1]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    1,
  );

  // The same identifier for a different duck or a different place is a
  // different operation and is refused.
  const secondScan = await winnerContext(scan, second);
  assert.equal((await scan.record(second, secondScan.winnerAction, 2, { commandId })).status, 409);

  // First place is taken, so nobody else may stand in it.
  const takenPlace = await scan.record(second, secondScan.winnerAction, 1);
  assert.equal(takenPlace.status, 409);
  assert.match((await takenPlace.json()).error, /already taken by another duck/);

  // A duck already on the podium is offered no second place, and asking for one
  // is refused with the way out.
  const standing = await winnerContext(scan, first);
  assert.equal(standing.winnerAction.podium.selectedPlace, 1);
  assert.deepEqual(standing.winnerAction.podium.availablePlaces, []);
  const secondPlaceForFirst = await scan.record(first, standing.winnerAction, 2);
  assert.equal(secondPlaceForFirst.status, 409);
  assert.match((await secondPlaceForFirst.json()).error, /already holds 1st place/);

  // A stale revision — another station recorded a place since this page painted
  // — is refused rather than silently landing on a podium that moved.
  const stale = await scan.record(second, secondScan.winnerAction, 2, {
    revision: secondScan.winnerAction.revision - 1,
  });
  assert.equal(stale.status, 409);

  // Clearing a place hands it back, and the duck that actually finished there
  // can be scanned into it.
  const cleared = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/podium-place/clear`,
    { commandId: crypto.randomUUID(), raceEntryId: first.raceEntryId, place: 1 },
  ), 201, "clear first place");
  assert.deepEqual(cleared.podium.placements, []);
  assert.deepEqual(cleared.podium.availablePlaces, [1, 2, 3]);
  const reopened = await winnerContext(scan, second);
  await jsonBody(await scan.record(second, reopened.winnerAction, 1), 201, "rescan first place");

  // Clearing a place nobody is standing in changes nothing and says so.
  const emptyClear = await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/podium-place/clear`,
    { commandId: crypto.randomUUID(), raceEntryId: third.raceEntryId, place: 3 },
  );
  assert.equal(emptyClear.status, 409);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("a scanned final podium refuses racers who left and never strands the final", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, finalists, finalHeat, leaveRace } = await raceToAwaitingFinal(database, {
    name: "Podium Withdrawal Race",
    slug: "podium-withdrawal-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const scan = podiumScan(api, post);
  const [first, second, third] = finalists;

  const firstScan = await winnerContext(scan, first);
  await jsonBody(await scan.record(first, firstScan.winnerAction, 1), 201, "record first place");
  const secondScan = await winnerContext(scan, second);
  await jsonBody(await scan.record(second, secondScan.winnerAction, 2), 201, "record second place");

  // The last finalist leaves the race with two places already recorded. Their
  // duck is still in the water and still scannable, so the page has to say
  // plainly that it cannot take a place — the same expected outcome the finish
  // line reports, not a failure.
  await leaveRace(third, "withdraw");
  const refusedScan = await scan.inspect(third);
  assert.equal(refusedScan.winnerAction, null);
  assert.equal(refusedScan.winnerIneligible.round, "FINAL");
  assert.equal(refusedScan.winnerIneligible.reason, "DUCK_NOT_ELIGIBLE");
  assert.equal(refusedScan.winnerIneligible.heatId, finalHeat.id);
  // A stale page that fires the command anyway reports the same expected
  // outcome the scan already showed, rather than a bare refusal.
  const currentRevision = (await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final revision before the refused scan")).heat.revision;
  const refused = await post(`/api/v1/staff/ducks/${third.tagToken}/heat-winner`, {
    commandId: crypto.randomUUID(),
    eventId,
    heatId: finalHeat.id,
    raceEntryId: third.raceEntryId,
    revision: currentRevision,
    place: 3,
  });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).reason, "DUCK_NOT_ELIGIBLE");

  // The withdrawal shrank the podium to the two places already standing on it,
  // so no further scan is coming and nothing would ever publish. The finish line
  // is told the podium is complete and given the command that publishes it,
  // rather than being left holding a finished race it cannot record.
  const detail = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final detail after the withdrawal");
  assert.equal(detail.podium.requiredPlaces, 2);
  assert.equal(detail.podium.complete, true);
  assert.deepEqual(detail.podium.placements.map((placement) => placement.place), [1, 2]);

  const publishedPodium = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: detail.heat.revision,
      results: detail.podium.placements.map((placement) => ({
        raceEntryId: placement.raceEntryId,
        place: placement.place,
      })),
    },
  ), 201, "publish the completed scanned podium");
  assert.deepEqual(publishedPodium.results.map((result) => result.place), [1, 2]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    0,
    "publishing consumes the provisional places",
  );
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event on the reduced podium");
  assert.equal(completed.event.status, "COMPLETED");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

// The regression: a recorded place can fall outside the podium without its
// racer going anywhere, because a withdrawal somewhere else on the roster
// shrinks the depth underneath it. That row is invisible to every projection, so
// if the authoritative guard still reads it as "this duck is standing
// somewhere", the duck is offered the open places and refused on every one of
// them, forever, with no control anywhere that can clear it.
test("a recorded place the shrinking podium hides never locks its own duck out", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, finalists, finalHeat, leaveRace } = await raceToAwaitingFinal(database, {
    name: "Podium Shrink Race",
    slug: "podium-shrink-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const scan = podiumScan(api, post);
  const [first, second, third] = finalists;

  const thirdScan = await winnerContext(scan, third);
  await jsonBody(await scan.record(third, thirdScan.winnerAction, 3), 201, "record third place");

  // A finalist nobody has scanned leaves. Third place stops existing, so the
  // place recorded in it stops existing too — but its duck is still racing and
  // still has to be able to take one of the places that remain.
  await leaveRace(first, "withdraw");
  const shrunk = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final detail after the podium shrank");
  assert.equal(shrunk.podium.requiredPlaces, 2);
  assert.deepEqual(shrunk.podium.placements, []);
  assert.deepEqual(shrunk.podium.availablePlaces, [1, 2]);
  assert.equal(shrunk.podium.complete, false);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    1,
    "the hidden row is still in the table",
  );

  // The duck that held the vanished place is offered the places that are left,
  // and taking one actually works.
  const rescan = await winnerContext(scan, third);
  assert.equal(rescan.winnerAction.podium.selectedPlace, null);
  assert.deepEqual(rescan.winnerAction.podium.availablePlaces, [1, 2]);
  const recorded = await jsonBody(
    await scan.record(third, rescan.winnerAction, 2),
    201,
    "the duck whose place vanished takes one that is left",
  );
  assert.deepEqual(recorded.podium.placements.map((placement) => placement.place), [2]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    1,
    "the hidden row is swept, never left standing beside the new one",
  );

  // The reduced podium still publishes, and the event still completes.
  const lastScan = await winnerContext(scan, second);
  const published = await jsonBody(
    await scan.record(second, lastScan.winnerAction, 1),
    201,
    "the last remaining place publishes the reduced podium",
  );
  assert.equal(published.heat.status, "FINALIZED");
  assert.deepEqual(published.results.map((result) => result.place), [1, 2]);
  assert.deepEqual(published.results.map((result) => result.duck.visibleNumber), [
    second.visibleNumber,
    third.visibleNumber,
  ]);
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event on the reduced podium");
  assert.equal(completed.event.status, "COMPLETED");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("scanned podium places are least-privileged, validated, and cleared by a reset", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, finalists, finalHeat } = await raceToAwaitingFinal(database, {
    name: "Podium Authorization Race",
    slug: "podium-authorization-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const scan = podiumScan(api, post);
  const [first, second] = finalists;

  // One place is recorded first, so the denials below are measured against a
  // podium that actually has something in it: a refusal that must neither add a
  // place nor remove the one standing there.
  const allowed = await winnerContext(scan, first);
  await jsonBody(await scan.record(first, allowed.winnerAction, 1), 201, "record with the result role");
  const recordedPlaces = () => database.prepare(
    "SELECT race_entry_id, place FROM final_podium_selections ORDER BY place",
  ).all().map((row) => ({ ...row }));
  const podiumBefore = recordedPlaces();
  assert.deepEqual(podiumBefore, [{ race_entry_id: first.raceEntryId, place: 1 }]);

  // Recording and clearing a podium place are result operations, so they are
  // held to exactly the roles publishing a result is held to.
  database.exec("DELETE FROM staff_role_assignments WHERE staff_profile_id = 'staff' AND role = 'RESULT_TAKER'");
  database.exec("DELETE FROM staff_role_assignments WHERE staff_profile_id = 'staff' AND role = 'RACE_DIRECTOR'");
  const secondScan = await jsonBody(
    await api(`/api/v1/staff/ducks/${second.tagToken}`, { token: staffToken }),
    200,
    "inspect without result roles",
  );
  // A heat runner sees no result action at all, in either round.
  assert.equal(secondScan.winnerAction, null);
  const deniedRecord = await post(`/api/v1/staff/ducks/${second.tagToken}/heat-winner`, {
    commandId: crypto.randomUUID(),
    eventId,
    heatId: finalHeat.id,
    raceEntryId: second.raceEntryId,
    revision: allowed.winnerAction.revision + 1,
    place: 2,
  });
  assert.equal(deniedRecord.status, 403);
  const deniedClear = await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/podium-place/clear`,
    { commandId: crypto.randomUUID(), raceEntryId: first.raceEntryId, place: 1 },
  );
  assert.equal(deniedClear.status, 403);
  assert.deepEqual(
    recordedPlaces(),
    podiumBefore,
    "a denied scan adds no place and removes none",
  );

  database.exec(
    "INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)"
    + " VALUES ('staff-results-again', 'staff', 'RESULT_TAKER', '2026-07-26T00:00:00Z')",
  );

  // A malformed place is refused before any database access, and records
  // nothing.
  for (const place of [0, 4, 1.5, "1", null]) {
    const malformed = await post(`/api/v1/staff/ducks/${second.tagToken}/heat-winner`, {
      commandId: crypto.randomUUID(),
      eventId,
      heatId: finalHeat.id,
      raceEntryId: second.raceEntryId,
      revision: allowed.winnerAction.revision,
      place,
    });
    assert.equal(malformed.status, 400, `place ${JSON.stringify(place)} is refused`);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    1,
    "a malformed place writes nothing",
  );

  // Resetting the heat says the finish did not happen the way it was recorded,
  // so the places its scans collected go with it.
  database.exec(
    "INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)"
    + " VALUES ('staff-director-again', 'staff', 'RACE_DIRECTOR', '2026-07-26T00:00:00Z')",
  );
  const beforeReset = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final before reset");
  assert.equal(beforeReset.podium.placements.length, 1);
  await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/reset`,
    { commandId: crypto.randomUUID(), revision: beforeReset.heat.revision },
  ), 201, "reset the final");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM final_podium_selections").get().count,
    0,
    "a reset throws away the finish its scans described",
  );
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

// The blocker this covers: the final podium is sized by the finalists who can
// still take a place, so a withdrawal reduces it. If any surface keeps demanding
// three places, the third one can never be filled — its duck answers every scan
// with DUCK_NOT_ELIGIBLE — and with no podium the event can never be completed.
// The only honest proof is to publish the reduced podium and complete the event.
test("a final reduced by a withdrawal is still published and the event completed", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const { api, post } = createWorkerHarness(database);

  const created = await jsonBody(await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug: "reduced-podium-race",
    name: "Reduced Podium Race",
    eventDate: "2026-09-12",
    roundOneHeatCapacity: 3,
  }, adminToken), 201, "create event");
  const eventId = created.event.id;
  await jsonBody(await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: created.event.revision,
      roundOneHeatCapacity: 3,
      finalHeatCapacity: 3,
      publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
    },
  }), 200, "configure event");
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "open registration");

  // Nine racers over three heats of three, so round one promotes exactly three
  // finalists: the default layout, and the one where a single withdrawal turns
  // a three-place podium into a two-place one.
  const participants = [];
  for (let index = 0; index < 9; index += 1) {
    const registration = await jsonBody(await post(`/api/v1/staff/events/${eventId}/registrations`, {
      commandId: crypto.randomUUID(),
      privateToken: randomToken(),
      firstName: `Racer${index}`,
      lastName: "Example",
      email: `racer${index}@example.com`,
    }), 201, `walk-up registration ${index}`);
    participants.push({
      registrationId: registration.registration.registrationId,
      lookupCode: registration.registration.lookupCode,
      raceEntryId: registration.registration.raceEntryId,
    });
  }

  for (const participant of participants) {
    const provisioning = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(),
      eventId,
    }), 201, "provision duck");
    participant.visibleNumber = provisioning.visibleNumber;
    participant.tagToken = provisioning.tagUrl.split("/").at(-1);
    await jsonBody(await post("/api/v1/staff/inventory/provisioning/confirm", {
      commandId: crypto.randomUUID(),
      eventId,
      duckId: provisioning.duckId,
      provisioningCommandId: provisioning.provisioningCommandId,
      physicalWriteVerified: true,
    }), 201, "confirm duck");
    const pairing = await jsonBody(await post(`/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }), 201, `pair duck ${participant.visibleNumber}`);
    // A paired racer's duck is in a numbered bag, which is exactly the claim the
    // console makes when it refuses to delete them.
    assert.equal(pairing.heatAssignmentPending, false);
    const detail = await jsonBody(await api(
      `/api/v1/staff/registrations/${participant.registrationId}`,
      { token: staffToken },
    ), 200, "paired registration projection");
    assert.equal(detail.registration.currentlyPaired, true);
    assert.equal(detail.registration.deletable, false);
    assert.equal(detail.registration.heatAssignmentPending, false);
  }

  await jsonBody(await post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "close registration");
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");

  const transition = async (heat, operation) => {
    const body = await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`,
      { commandId: crypto.randomUUID(), revision: heat.revision },
    ), 201, `${operation} heat ${heat.number}`);
    heat.revision = body.heat.revision;
    heat.status = body.heat.status;
  };

  const listed = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list heats");
  const roundOneHeats = listed.heats.filter((heat) => heat.round === "ROUND_ONE");
  assert.equal(roundOneHeats.length, 3);
  for (const heat of roundOneHeats) {
    const detail = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, {
      token: staffToken,
    }), 200, `round-one heat ${heat.number}`);
    heat.revision = detail.heat.revision;
    heat.roster = detail.roster;
    for (const operation of ["ready", "call", "start", "finish"]) await transition(heat, operation);
    const published = await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`,
      {
        commandId: crypto.randomUUID(),
        revision: heat.revision,
        results: [{ raceEntryId: heat.roster[0].raceEntryId, place: 1 }],
      },
    ), 201, `publish round-one heat ${heat.number}`);
    heat.revision = published.heat.revision;
  }

  await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  const finalHeat = (await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list final")).heats.find((heat) => heat.round === "FINAL");
  const finalDetail = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final roster");
  finalHeat.revision = finalDetail.heat.revision;
  assert.equal(finalDetail.roster.length, 3, "three heats promote three finalists");
  assert.ok(finalDetail.roster.every((entry) => entry.eligible === true));
  for (const operation of ["ready", "call", "start", "finish"]) await transition(finalHeat, operation);
  assert.equal(finalHeat.status, "AWAITING_RESULT");

  // A finalist withdraws while the final is awaiting its result. Their duck was
  // bagged before they left, so it stays in the water and on every staff roster.
  const leavingEntryId = finalDetail.roster[1].raceEntryId;
  const leaving = participants.find((participant) => participant.raceEntryId === leavingEntryId);
  const before = await jsonBody(await api(`/api/v1/staff/registrations/${leaving.registrationId}`, {
    token: staffToken,
  }), 200, "load the finalist who is leaving");
  await jsonBody(await post(`/api/v1/staff/registrations/${leaving.registrationId}/withdraw`, {
    commandId: crypto.randomUUID(),
    expectedRevision: before.registration.revision,
  }), 201, "withdraw a finalist mid-final");

  const reducedRoster = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final roster after the withdrawal");
  assert.equal(reducedRoster.roster.length, 3, "no finalist is dropped from a staff roster");
  assert.deepEqual(reducedRoster.roster.map((entry) => entry.eligible), [true, false, true]);
  // Nothing about the heat itself changed, which is exactly why a station that
  // keys its render on the heat alone never repaints.
  assert.equal(reducedRoster.heat.status, "AWAITING_RESULT");
  assert.equal(reducedRoster.heat.revision, finalHeat.revision);

  // The withdrawn finalist's duck is still physically in the water and can still
  // reach the line first, and the scan says so rather than failing.
  const scannedWithdrawn = await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/finish-scan?value=${leaving.visibleNumber}`,
    { token: staffToken },
  );
  assert.equal(scannedWithdrawn.status, 422);
  assert.equal((await scannedWithdrawn.json()).reason, "DUCK_NOT_ELIGIBLE");

  // The old three-place podium is now impossible: the server requires exactly
  // the number of places its eligible finalists can fill, and says which.
  const eligibleEntries = reducedRoster.roster.filter((entry) => entry.eligible);
  const threePlaces = await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: [
        { raceEntryId: eligibleEntries[0].raceEntryId, place: 1 },
        { raceEntryId: eligibleEntries[1].raceEntryId, place: 2 },
        { raceEntryId: leavingEntryId, place: 3 },
      ],
    },
  );
  assert.equal(threePlaces.status, 422, "a three-place podium is refused permanently");
  assert.match((await threePlaces.json()).error, /exactly places 1 through 2\.$/);

  // Two scans, two places, published: the way out of the blocker.
  const podium = [];
  for (const [index, entry] of eligibleEntries.entries()) {
    const participant = participants.find((item) => item.raceEntryId === entry.raceEntryId);
    const scan = await jsonBody(await api(
      `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/finish-scan?value=${participant.visibleNumber}`,
      { token: staffToken },
    ), 200, `scan podium place ${index + 1}`);
    podium.push({ raceEntryId: scan.selection.raceEntryId, place: index + 1 });
  }
  const finalResult = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    { commandId: crypto.randomUUID(), revision: finalHeat.revision, results: podium },
  ), 201, "publish the reduced podium");
  assert.deepEqual(finalResult.results.map((result) => result.place), [1, 2]);
  assert.equal(finalResult.heat.status, "FINALIZED");

  // And the event is no longer stranded: completion is allowed and taken.
  const readiness = await jsonBody(await api(`/api/v1/staff/events/${eventId}/readiness`, {
    token: staffToken,
  }), 200, "completion readiness");
  assert.equal(readiness.readiness.complete.allowed, true, JSON.stringify(readiness.readiness.complete.blockers));
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event");
  assert.equal(completed.event.status, "COMPLETED");

  // The public podium is two deep and never names the racer who left.
  const board = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.deepEqual(board.event.podium.map((entry) => entry.place), [1, 2]);
  assert.equal(
    board.event.podium.some((entry) => entry.duckNumber === leaving.visibleNumber),
    false,
    "the withdrawn finalist is absent from every public surface",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// ---------------------------------------------------------------------------
// A published podium is immutable; the eligible count is not.
// ---------------------------------------------------------------------------
//
// The release blocker these cover: the completion check compared the number of
// published podium places against `MIN(3, eligible finalists)` with `!=`. The
// left side is frozen the moment the podium is finalized. The right side moves
// every time somebody leaves the race, and leaving is allowed at any heat state
// including `FINALIZED`. So disqualifying a winner after the podium was
// published retroactively judged a correct podium "incomplete" and shut every
// exit at once: `complete` refused, the same expression guarded the batch, the
// final result could not be corrected while the event was still `FINAL`, and
// `Reset heat` refuses a published result. The only way out was undoing the
// disqualification — which is exactly the record a race director must keep.
//
// "Disqualify the winner after the race" is the single most likely reason
// `DISQUALIFIED` exists, so each of these drives it through the real endpoints.

test("a podium finisher disqualified after publication never strands the event", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const race = await raceToAwaitingFinal(database, {
    name: "Disqualified Winner Race",
    slug: "disqualified-winner-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const { api, post, eventId, finalHeat, finalists, leaveRace, completionReadiness } = race;
  assert.equal(finalists.length, 3, "three heats promote three finalists");

  const published = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: finalists.map((finalist, index) => ({
        raceEntryId: finalist.raceEntryId,
        place: index + 1,
      })),
    },
  ), 201, "publish the full three-place podium");
  assert.deepEqual(published.results.map((result) => result.place), [1, 2, 3]);
  const publishedFinalRevision = published.heat.revision;

  assert.equal((await completionReadiness()).allowed, true, "completion is allowed before the disqualification");

  // The race director disqualifies the published second place, through the real
  // endpoint, with a real revision. Nothing about the heat or the results moves.
  await leaveRace(finalists[1], "disqualify");
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM heat_results WHERE heat_id = ? AND status = 'FINALIZED'",
    ).get(finalHeat.id).count,
    3,
    "the published podium rows are untouched by a status change",
  );

  // This is the assertion the blocker fails: readiness must still allow it, and
  // must report no blocker at all.
  const after = await completionReadiness();
  assert.deepEqual(after.blockers, [], "a disqualification is never a completion blocker");
  assert.equal(after.allowed, true);

  // And the guarded batch must agree with the preflight, because they now share
  // one expression. A 409 here would mean readiness lied.
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event after disqualifying a podium finisher");
  assert.equal(completed.event.status, "COMPLETED");
  // Completion did not have to renumber, supersede, or delete anything.
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM heat_result_history WHERE event_id = ?",
  ).get(eventId).count, 0);
  assert.equal(database.prepare(
    "SELECT revision FROM heats WHERE id = ?",
  ).get(finalHeat.id).revision, publishedFinalRevision);

  // S4, decided and documented in docs/WORKFLOWS.md: the public podium keeps the
  // historical place numbers, so a disqualified second place leaves a visible
  // gap at places 1 and 3 rather than promoting the third-place racer. Privacy
  // is absolute — the disqualified racer appears nowhere — but renumbering would
  // publish a claim the race never made about who finished second.
  const board = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.deepEqual(board.event.podium.map((entry) => entry.place), [1, 3]);
  assert.deepEqual(
    board.event.podium.map((entry) => entry.duckNumber),
    [finalists[0].visibleNumber, finalists[2].visibleNumber],
  );
  assert.equal(
    board.event.podium.some((entry) => entry.duckNumber === finalists[1].visibleNumber),
    false,
    "the disqualified finisher is absent from every public surface",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a podium finisher who withdraws after publication never strands the event", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const race = await raceToAwaitingFinal(database, {
    name: "Withdrawn Winner Race",
    slug: "withdrawn-winner-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const { api, post, eventId, finalHeat, finalists, leaveRace, completionReadiness } = race;

  await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: finalists.map((finalist, index) => ({
        raceEntryId: finalist.raceEntryId,
        place: index + 1,
      })),
    },
  ), 201, "publish the full three-place podium");

  // The published *winner* leaves. Nothing shallower is worth pinning: if first
  // place can go without stranding the race, no place can.
  await leaveRace(finalists[0], "withdraw");
  const after = await completionReadiness();
  assert.deepEqual(after.blockers, []);
  assert.equal(after.allowed, true);
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event after the winner withdraws");
  assert.equal(completed.event.status, "COMPLETED");

  const board = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.deepEqual(board.event.podium.map((entry) => entry.place), [2, 3]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// The variant that fires without anybody touching the podium at all.
test("withdrawing non-podium finalists below the published depth never strands the event", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const race = await raceToAwaitingFinal(database, {
    name: "Five Finalist Race",
    slug: "five-finalist-race",
    racerCount: 15,
    heatCapacity: 3,
  });
  const { api, post, eventId, finalHeat, finalists, leaveRace, completionReadiness } = race;
  assert.equal(finalists.length, 5, "five heats promote five finalists");

  const published = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: finalists.slice(0, 3).map((finalist, index) => ({
        raceEntryId: finalist.raceEntryId,
        place: index + 1,
      })),
    },
  ), 201, "publish a three-place podium out of five finalists");
  assert.deepEqual(published.results.map((result) => result.place), [1, 2, 3]);

  // Three finalists who hold no place at all leave. The podium is not touched
  // and every published place still belongs to an eligible racer, but the
  // eligible finalist count drops from five to two — below the published depth
  // of three, which is precisely what the `!=` comparison could not survive.
  for (const finalist of finalists.slice(2, 5)) await leaveRace(finalist, "withdraw");
  assert.equal(
    database.prepare(
      `SELECT COUNT(*) AS count FROM heat_entries he
         JOIN race_entries re ON re.id = he.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
        WHERE he.heat_id = ? AND r.status = 'ACTIVE'`,
    ).get(finalHeat.id).count,
    2,
    "two eligible finalists against three published places",
  );

  const after = await completionReadiness();
  assert.deepEqual(after.blockers, []);
  assert.equal(after.allowed, true);
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event with a podium deeper than the eligible count");
  assert.equal(completed.event.status, "COMPLETED");

  const board = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.deepEqual(board.event.podium.map((entry) => entry.place), [1, 2]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// Publication and completion measure the same podium with two different
// comparisons on purpose: exact-on-write, at-least-on-read. This proves they can
// never contradict each other in either direction.
test("whatever a final publication accepts, completion accepts immediately", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const race = await raceToAwaitingFinal(database, {
    name: "Publication Agreement Race",
    slug: "publication-agreement-race",
    racerCount: 9,
    heatCapacity: 3,
  });
  const { post, eventId, finalHeat, finalists, leaveRace, completionReadiness } = race;

  // A finalist leaves before the podium is published, so publication itself
  // sizes the podium at two places.
  await leaveRace(finalists[2], "withdraw");
  const shallow = await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: [{ raceEntryId: finalists[0].raceEntryId, place: 1 }],
    },
  );
  assert.equal(shallow.status, 422, "publication stays exact and refuses a podium that is too shallow");
  assert.match((await shallow.json()).error, /exactly places 1 through 2\.$/);

  await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: [
        { raceEntryId: finalists[0].raceEntryId, place: 1 },
        { raceEntryId: finalists[1].raceEntryId, place: 2 },
      ],
    },
  ), 201, "publish the podium publication itself demanded");
  assert.equal(
    (await completionReadiness()).allowed,
    true,
    "a podium the publisher just accepted is always completable",
  );

  // The one direction that legitimately raises the requirement: reactivating a
  // finalist restores a racer who can hold a place, so the podium genuinely owes
  // them one. Completion says so, names which side is short, and the remedy is
  // reachable rather than circular.
  const reactivated = await jsonBody(await post(
    `/api/v1/staff/registrations/${finalists[2].registrationId}/reactivate`,
    {
      commandId: crypto.randomUUID(),
      expectedRevision: database.prepare(
        "SELECT revision FROM registrations WHERE id = ?",
      ).get(finalists[2].registrationId).revision,
    },
  ), 201, "reactivate the finalist");
  assert.equal(reactivated.registration.status, "ACTIVE");
  const owed = await completionReadiness();
  assert.equal(owed.allowed, false);
  assert.deepEqual(owed.blockers, [
    "A finalized final published fewer podium places than its eligible finalists can fill."
    + " Correct or reopen that final result and publish the full podium.",
  ]);
  const refused = await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  });
  assert.equal(refused.status, 409, "the guarded batch agrees with the preflight");

  // The documented remedy, reachable while the event is still FINAL.
  const currentFinal = await jsonBody(await race.api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final heat before the correction");
  assert.equal(currentFinal.heat.resultCorrectionAllowed, true);
  const corrected = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/correct`,
    {
      commandId: crypto.randomUUID(),
      revision: currentFinal.heat.revision,
      reason: "The third finalist was reactivated and holds the third place.",
      results: [
        { raceEntryId: finalists[0].raceEntryId, place: 1 },
        { raceEntryId: finalists[1].raceEntryId, place: 2 },
        { raceEntryId: finalists[2].raceEntryId, place: 3 },
      ],
    },
  ), 201, "correct the final podium while the event is still FINAL");
  assert.deepEqual(corrected.results.map((result) => result.place), [1, 2, 3]);
  assert.equal((await completionReadiness()).allowed, true);
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete after the correction");
  assert.equal(completed.event.status, "COMPLETED");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

// S1. The same reactivation remedy, run in an event that has already handed one
// duck back to inventory — a spare that turned out not to be needed, released at
// the registration desk with no participant involved.
//
// The released-duck stop used to be `EXISTS (any released event_duck)` for the
// whole event, so that single routine action permanently disabled every final
// correction and reopen for the rest of the race. Combined with the completion
// check it stranded the event outright: `complete` said "correct or reopen that
// final result", `correct` and `reopen` both answered "not once a duck has been
// released from this event", the console offered no form because both
// capabilities projected 0, and `Reset heat` refuses a published result. The
// only exit was re-disqualifying the racer, destroying the record.
//
// The stop is now scoped to the duck assignments the command actually writes or
// supersedes, which is what its own comment always claimed, so a duck released
// somewhere else in the event is irrelevant to this podium.
test("a duck released elsewhere in the event never strands the reactivation remedy", async (context) => {
  const { database } = createDatabase();
  context.after(() => database.close());
  const race = await raceToAwaitingFinal(database, {
    name: "Released Spare Race",
    slug: "released-spare-race",
    racerCount: 9,
    heatCapacity: 3,
    releasedSpareDucks: 1,
  });
  const {
    api,
    post,
    eventId,
    finalHeat,
    finalists,
    leaveRace,
    releasedSpares,
    completionReadiness,
  } = race;
  assert.equal(releasedSpares.length, 1);
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM event_ducks WHERE event_id = ? AND released_at IS NOT NULL",
    ).get(eventId).count,
    1,
    "the event genuinely holds a released duck reservation",
  );

  // A finalist is disqualified before the podium is published, so publication
  // sizes it at two places and accepts exactly that.
  await leaveRace(finalists[2], "disqualify");
  await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    {
      commandId: crypto.randomUUID(),
      revision: finalHeat.revision,
      results: [
        { raceEntryId: finalists[0].raceEntryId, place: 1 },
        { raceEntryId: finalists[1].raceEntryId, place: 2 },
      ],
    },
  ), 201, "publish the two-place podium the eligible count demanded");
  assert.equal((await completionReadiness()).allowed, true);

  // The disqualification is reversed on appeal, which is the one change that
  // raises the requirement.
  await jsonBody(await post(
    `/api/v1/staff/registrations/${finalists[2].registrationId}/reactivate`,
    {
      commandId: crypto.randomUUID(),
      expectedRevision: database.prepare(
        "SELECT revision FROM registrations WHERE id = ?",
      ).get(finalists[2].registrationId).revision,
    },
  ), 201, "reactivate the disqualified finalist");
  const owed = await completionReadiness();
  assert.equal(owed.allowed, false);
  assert.deepEqual(owed.blockers, [
    "A finalized final published fewer podium places than its eligible finalists can fill."
    + " Correct or reopen that final result and publish the full podium.",
  ]);

  // The console is offered the remedy the blocker names, and the server honours
  // it, despite the released spare duck.
  const currentFinal = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "final heat with a released spare duck in the event");
  assert.equal(currentFinal.heat.resultCorrectionAllowed, true);
  assert.equal(currentFinal.heat.resultReopenAllowed, true);
  const corrected = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/correct`,
    {
      commandId: crypto.randomUUID(),
      revision: currentFinal.heat.revision,
      reason: "The disqualification was reversed, so the podium owes a third place.",
      results: [
        { raceEntryId: finalists[0].raceEntryId, place: 1 },
        { raceEntryId: finalists[1].raceEntryId, place: 2 },
        { raceEntryId: finalists[2].raceEntryId, place: 3 },
      ],
    },
  ), 201, "correct the podium in an event holding a released duck");
  assert.deepEqual(corrected.results.map((result) => result.place), [1, 2, 3]);

  // The event completes with the reactivation intact: nobody had to be
  // re-disqualified to get out.
  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete the event without undoing the reactivation");
  assert.equal(completed.event.status, "COMPLETED");
  assert.equal(
    database.prepare("SELECT status FROM registrations WHERE id = ?")
      .get(finalists[2].registrationId).status,
    "ACTIVE",
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM event_ducks WHERE event_id = ? AND released_at IS NOT NULL",
    ).get(eventId).count,
    1,
    "the released spare duck was never quietly re-reserved to make this work",
  );
  const board = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.deepEqual(board.event.podium.map((entry) => entry.place), [1, 2, 3]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("runs the complete race workflow through real API handlers and migrated SQLite", async (context) => {
  const { database, migrationNames } = createDatabase();
  context.after(() => database.close());
  assert.deepEqual(migrationNames, [
    "0001_staff_identity.sql",
    "0002_registration_foundation.sql",
    "0003_assignment_and_heat_status.sql",
    "0004_pairing_status_and_purge.sql",
    "0005_staff_access_management.sql",
    "0006_participant_operations.sql",
    "0007_duck_inventory_operations.sql",
    "0008_event_operations.sql",
    "0009_heat_result_operations.sql",
    "0010_staff_lifecycle.sql",
    "0011_support_operations.sql",
    "0012_staff_role_assignments.sql",
    "0013_followed_collection_entries.sql",
    "0014_simplified_lifecycle_schema.sql",
    "0015_participant_duck_names.sql",
    "0016_locked_final_winner_correction.sql",
    "0017_final_podium_selections.sql",
  ]);

  // Staff identities are infrastructure; all event-domain data is created through API handlers below.
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 'Race Administrator', 1, 1),
      ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES
      ('staff-registration', 'staff', 'REGISTRATION', '2026-07-26T00:00:00Z'),
      ('staff-ducks', 'staff', 'DUCK_MANAGER', '2026-07-26T00:00:00Z'),
      ('staff-announcer', 'staff', 'ANNOUNCER', '2026-07-26T00:00:00Z'),
      ('staff-heats', 'staff', 'HEAT_RUNNER', '2026-07-26T00:00:00Z'),
      ('staff-results', 'staff', 'RESULT_TAKER', '2026-07-26T00:00:00Z'),
      ('staff-director', 'staff', 'RACE_DIRECTOR', '2026-07-26T00:00:00Z');
  `);

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
      idFromName(name) {
        assert.equal(name, "race-updates");
        return "race-updates-id";
      },
      get(id) {
        assert.equal(id, "race-updates-id");
        return {
          async fetch(_input, init) {
            updateSignals.push(JSON.parse(init.body));
            return new Response(null, { status: 204 });
          },
        };
      },
    },
    TURNSTILE_SECRET_KEY: "turnstile-test-secret",
  };
  const updateSignals = [];
  const updateTasks = [];
  const executionContext = {
    waitUntil(promise) { updateTasks.push(promise); },
  };
  const authenticate = (request, currentEnv) => authenticateStaff(request, currentEnv, verifyStaffToken);
  const worker = createWorker(authenticate);
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, executionContext);
  };
  const post = (path, body, token = staffToken) => api(path, { method: "POST", body, token });

  let turnstileChecks = 0;
  context.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    turnstileChecks += 1;
    return Response.json({ success: true, hostname: "quickducks.com" });
  });

  const anonymousCreate = await api("/api/v1/staff/events", {
    method: "POST",
    body: { commandId: crypto.randomUUID(), slug: "annual-race", name: "Annual Race", eventDate: "2026-08-30" },
  });
  assert.equal(anonymousCreate.status, 401);
  const regularCreate = await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug: "annual-race",
    name: "Annual Race",
    eventDate: "2026-08-30",
  });
  assert.equal(regularCreate.status, 403);

  const missingHeatSize = await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug: "annual-race",
    name: "Annual Duck Race",
    eventDate: "2026-08-30",
  }, adminToken);
  assert.equal(missingHeatSize.status, 400);

  const created = await jsonBody(await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    slug: "annual-race",
    name: "Annual Duck Race",
    eventDate: "2026-08-30",
    roundOneHeatCapacity: 4,
  }, adminToken), 201, "create event");
  const eventId = created.event.id;
  assert.equal(created.event.status, "DRAFT");
  // New events default to assigning heats while pairing, sized at creation.
  assert.equal(created.event.heatAssignmentMode, "IMMEDIATE_FIXED");
  assert.equal(created.event.roundOneHeatCapacity, 4);

  // Delete event is the sole cleanup route, even while the event is an empty draft.
  const retiredDraftDelete = await api(`/api/v1/staff/events/${eventId}`, {
    method: "DELETE",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: created.event.revision,
      confirmation: "DELETE Annual Duck Race",
    },
  });
  assert.equal(retiredDraftDelete.status, 404);
  const draftAfterRetiredDelete = await jsonBody(await api(`/api/v1/staff/events/${eventId}`, {
    token: adminToken,
  }), 200, "draft remains after retired delete route");
  assert.equal(draftAfterRetiredDelete.event.status, "DRAFT");

  // The retired balanced mode is refused outright; assigning heats while
  // pairing is the only model.
  const retiredMode = await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: 0,
      heatAssignmentMode: "POST_CLOSE_BALANCED",
    },
  });
  assert.equal(retiredMode.status, 400);
  assert.match((await retiredMode.json()).error, /no other heat assignment mode/i);

  // A heat needs at least three ducks, so a smaller capacity is refused too.
  const tinyHeats = await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: { commandId: crypto.randomUUID(), revision: 0, roundOneHeatCapacity: 2 },
  });
  assert.equal(tinyHeats.status, 400);
  assert.match((await tinyHeats.json()).error, /roundOneHeatCapacity must be an integer between 3 and 10000/);

  const configured = await jsonBody(await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: 0,
      timezone: "America/Denver",
      emailRequired: true,
      heatAssignmentMode: "IMMEDIATE_FIXED",
      roundOneHeatCapacity: 3,
      finalHeatCapacity: 3,
      publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
    },
  }), 200, "configure event");
  assert.equal(configured.event.revision, 1);
  assert.equal(configured.event.heatAssignmentMode, "IMMEDIATE_FIXED");
  assert.equal(configured.event.roundOneHeatCapacity, 3);

  const opened = await jsonBody(await post(`/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "open registration");
  assert.equal(opened.event.status, "REGISTRATION_OPEN");
  const currentOpen = await jsonBody(await api("/api/v1/events/current"), 200, "current open event");
  assert.equal(currentOpen.event.id, eventId);
  assert.equal(currentOpen.event.publicNamePolicy, "FIRST_NAME_LAST_INITIAL");
  assert.equal("finalHeatCapacity" in currentOpen.event, false);
  const openBoard = await jsonBody(await api("/api/v1/race-board"), 200, "open public board");
  assert.equal(openBoard.event.name, "Annual Duck Race");
  assert.deepEqual(openBoard.event.roundOneHeats, []);
  assert.equal(/id|email|phone|token|lookup/i.test(JSON.stringify(openBoard)), false);

  // Nine racers at three per heat fill exactly three round-one heats, which is
  // the smallest layout that still produces a complete three-place final.
  const participantInputs = [
    ["Daisy", "Duck"],
    ["Donald", "Mallard"],
    ["Della", "Drake"],
    ["Dewey", "Bird"],
    ["Huey", "Bird"],
    ["Louie", "Bird"],
    ["Scrooge", "McDuck"],
    ["Webby", "Vanderquack"],
    ["Gyro", "Gearloose"],
  ];
  const participants = [];
  let browserCookie;
  for (const [index, [firstName, lastName]] of participantInputs.entries()) {
    const privateToken = randomToken();
    const registration = await api("/api/v1/registrations", {
      method: "POST",
      cookie: browserCookie,
      headers: { origin: "https://quickducks.com" },
      body: {
        eventId,
        commandId: crypto.randomUUID(),
        privateToken,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}@example.com`,
        phone: `+1555000000${index}`,
        emailNotificationsEnabled: true,
        turnstileToken: `turnstile-${index}`,
      },
    });
    const registrationBody = await jsonBody(registration, 201, `register ${firstName}`);
    const cookieToken = registration.headers.get("set-cookie")?.match(/__Host-quickducks_browser=([^;]+)/)?.[1];
    assert.ok(cookieToken);
    browserCookie = `__Host-quickducks_browser=${cookieToken}`;
    participants.push({
      firstName,
      lastName,
      privateToken,
      registrationId: registrationBody.registrationId,
      lookupCode: registrationBody.lookupCode,
    });
  }
  assert.equal(turnstileChecks, participants.length);
  // Simulate a persisted pre-removal preference; the remaining workflow must ignore it.
  database.prepare(
    "UPDATE race_entries SET duck_keep_preference = 'KEEP' WHERE registration_id = ?",
  ).run(participants[0].registrationId);

  const mineBeforePairing = await jsonBody(await api("/api/v1/registrations/mine", {
    cookie: browserCookie,
  }), 200, "browser registration collection");
  assert.equal(mineBeforePairing.registrations.length, participants.length);
  assert.ok(mineBeforePairing.registrations.every((item) => item.raceStatus.outcome === "AWAITING_DUCK_PAIRING"));
  assert.ok(mineBeforePairing.registrations.every((item) => item.paired === false));
  assert.equal(/email|phone|duckKeepPreference/i.test(JSON.stringify(mineBeforePairing)), false);

  const publicBeforePairing = await jsonBody(await api(
    `/api/v1/race-status/search?eventId=${eventId}&name=Daisy`,
  ), 200, "public unpaired status");
  assert.equal(publicBeforePairing.results[0].outcome, "AWAITING_DUCK_PAIRING");
  assert.equal(/email|phone|lookupCode/i.test(JSON.stringify(publicBeforePairing)), false);

  const anonymousInventory = await api("/api/v1/staff/inventory/ducks");
  assert.equal(anonymousInventory.status, 401);
  for (const participant of participants) {
    const provisioning = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
      commandId: crypto.randomUUID(),
      eventId,
      location: "Race intake",
    }), 201, "start blank NFC provisioning");
    participant.visibleNumber = provisioning.visibleNumber;
    participant.tagToken = provisioning.tagUrl.split("/").at(-1);
    const pendingPublicTag = await jsonBody(
      await api(`/api/v1/ducks/${participant.tagToken}`),
      200,
      "pending tag remains publicly unresolved",
    );
    assert.deepEqual(pendingPublicTag, { destination: "HOME" });

    const intake = await jsonBody(await post("/api/v1/staff/inventory/provisioning/confirm", {
      commandId: crypto.randomUUID(),
      eventId,
      duckId: provisioning.duckId,
      provisioningCommandId: provisioning.provisioningCommandId,
      physicalWriteVerified: true,
    }), 201, `confirm provisioned duck ${participant.visibleNumber}`);
    participant.duckId = intake.duck.id;
    assert.equal(intake.duck.inventoryStatus, "RESERVED_FOR_EVENT");

    const anonymousTag = await jsonBody(await api(`/api/v1/ducks/${participant.tagToken}`), 200, "unpaired tag privacy");
    assert.deepEqual(anonymousTag, { destination: "HOME" });
  }

  const staffRegistrations = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/registrations`,
    { token: staffToken },
  ), 200, "staff registrations");
  // Before pairing, every participant is unpaired, so the console offers Delete
  // and the endpoint would honour it.
  assert.ok(staffRegistrations.registrations.every((item) => item.currentlyPaired === false));
  assert.ok(staffRegistrations.registrations.every((item) => item.deletable === true));

  for (const participant of participants) {
    const detail = staffRegistrations.registrations.find((item) => item.registrationId === participant.registrationId);
    assert.ok(detail);
    participant.raceEntryId = detail.raceEntryId;
    const pairing = await jsonBody(await post(`/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }), 201, `pair duck ${participant.visibleNumber}`);
    // Pairing places the duck straight into the next open heat spot, and the
    // heat it reports is the bag the staffer is told to physically put this
    // duck into. It must therefore be the heat actually written, never one the
    // browser could have derived.
    assert.equal(pairing.heatAssignmentPending, false);
    assert.equal(pairing.heat.round, "ROUND_ONE");
    assert.ok(pairing.heat.number >= 1);
    assert.equal(pairing.duck.visibleNumber, participant.visibleNumber);
    assert.equal(database.prepare(
      `SELECT h.heat_number FROM heat_entries he JOIN heats h ON h.id = he.heat_id
        WHERE he.race_entry_id = ?`,
    ).get(detail.raceEntryId).heat_number, pairing.heat.number, "the reported bag is the stored heat");
    participant.bagHeatNumber = pairing.heat.number;
  }

  const mineAfterPairing = await jsonBody(await api("/api/v1/registrations/mine", {
    cookie: browserCookie,
  }), 200, "paired browser registration collection");
  assert.ok(mineAfterPairing.registrations.every((item) => item.paired === true));
  assert.ok(mineAfterPairing.registrations.every((item) => item.raceStatus.duck !== null));
  assert.equal(/duckKeepPreference/i.test(JSON.stringify(mineAfterPairing)), false);

  // Pairing is the one-way door. The duck is now in a heat bag, so the staff
  // projection stops offering Delete and the delete endpoint refuses with 409,
  // naming withdrawal and disqualification as the remedy instead.
  const pairedRegistrations = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/registrations`,
    { token: staffToken },
  ), 200, "paired staff registrations");
  assert.ok(pairedRegistrations.registrations.every((item) => item.currentlyPaired === true));
  assert.ok(pairedRegistrations.registrations.every((item) => item.deletable === false));
  const refusedDelete = await api(`/api/v1/staff/registrations/${participants[0].registrationId}`, {
    method: "DELETE",
    token: staffToken,
    body: { commandId: crypto.randomUUID(), expectedRevision: 1 },
  });
  assert.equal(refusedDelete.status, 409);
  assert.match((await refusedDelete.json()).error, /Withdraw or disqualify them instead/);

  const duplicatePairing = await post(`/api/v1/staff/ducks/${participants[0].tagToken}/assignments`, {
    commandId: crypto.randomUUID(),
    eventId,
    lookupCode: participants[1].lookupCode,
  });
  assert.equal(duplicatePairing.status, 409);
  assert.deepEqual(database.prepare(
    "SELECT status, COUNT(*) AS count FROM registrations GROUP BY status",
  ).all().map((row) => ({ ...row })), [{ status: "ACTIVE", count: participants.length }]);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM ducks WHERE inventory_status = 'IN_USE'",
  ).get().count, participants.length);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL",
  ).get().count, participants.length);

  const closed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "close registration");
  assert.equal(closed.event.status, "REGISTRATION_CLOSED");
  const closedRegistration = await api("/api/v1/registrations", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId,
      commandId: crypto.randomUUID(),
      privateToken: randomToken(),
      firstName: "Late",
      lastName: "Duck",
      email: "late@example.com",
      turnstileToken: "unused-after-close",
    },
  });
  assert.equal(closedRegistration.status, 409);
  assert.equal(turnstileChecks, participants.length);

  // The retired balanced planner is unrouted, and closing registration left
  // three full heats that need no rebalancing.
  for (const path of ["plan-preview", "plan-commit"]) {
    const retiredPlan = await post(`/api/v1/staff/events/${eventId}/heats/round-one/${path}`, {
      commandId: crypto.randomUUID(),
    });
    assert.equal(retiredPlan.status, 404, `retired ${path}`);
  }
  assert.deepEqual(
    database.prepare(
      `SELECT (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS size
         FROM heats h WHERE h.round = 'ROUND_ONE' ORDER BY h.heat_number`,
    ).all().map((row) => row.size),
    [3, 3, 3],
  );

  const readiness = await jsonBody(await api(`/api/v1/staff/events/${eventId}/readiness`, {
    token: staffToken,
  }), 200, "round one readiness");
  assert.equal(readiness.readiness["start-round-one"].allowed, true);
  const roundStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");
  assert.equal(roundStarted.event.status, "ROUND_ONE");

  // Intake stays open while a round is running. A duck can be deleted mid-race,
  // which puts its participant back in the pairing queue, and a race with no
  // spare duck in inventory would otherwise have no way to finish.
  const lateIntake = await jsonBody(await post("/api/v1/staff/inventory/provisioning", {
    commandId: crypto.randomUUID(),
    eventId,
  }), 201, "mid-race provisioning start");
  assert.match(lateIntake.tagUrl, /^https:\/\/quickducks\.com\/t\//);

  const heatsBody = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list round-one heats");
  const roundOneHeats = heatsBody.heats.filter((heat) => heat.round === "ROUND_ONE");
  assert.equal(roundOneHeats.length, 3);
  const roundBoard = await jsonBody(await api("/api/v1/race-board"), 200, "round-one public board");
  assert.equal(roundBoard.event.status, "ROUND_ONE");
  assert.deepEqual(roundBoard.event.roundOneHeats.map((heat) => heat.number), [1, 2, 3]);

  const transition = async (heat, operation) => {
    const body = await jsonBody(await post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`, {
      commandId: crypto.randomUUID(),
      revision: heat.revision,
    }), 201, `${operation} heat ${heat.number}`);
    heat.revision = body.heat.revision;
    heat.status = body.heat.status;
  };
  // Starting the round already locked every roster, so there is no operator
  // lock step and each heat begins at LOADING.
  for (const heat of roundOneHeats) {
    const detail = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, {
      token: staffToken,
    }), 200, `round-one heat ${heat.number}`);
    heat.roster = detail.roster;
    assert.equal(detail.heat.status, "LOADING", `heat ${heat.number} locks when the round starts`);
    assert.equal(detail.heat.rosterLocked, true);
    heat.revision = detail.heat.revision;
    await transition(heat, "ready");
    await transition(heat, "call");
  }

  await transition(roundOneHeats[0], "start");
  const runningBoard = await jsonBody(await api("/api/v1/race-board"), 200, "running public board");
  assert.deepEqual(runningBoard.event.currentHeat, { round: "ROUND_ONE", number: 1, status: "RUNNING" });
  const concurrentStart = await post(
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeats[1].id}/start`,
    { commandId: crypto.randomUUID(), revision: roundOneHeats[1].revision },
  );
  assert.equal(concurrentStart.status, 409);

  const resetRunning = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeats[0].id}/reset`,
    { commandId: crypto.randomUUID(), revision: roundOneHeats[0].revision },
  ), 201, "reset running heat");
  assert.equal(resetRunning.heat.status, "LOADING");
  assert.equal(resetRunning.heat.startedAt, null);
  assert.equal(resetRunning.heat.rosterLocked, true);
  roundOneHeats[0].revision = resetRunning.heat.revision;
  roundOneHeats[0].status = resetRunning.heat.status;
  const resetDetail = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeats[0].id}`,
    { token: staffToken },
  ), 200, "reset heat detail");
  assert.deepEqual(
    resetDetail.roster.map((entry) => entry.raceEntryId),
    roundOneHeats[0].roster.map((entry) => entry.raceEntryId),
  );
  await transition(roundOneHeats[0], "ready");
  await transition(roundOneHeats[0], "call");
  await transition(roundOneHeats[0], "start");

  for (const heat of roundOneHeats) {
    if (heat.status === "CALLING") await transition(heat, "start");
    await transition(heat, "finish");
    if (heat === roundOneHeats[0]) {
      const pendingResultStart = await post(
        `/api/v1/staff/events/${eventId}/heats/${roundOneHeats[1].id}/start`,
        { commandId: crypto.randomUUID(), revision: roundOneHeats[1].revision },
      );
      assert.equal(pendingResultStart.status, 409);
      assert.match((await pendingResultStart.json()).error, /Publish the official result/i);
    }
    const winner = heat.roster[0].raceEntryId;
    let winningParticipant = participants.find((participant) => participant.raceEntryId === winner);
    const scannedWinner = await jsonBody(await api(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/finish-scan?value=${encodeURIComponent(`https://quickducks.com/t/${winningParticipant.tagToken}`)}`,
      { token: staffToken },
    ), 200, `scan round-one winner ${heat.number}`);
    assert.equal(scannedWinner.selection.raceEntryId, winner);
    assert.equal(scannedWinner.selection.visibleNumber, winningParticipant.visibleNumber);
    if (heat === roundOneHeats[0]) {
      const wrongHeatParticipant = participants.find((participant) => participant.raceEntryId === roundOneHeats[1].roster[0].raceEntryId);
      const wrongHeat = await api(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}/finish-scan?value=${wrongHeatParticipant.visibleNumber}`,
        { token: staffToken },
      );
      assert.equal(wrongHeat.status, 422);
      assert.match((await wrongHeat.json()).error, /not in the selected heat/i);
      const wrongInspection = await jsonBody(await api(
        `/api/v1/staff/ducks/${wrongHeatParticipant.tagToken}`,
        { token: staffToken },
      ), 200, "inspect a duck from the wrong heat");
      assert.equal(wrongInspection.winnerAction, null);
      assert.equal(wrongInspection.winnerIneligible, null);

      // A racer whose duck is already in this heat's bag leaves the race, right
      // here, through the real staff endpoint, while their heat is locked and
      // awaiting its official result. Nobody empties the bag to fish that duck
      // out, so it is still in the water and can still reach the line first.
      const strandedEntryId = heat.roster[1].raceEntryId;
      const stranded = participants.find((item) => item.raceEntryId === strandedEntryId);
      stranded.withdrawn = true;
      const entriesBeforeWithdrawal = database.prepare(
        "SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id",
      ).all().map((row) => ({ ...row }));
      const assignmentsBeforeWithdrawal = database.prepare(
        "SELECT id, race_entry_id, duck_id, valid_to FROM duck_assignments ORDER BY id",
      ).all().map((row) => ({ ...row }));
      const heatsBeforeWithdrawal = database.prepare(
        "SELECT id, status, heat_number, roster_locked_at FROM heats ORDER BY id",
      ).all().map((row) => ({ ...row }));
      const strandedDetail = await jsonBody(await api(
        `/api/v1/staff/registrations/${stranded.registrationId}`,
        { token: staffToken },
      ), 200, "load the racer who is leaving");
      assert.equal(strandedDetail.registration.status, "ACTIVE");
      const withdrawal = await jsonBody(await post(
        `/api/v1/staff/registrations/${stranded.registrationId}/withdraw`,
        { commandId: crypto.randomUUID(), expectedRevision: strandedDetail.registration.revision },
      ), 201, "withdraw a racer whose heat is locked and awaiting its result");
      assert.equal(withdrawal.registration.status, "WITHDRAWN");
      // They still hold their duck: withdrawal is bookkeeping, not unpairing.
      assert.equal(withdrawal.registration.currentlyPaired, true);
      assert.equal(withdrawal.registration.deletable, false);
      assert.deepEqual(
        database.prepare("SELECT id, race_entry_id, duck_id, valid_to FROM duck_assignments ORDER BY id")
          .all().map((row) => ({ ...row })),
        assignmentsBeforeWithdrawal,
      );
      assert.deepEqual(
        database.prepare("SELECT id, status, heat_number, roster_locked_at FROM heats ORDER BY id")
          .all().map((row) => ({ ...row })),
        heatsBeforeWithdrawal,
      );

      // Staff rosters keep showing them, marked, because their duck is in the
      // bag the staff are physically holding. Public surfaces do not.
      const strandedHeatDetail = await jsonBody(await api(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}`,
        { token: staffToken },
      ), 200, "staff roster after a withdrawal");
      const strandedRow = strandedHeatDetail.roster.find((row) => row.raceEntryId === strandedEntryId);
      assert.ok(strandedRow, "the withdrawn racer stays on the staff roster");
      assert.equal(strandedRow.eligible, false);
      assert.equal(strandedRow.participant.registrationStatus, "WITHDRAWN");
      assert.equal(strandedHeatDetail.roster.length, 3);
      const strandedAnnouncer = await jsonBody(await api(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}/announcer-roster`,
        { token: staffToken },
      ), 200, "announcer roster after a withdrawal");
      const announcedStranded = strandedAnnouncer.roster.find((row) => row.raceEntryId === strandedEntryId);
      assert.equal(announcedStranded.eligible, false);
      assert.equal(announcedStranded.registrationStatus, "WITHDRAWN");
      const withdrawnBoard = await jsonBody(await api("/api/v1/race-board"), 200, "board after a withdrawal");
      assert.equal(
        withdrawnBoard.event.roundOneHeats[heat.number - 1].roster
          .some((entry) => entry.duckNumber === stranded.visibleNumber),
        false,
        "the public board stops showing them",
      );

      for (const value of [`https://quickducks.com/t/${stranded.tagToken}`, String(stranded.visibleNumber)]) {
        const ineligibleScan = await api(
          `/api/v1/staff/events/${eventId}/heats/${heat.id}/finish-scan?value=${encodeURIComponent(value)}`,
          { token: staffToken },
        );
        assert.equal(ineligibleScan.status, 422, value);
        const ineligibleBody = await ineligibleScan.json();
        assert.equal(ineligibleBody.reason, "DUCK_NOT_ELIGIBLE", value);
        assert.equal(ineligibleBody.ineligible.registrationStatus, "WITHDRAWN", value);
        assert.equal(ineligibleBody.ineligible.visibleNumber, stranded.visibleNumber, value);
        assert.match(ineligibleBody.error, /scan the next duck to pass the finish line\.$/i, value);
      }
      const strandedInspection = await jsonBody(await api(
        `/api/v1/staff/ducks/${stranded.tagToken}`,
        { token: staffToken },
      ), 200, "inspect a withdrawn duck at the finish line");
      assert.equal(strandedInspection.winnerAction, null);
      assert.equal(strandedInspection.winnerIneligible.registrationStatus, "WITHDRAWN");
      assert.equal(strandedInspection.winnerIneligible.heatNumber, heat.number);
      const forcedWinner = await post(`/api/v1/staff/ducks/${stranded.tagToken}/heat-winner`, {
        commandId: crypto.randomUUID(), eventId,
        heatId: heat.id, raceEntryId: strandedEntryId, revision: heat.revision,
      });
      assert.equal(forcedWinner.status, 422);
      assert.equal((await forcedWinner.json()).reason, "DUCK_NOT_ELIGIBLE");

      // Nothing was written and no heat entry moved: the withdrawn duck keeps
      // its heat and its slot, and so does every other duck in the race.
      assert.deepEqual(
        database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
          .all().map((row) => ({ ...row })),
        entriesBeforeWithdrawal,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM heat_results").get().count, 0);
      // They stay withdrawn for the rest of the race. The heat is published from
      // an eligible duck below, the round finishes, and the final runs.
    }
    const taggedGet = await api(`/t/${winningParticipant.tagToken}`, { token: staffToken });
    assert.equal(taggedGet.status, 303);
    assert.equal(taggedGet.headers.get("location"), `/staff/ducks/${winningParticipant.tagToken}`);
    const inspection = await jsonBody(await api(
      `/api/v1/staff/ducks/${winningParticipant.tagToken}`,
      { token: staffToken },
    ), 200, `inspect round-one winner ${heat.number}`);
    assert.deepEqual(inspection.winnerAction, {
      eventId,
      heatId: heat.id,
      raceEntryId: winner,
      revision: heat.revision,
      heatNumber: heat.number,
      round: "ROUND_ONE",
      participantDisplayName: `${winningParticipant.firstName} ${winningParticipant.lastName[0]}.`,
      // Round one awards one place, so this scan publishes a winner outright
      // and has no podium to choose from. The final's scan does.
      podium: null,
    });
    if (heat === roundOneHeats[0]) {
      const forged = await post(`/api/v1/staff/ducks/${winningParticipant.tagToken}/heat-winner`, {
        commandId: crypto.randomUUID(), eventId,
        heatId: roundOneHeats[1].id, raceEntryId: winner, revision: heat.revision,
      });
      assert.equal(forged.status, 409);
    }
    const winnerCommand = crypto.randomUUID();
    const winnerPayload = {
      commandId: winnerCommand, eventId, heatId: heat.id,
      raceEntryId: winner, revision: heat.revision,
    };
    const finalized = await jsonBody(await post(
      `/api/v1/staff/ducks/${winningParticipant.tagToken}/heat-winner`,
      winnerPayload,
    ), 201, `publish scanned round-one winner ${heat.number}`);
    const replayedWinner = await jsonBody(await post(
      `/api/v1/staff/ducks/${winningParticipant.tagToken}/heat-winner`,
      winnerPayload,
    ), 200, `replay scanned round-one winner ${heat.number}`);
    assert.equal(replayedWinner.replayed, true);
    const winnerAudit = database.prepare(
      "SELECT details_json FROM audit_events WHERE command_id = ? AND action = 'HEAT_RESULT_FINALIZED'",
    ).get(winnerCommand);
    assert.ok(winnerAudit);
    assert.equal(winnerAudit.details_json.includes(winningParticipant.tagToken), false);
    assert.equal(winnerAudit.details_json.includes(winningParticipant.firstName), false);
    assert.equal(winnerAudit.details_json.includes(`${winningParticipant.firstName.toLowerCase()}@example.com`), false);
    heat.revision = finalized.heat.revision;
    heat.status = finalized.heat.status;
    assert.equal(finalized.results.length, 1);
    if (heat === roundOneHeats[0]) {
      // Slot 2 is the racer who withdrew above, so a correction to them is
      // refused as ineligible and the published result is left alone. Slot 3 is
      // the eligible correction target.
      const ineligibleCorrection = await post(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/correct`,
        {
          commandId: crypto.randomUUID(), revision: heat.revision,
          reason: "Attempt to award the heat to the racer who withdrew.",
          results: [{ raceEntryId: heat.roster[1].raceEntryId, place: 1 }],
        },
      );
      assert.equal(ineligibleCorrection.status, 422);
      assert.equal((await ineligibleCorrection.json()).reason, "DUCK_NOT_ELIGIBLE");

      const plannedWinner = heat.roster[2].raceEntryId;
      const plannedCorrection = await jsonBody(await post(
        `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/correct`,
        {
          commandId: crypto.randomUUID(), revision: heat.revision,
          reason: "Finish judge corrected the first heat winner.",
          results: [{ raceEntryId: plannedWinner, place: 1 }],
        },
      ), 201, "correct first winner while final is planned");
      heat.revision = plannedCorrection.heat.revision;
      winningParticipant = participants.find((participant) => participant.raceEntryId === plannedWinner);
      const refreshed = await jsonBody(await api(`/api/v1/staff/events/${eventId}/finalists`, {
        token: staffToken,
      }), 200, "refresh planned finalists");
      assert.equal(refreshed.finalists[0].raceEntryId, plannedWinner);
    }
    const winnerBoard = await jsonBody(await api("/api/v1/race-board"), 200, `published board winner ${heat.number}`);
    assert.equal(winnerBoard.event.roundOneHeats[heat.number - 1].roster[0].duckNumber, winningParticipant.visibleNumber);
    assert.equal(winnerBoard.event.roundOneHeats[heat.number - 1].roster[0].place, 1);
  }

  let finalists = await jsonBody(await api(`/api/v1/staff/events/${eventId}/finalists`, {
    token: staffToken,
  }), 200, "list finalists");
  assert.equal("verification" in finalists, false);
  assert.equal(finalists.finalists.length, 3);
  let finalistIds = finalists.finalists.map((entry) => entry.raceEntryId);
  // The racer who withdrew mid-race was never published as a winner, so they
  // were never promoted, and every finalist is eligible.
  const withdrawnParticipant = participants.find((participant) => participant.withdrawn === true);
  assert.ok(withdrawnParticipant, "one racer withdrew mid-race");
  assert.equal(finalistIds.includes(withdrawnParticipant.raceEntryId), false);
  assert.ok(finalists.finalists.every((entry) => entry.eligible === true));

  // Round one finished with a withdrawn racer still on a locked, raced,
  // published roster, and the final is not blocked by them. Readiness reports
  // them on the round-one rosters without blocking anything.
  const finalReadiness = await jsonBody(await api(`/api/v1/staff/events/${eventId}/readiness`, {
    token: staffToken,
  }), 200, "final readiness with a withdrawn racer on a roster");
  assert.equal(finalReadiness.readiness["start-final"].allowed, true);
  assert.deepEqual(finalReadiness.readiness["start-final"].blockers, []);

  const finalStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  assert.equal(finalStarted.event.status, "FINAL");
  const firstHeat = roundOneHeats[0];
  const loadingWinner = firstHeat.roster[0].raceEntryId;
  const loadingCapability = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${firstHeat.id}`,
    { token: staffToken },
  ), 200, "loading winner correction capability");
  assert.equal(loadingCapability.heat.resultCorrectionAllowed, true);
  const loadingCorrection = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${firstHeat.id}/results/correct`,
    {
      commandId: crypto.randomUUID(), revision: firstHeat.revision,
      reason: "Final preflight confirmed a different first-heat winner.",
      results: [{ raceEntryId: loadingWinner, place: 1 }],
    },
  ), 201, "correct first winner while final is locked loading");
  firstHeat.revision = loadingCorrection.heat.revision;
  finalists = await jsonBody(await api(`/api/v1/staff/events/${eventId}/finalists`, {
    token: staffToken,
  }), 200, "refresh finalists after loading correction");
  finalistIds = finalists.finalists.map((entry) => entry.raceEntryId);
  assert.equal(finalistIds[0], loadingWinner);
  const finalBoard = await jsonBody(await api("/api/v1/race-board"), 200, "planned final public board");
  assert.equal(finalBoard.event.finalHeats.length, 1);
  const finalistNumbers = participants
    .filter((participant) => finalistIds.includes(participant.raceEntryId))
    .map((participant) => participant.visibleNumber)
    .sort((a, b) => a - b);
  assert.deepEqual(finalBoard.event.finalHeats[0].roster.map((entry) => entry.duckNumber).sort((a, b) => a - b), finalistNumbers);
  const finalList = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats`, {
    token: staffToken,
  }), 200, "list final");
  const finalHeat = finalList.heats.find((heat) => heat.round === "FINAL");
  assert.ok(finalHeat);
  // The final locks when the final round starts, for the same reason.
  assert.equal(finalHeat.status, "LOADING");
  assert.equal(finalHeat.rosterLocked, true);
  const refreshedFinalDetail = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "refresh final roster after loading correction");
  assert.equal(refreshedFinalDetail.roster[0].raceEntryId, loadingWinner);
  await transition(finalHeat, "ready");
  const readyCapability = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${firstHeat.id}`,
    { token: staffToken },
  ), 200, "ready winner correction capability");
  assert.equal(readyCapability.heat.resultCorrectionAllowed, false);
  const lateCorrection = await post(
    `/api/v1/staff/events/${eventId}/heats/${firstHeat.id}/results/correct`,
    {
      commandId: crypto.randomUUID(), revision: firstHeat.revision,
      reason: "This change is after final readiness.",
      results: [{ raceEntryId: firstHeat.roster[2].raceEntryId, place: 1 }],
    },
  );
  assert.equal(lateCorrection.status, 409);
  for (const operation of ["call", "start", "finish"]) await transition(finalHeat, operation);
  const podium = [];
  for (const [index, raceEntryId] of finalistIds.entries()) {
    const participant = participants.find((item) => item.raceEntryId === raceEntryId);
    const value = index === 0 ? participant.visibleNumber : `https://quickducks.com/t/${participant.tagToken}`;
    const scan = await jsonBody(await api(
      `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/finish-scan?value=${encodeURIComponent(value)}`,
      { token: staffToken },
    ), 200, `scan final place ${index + 1}`);
    podium.push({ raceEntryId: scan.selection.raceEntryId, place: index + 1 });
  }
  const finalResult = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/results/finalize`,
    { commandId: crypto.randomUUID(), revision: finalHeat.revision, results: podium },
  ), 201, "finalize final");
  assert.deepEqual(finalResult.results.map((result) => result.place), [1, 2, 3]);
  const podiumBoard = await jsonBody(await api("/api/v1/race-board"), 200, "podium public board");
  assert.deepEqual(podiumBoard.event.podium.map((entry) => entry.place), [1, 2, 3]);

  const completed = await jsonBody(await post(`/api/v1/staff/events/${eventId}/complete`, {
    commandId: crypto.randomUUID(),
  }), 201, "complete event");
  assert.equal(completed.event.status, "COMPLETED");
  const completedBoard = await jsonBody(await api("/api/v1/race-board"), 200, "completed public board");
  assert.equal(completedBoard.event.status, "COMPLETED");
  assert.equal(completedBoard.event.currentHeat, null);
  assert.deepEqual(
    completedBoard.event.podium.map((entry) => entry.duckNumber),
    podium.map((entry) => participants.find((participant) => participant.raceEntryId === entry.raceEntryId).visibleNumber),
  );
  assert.equal(/email|phone|lookup|token|staff|note|inventory|audit|raceEntry|assignment/i.test(JSON.stringify(completedBoard)), false);
  const publishedFinal = await jsonBody(await api(
    `/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`,
    { token: staffToken },
  ), 200, "published final result");
  assert.equal(publishedFinal.heat.status, "FINALIZED");
  assert.deepEqual(publishedFinal.results.map((result) => result.raceEntryId), finalistIds);
  assert.equal(/email|phone|lookupCode/i.test(JSON.stringify(publishedFinal)), false);

  for (const participant of participants) {
    // The racer who withdrew mid-race is publicly absent everywhere, including
    // their own duck's tag scan, while their private link still tells them the
    // truth about themselves.
    if (participant.withdrawn === true) {
      assert.deepEqual(
        await (await api(`/api/v1/ducks/${participant.tagToken}`)).json(),
        { destination: "HOME" },
        `withdrawn tag ${participant.firstName}`,
      );
      const withdrawnPrivate = await jsonBody(await api(
        `/api/v1/registrations/${participant.privateToken}`,
      ), 200, `private status ${participant.firstName}`);
      assert.equal(withdrawnPrivate.status, "WITHDRAWN");
      assert.equal(withdrawnPrivate.raceStatus.outcome, "WITHDRAWN");
      // Their duck and heat place are still theirs; nothing was taken away.
      assert.equal(withdrawnPrivate.raceStatus.duck.visibleNumber, participant.visibleNumber);
      assert.equal(withdrawnPrivate.raceStatus.assignedHeat.roundOne.number, participant.bagHeatNumber);
      continue;
    }
    const publicStatus = await jsonBody(await api(`/api/v1/ducks/${participant.tagToken}`), 200, `public status ${participant.firstName}`);
    assert.equal(publicStatus.destination, "RACE_STATUS");
    const podiumIndex = finalistIds.indexOf(participant.raceEntryId);
    const expectedOutcome = podiumIndex === -1
      ? "ELIMINATED"
      : ["FIRST_PLACE", "SECOND_PLACE", "THIRD_PLACE"][podiumIndex];
    assert.equal(publicStatus.raceStatus.outcome, expectedOutcome);
    assert.equal(/email|phone|lookupCode|privateToken/i.test(JSON.stringify(publicStatus)), false);

    const privateStatus = await jsonBody(await api(
      `/api/v1/registrations/${participant.privateToken}`,
    ), 200, `private status ${participant.firstName}`);
    assert.equal(privateStatus.firstName, participant.firstName);
    assert.equal(privateStatus.lookupCode, participant.lookupCode);
    assert.equal(privateStatus.status, "ACTIVE");
    assert.deepEqual(privateStatus.raceStatus.duck, publicStatus.raceStatus.duck);
    assert.deepEqual(privateStatus.raceStatus.assignedHeat, publicStatus.raceStatus.assignedHeat);
    assert.deepEqual(privateStatus.raceStatus.currentHeat, publicStatus.raceStatus.currentHeat);
    assert.equal(privateStatus.raceStatus.outcome, publicStatus.raceStatus.outcome);
    assert.equal("email" in privateStatus, false);
    assert.equal("phone" in privateStatus, false);
    assert.equal("duckKeepPreference" in privateStatus, false);
  }
  const privatePage = await api(`/r/${participants[0].privateToken}`);
  const privatePageBody = await privatePage.text();
  assert.equal(privatePage.status, 200);
  assert.match(privatePageBody, new RegExp(`Duck #${participants[0].visibleNumber}`));
  assert.doesNotMatch(privatePageBody, /daisy@example\.com|\+15550000000/);
  const publicSearch = await jsonBody(await api(
    `/api/v1/race-status/search?eventId=${eventId}&name=Daisy`,
  ), 200, "published public search");
  assert.equal(publicSearch.results.length, 1);
  assert.equal(publicSearch.results[0].participantDisplayName, "Daisy D.");
  assert.equal(/email|phone|lookupCode/i.test(JSON.stringify(publicSearch)), false);

  // COMPLETED is terminal and results stay publicly visible there. Every
  // retired return and purge step is gone, so the only way onward is deletion.
  for (const path of [
    `/api/v1/staff/events/${eventId}/start-return-processing`,
    `/api/v1/staff/events/${eventId}/purge-ready`,
    `/api/v1/staff/events/${eventId}/purge`,
    `/api/v1/staff/support/events/${eventId}/return-batches`,
    `/api/v1/staff/support/events/${eventId}/purge-claim`,
  ]) {
    const retired = await post(path, {
      commandId: crypto.randomUUID(),
      confirmation: "DELETE Annual Duck Race",
      returnReviewCompleted: true,
      permanentDeletionAcknowledged: true,
    }, adminToken);
    assert.equal(retired.status, 404, `retired ${path}`);
  }
  const stillCompleted = await jsonBody(await api(`/api/v1/staff/events/${eventId}`, {
    token: adminToken,
  }), 200, "event stays completed");
  assert.equal(stillCompleted.event.status, "COMPLETED");
  const publicAfterCompletion = await jsonBody(await api("/api/v1/events/current"), 200, "public event at completion");
  assert.equal(publicAfterCompletion.event.status, "COMPLETED");
  const boardAfterCompletion = await jsonBody(await api("/api/v1/race-board"), 200, "public board at completion");
  assert.equal(boardAfterCompletion.event.status, "COMPLETED");

  // Delete event is the only cleanup path, and it stays administrator-only.
  const regularDelete = await post(`/api/v1/staff/events/${eventId}/force-delete`, {
    commandId: crypto.randomUUID(),
    revision: stillCompleted.event.revision,
    confirmName: "Annual Duck Race",
  });
  assert.equal(regularDelete.status, 403);
  const wrongName = await post(`/api/v1/staff/events/${eventId}/force-delete`, {
    commandId: crypto.randomUUID(),
    revision: stillCompleted.event.revision,
    confirmName: "Wrong Race Name",
  }, adminToken);
  assert.equal(wrongName.status, 422);
  const deleted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/force-delete`, {
    commandId: crypto.randomUUID(),
    revision: stillCompleted.event.revision,
    confirmName: "Annual Duck Race",
  }, adminToken), 200, "delete event");
  assert.deepEqual(deleted, { deleted: true, alreadyDeleted: false });

  const purgedTables = [
    "events",
    "registrations",
    "race_entries",
    "ducks",
    "duck_tags",
    "race_commands",
    "audit_events",
    "event_ducks",
    "duck_assignments",
    "duck_inventory_events",
    "heats",
    "heat_entries",
    "heat_results",
    "heat_result_history",
    "browser_registration_collections",
    "browser_collection_registrations",
    "email_notifications",
    "email_attempts",
  ];
  for (const table of purgedTables) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_role_assignments").get().count, 6);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM organization_event_defaults").get().count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  const noCurrentEvent = await jsonBody(await api("/api/v1/events/current"), 200, "no current event after purge");
  assert.deepEqual(noCurrentEvent, { event: null });
  const deletedPrivateStatus = await api(`/api/v1/registrations/${participants[0].privateToken}`);
  assert.equal(deletedPrivateStatus.status, 404);
  const deletedTagStatus = await jsonBody(await api(
    `/api/v1/ducks/${participants[0].tagToken}`,
  ), 200, "deleted tag status");
  assert.deepEqual(deletedTagStatus, { destination: "HOME" });
  const deletedStaffEvent = await api(`/api/v1/staff/events/${eventId}`, { token: adminToken });
  assert.equal(deletedStaffEvent.status, 404);
  const emptyBrowserCollection = await jsonBody(await api("/api/v1/registrations/mine", {
    cookie: browserCookie,
  }), 200, "purged browser collection");
  assert.deepEqual(emptyBrowserCollection, { registrations: [] });
  await Promise.all(updateTasks);
  assert.ok(updateSignals.length > 50);
  assert.deepEqual(Object.keys(updateSignals[0]).sort(), ["domains", "type", "version"]);
  assert.ok(updateSignals.every((signal) => signal.type === "refresh"
    && typeof signal.version === "string"
    && Array.isArray(signal.domains)
    && signal.domains.length > 0
    && signal.domains.every((domain) => LIVE_UPDATE_DOMAINS.includes(domain))));
  assert.ok(updateSignals.some((signal) => signal.domains.includes("all")));
  assert.ok(updateSignals.some((signal) => signal.domains.includes("participants")));
  assert.ok(updateSignals.some((signal) => signal.domains.includes("ducks")));
  assert.ok(updateSignals.some((signal) => signal.domains.includes("heats")));
  assert.equal(/email|phone|lookup|token|firstName|lastName|eventId|duckId|participantId/i.test(JSON.stringify(updateSignals)), false);
});
