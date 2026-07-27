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
      ('staff-returns', 'staff', 'RETURN_STEWARD', '2026-07-26T00:00:00Z'),
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

  // The legacy balanced mode remains available through draft configuration.
  const configured = await jsonBody(await api(`/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    token: adminToken,
    body: {
      commandId: crypto.randomUUID(),
      revision: 0,
      timezone: "America/Denver",
      emailRequired: true,
      heatAssignmentMode: "POST_CLOSE_BALANCED",
      roundOneHeatCapacity: 2,
      finalHeatCapacity: 3,
      publicNamePolicy: "FIRST_NAME_LAST_INITIAL",
    },
  }), 200, "configure event");
  assert.equal(configured.event.revision, 1);
  assert.equal(configured.event.roundOneHeatCapacity, 2);

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

  const participantInputs = [
    ["Daisy", "Duck"],
    ["Donald", "Mallard"],
    ["Della", "Drake"],
    ["Dewey", "Bird"],
    ["Huey", "Bird"],
    ["Louie", "Bird"],
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
    assert.equal(pairing.heatAssignmentPending, true);
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

  const preview = await jsonBody(await post(
    `/api/v1/staff/events/${eventId}/heats/round-one/plan-preview`,
    {},
  ), 200, "preview round one");
  assert.equal(preview.balanced, true);
  assert.deepEqual(preview.heats.map((heat) => heat.size), [2, 2, 2]);
  await jsonBody(await post(`/api/v1/staff/events/${eventId}/heats/round-one/plan-commit`, {
    commandId: crypto.randomUUID(),
    fingerprint: preview.fingerprint,
  }), 201, "commit round one");

  const readiness = await jsonBody(await api(`/api/v1/staff/events/${eventId}/readiness`, {
    token: staffToken,
  }), 200, "round one readiness");
  assert.equal(readiness.readiness["start-round-one"].allowed, true);
  const roundStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");
  assert.equal(roundStarted.event.status, "ROUND_ONE");

  const lateIntake = await post("/api/v1/staff/inventory/provisioning", {
    commandId: crypto.randomUUID(),
    eventId,
  });
  assert.equal(lateIntake.status, 409);

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
  for (const heat of roundOneHeats) {
    const detail = await jsonBody(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, {
      token: staffToken,
    }), 200, `round-one heat ${heat.number}`);
    heat.roster = detail.roster;
    await transition(heat, "lock");
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
    const winningParticipant = participants.find((participant) => participant.raceEntryId === winner);
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
    }
    const finalized = await jsonBody(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`,
      {
        commandId: crypto.randomUUID(),
        revision: heat.revision,
        results: [{ raceEntryId: winner, place: 1 }],
      },
    ), 201, `finalize round-one heat ${heat.number}`);
    heat.revision = finalized.heat.revision;
    heat.status = finalized.heat.status;
    assert.equal(finalized.results.length, 1);
    const winnerBoard = await jsonBody(await api("/api/v1/race-board"), 200, `published board winner ${heat.number}`);
    assert.equal(winnerBoard.event.roundOneHeats[heat.number - 1].roster.find((entry) => entry.place === 1).duckNumber, winningParticipant.visibleNumber);
  }

  const finalists = await jsonBody(await api(`/api/v1/staff/events/${eventId}/finalists`, {
    token: staffToken,
  }), 200, "verify finalists");
  assert.equal(finalists.verification.verified, true);
  assert.equal(finalists.finalists.length, 3);
  const finalistIds = finalists.finalists.map((entry) => entry.raceEntryId);

  const finalStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  assert.equal(finalStarted.event.status, "FINAL");
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
  for (const operation of ["lock", "ready", "call", "start", "finish"]) {
    await transition(finalHeat, operation);
  }
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

  const returnsStarted = await jsonBody(await post(`/api/v1/staff/events/${eventId}/start-return-processing`, {
    commandId: crypto.randomUUID(),
  }), 201, "start return processing");
  assert.equal(returnsStarted.event.status, "RETURN_PROCESSING");
  const regularPurgeReady = await post(`/api/v1/staff/events/${eventId}/purge-ready`, {
    commandId: crypto.randomUUID(),
    returnReviewCompleted: true,
    permanentDeletionAcknowledged: true,
  });
  assert.equal(regularPurgeReady.status, 403);
  const unresolvedPurgeReady = await post(`/api/v1/staff/events/${eventId}/purge-ready`, {
    commandId: crypto.randomUUID(),
    returnReviewCompleted: true,
    permanentDeletionAcknowledged: true,
  }, adminToken);
  assert.equal(unresolvedPurgeReady.status, 409);

  const returnBatch = await jsonBody(await post(
    `/api/v1/staff/support/events/${eventId}/return-batches`,
    { commandId: crypto.randomUUID() },
  ), 201, "create return batch");
  const dispositions = ["RETURNED", "KEPT", "DAMAGED", "MISSING", "QUARANTINED", "RETIRED"];
  for (const [index, participant] of participants.entries()) {
    await jsonBody(await post(
      `/api/v1/staff/support/events/${eventId}/return-batches/${returnBatch.batch.id}/items`,
      {
        commandId: crypto.randomUUID(),
        visibleNumber: participant.visibleNumber,
        disposition: dispositions[index],
      },
    ), 201, `stage disposition ${participant.visibleNumber}`);
  }
  const finalizedReturns = await jsonBody(await post(
    `/api/v1/staff/support/events/${eventId}/return-batches/${returnBatch.batch.id}/finalize`,
    { commandId: crypto.randomUUID() },
  ), 201, "finalize returns");
  assert.equal(finalizedReturns.batch.status, "FINALIZED");
  assert.equal(finalizedReturns.batch.itemCount, participants.length);

  const returnReview = await jsonBody(await api("/api/v1/staff/events/return-review", {
    token: staffToken,
  }), 200, "return review");
  assert.equal(returnReview.review.totalDucks, participants.length);
  assert.equal(returnReview.review.unresolvedDucks, 0);
  assert.equal(returnReview.review.unreleasedDucks, 0);
  assert.equal(returnReview.review.hasActiveAssignment, false);
  assert.deepEqual(returnReview.review.dispositions, Object.fromEntries(dispositions.map((value) => [value, 1])));
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM event_ducks WHERE released_at IS NULL",
  ).get().count, 0);
  assert.deepEqual(database.prepare(
    "SELECT inventory_status FROM ducks ORDER BY visible_number",
  ).all().map((row) => row.inventory_status), [
    "AVAILABLE", "KEPT", "DAMAGED", "MISSING", "QUARANTINED", "RETIRED",
  ]);

  const purgeReady = await jsonBody(await post(`/api/v1/staff/events/${eventId}/purge-ready`, {
    commandId: crypto.randomUUID(),
    returnReviewCompleted: true,
    permanentDeletionAcknowledged: true,
  }, adminToken), 201, "mark purge ready");
  assert.equal(purgeReady.event.status, "ARCHIVED");
  const purgeGate = await jsonBody(await api(
    `/api/v1/staff/support/events/${eventId}/purge-gate`,
    { token: adminToken },
  ), 200, "purge gate");
  assert.equal(purgeGate.ready, true);
  assert.ok(Object.values(purgeGate.blockers).every((value) => value === false || value === 0));

  const regularClaim = await post(`/api/v1/staff/support/events/${eventId}/purge-claim`, {
    commandId: crypto.randomUUID(),
    confirmation: "DELETE Annual Duck Race",
  });
  assert.equal(regularClaim.status, 403);
  await jsonBody(await post(`/api/v1/staff/support/events/${eventId}/purge-claim`, {
    commandId: crypto.randomUUID(),
    confirmation: "DELETE Annual Duck Race",
  }, adminToken), 201, "claim purge");
  const regularPurge = await post(`/api/v1/staff/events/${eventId}/purge`, {
    confirmation: "DELETE Annual Duck Race",
  });
  assert.equal(regularPurge.status, 403);
  const purge = await post(`/api/v1/staff/events/${eventId}/purge`, {
    confirmation: "DELETE Annual Duck Race",
  }, adminToken);
  assert.equal(purge.status, 204);
  assert.equal(purge.headers.get("clear-site-data"), '"cache", "cookies", "storage"');

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
    "duck_event_dispositions",
    "duck_inventory_events",
    "heats",
    "heat_entries",
    "heat_results",
    "heat_result_history",
    "browser_registration_collections",
    "browser_collection_registrations",
    "return_batches",
    "return_batch_items",
    "email_notifications",
    "email_attempts",
    "event_purge_claims",
  ];
  for (const table of purgedTables) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM staff_profiles").get().count, 2);
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
