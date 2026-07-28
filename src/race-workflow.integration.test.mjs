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
  for (const participant of participants) {
    const detail = staffRegistrations.registrations.find((item) => item.registrationId === participant.registrationId);
    assert.ok(detail);
    participant.raceEntryId = detail.raceEntryId;
    const pairing = await jsonBody(await post(`/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: participant.lookupCode,
    }), 201, `pair duck ${participant.visibleNumber}`);
    // Pairing places the duck straight into the next open heat spot.
    assert.equal(pairing.heatAssignmentPending, false);
    assert.ok(pairing.heat.number >= 1);
    assert.equal(pairing.duck.visibleNumber, participant.visibleNumber);
  }

  const mineAfterPairing = await jsonBody(await api("/api/v1/registrations/mine", {
    cookie: browserCookie,
  }), 200, "paired browser registration collection");
  assert.ok(mineAfterPairing.registrations.every((item) => item.paired === true));
  assert.ok(mineAfterPairing.registrations.every((item) => item.raceStatus.duck !== null));
  assert.equal(/duckKeepPreference/i.test(JSON.stringify(mineAfterPairing)), false);

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
      const plannedWinner = heat.roster[1].raceEntryId;
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

  const finalStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  assert.equal(finalStarted.event.status, "FINAL");
  const firstHeat = roundOneHeats[0];
  const loadingWinner = firstHeat.roster[2].raceEntryId;
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
      results: [{ raceEntryId: firstHeat.roster[0].raceEntryId, place: 1 }],
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
