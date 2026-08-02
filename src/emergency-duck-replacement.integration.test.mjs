import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { authenticateStaff } from "./auth.ts";
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

const createDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_.+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES
      ('admin', 'admin-sub', 'admin@example.test', 'Administrator', 1, 1),
      ('staff', 'staff-sub', 'staff@example.test', 'Race staff', 0, 1),
      ('duck-only', 'duck-only-sub', 'duck@example.test', 'Duck staff', 0, 1);
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at) VALUES
      ('staff-registration', 'staff', 'REGISTRATION', '2026-08-01T00:00:00Z'),
      ('staff-ducks', 'staff', 'DUCK_MANAGER', '2026-08-01T00:00:00Z'),
      ('staff-heats', 'staff', 'HEAT_RUNNER', '2026-08-01T00:00:00Z'),
      ('staff-results', 'staff', 'RESULT_TAKER', '2026-08-01T00:00:00Z'),
      ('staff-director', 'staff', 'RACE_DIRECTOR', '2026-08-01T00:00:00Z'),
      ('duck-only-role', 'duck-only', 'DUCK_MANAGER', '2026-08-01T00:00:00Z');
  `);
  return database;
};

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

const staffToken = "staff.test.token";
const adminToken = "admin.test.token";
const duckOnlyToken = "duck.only.test.token";
const verify = async (token) => {
  if (token === adminToken) return { sub: "admin-sub" };
  if (token === staffToken) return { sub: "staff-sub" };
  if (token === duckOnlyToken) return { sub: "duck-only-sub" };
  throw new Error("invalid test token");
};

const harness = (database) => {
  const env = {
    APP_ORIGIN: "https://quickducks.com",
    AWS_ACCESS_KEY_ID: "test",
    AWS_REGION: "us-east-1",
    AWS_SECRET_ACCESS_KEY: "test",
    COGNITO_USER_POOL_ID: "us-east-1_test",
    COGNITO_USER_POOL_CLIENT_ID: "test-client",
    COGNITO_DOMAIN: "https://staff.example.test",
    DB: createD1(database),
    EMAIL_QUEUE: { async send() {} },
    PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
    TURNSTILE_SECRET_KEY: "test-secret",
  };
  const worker = createWorker((request, currentEnv) => authenticateStaff(request, currentEnv, verify));
  const api = (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie) headers.set("cookie", `__Host-quickducks_staff=${options.token ?? staffToken}`);
    else headers.set("authorization", `Bearer ${options.token ?? staffToken}`);
    if (options.origin !== null) headers.set("origin", options.origin ?? "https://quickducks.com");
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, { waitUntil() {} });
  };
  return { api, post: (path, body, options = {}) => api(path, { ...options, method: "POST", body }) };
};

const body = async (response, status, label) => {
  const value = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(value)}`);
  return value;
};

const transition = async (post, eventId, heat, operation) => {
  const result = await body(await post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`, {
    commandId: crypto.randomUUID(),
    revision: heat.revision,
  }), 201, `${operation} heat ${heat.number}`);
  Object.assign(heat, result.heat);
};

const buildRoundOne = async (database, participantCount) => {
  const { api, post } = harness(database);
  const created = await body(await post("/api/v1/staff/events", {
    commandId: crypto.randomUUID(),
    name: `Emergency replacement ${participantCount}`,
    eventDate: "2026-09-12",
    // Current event creation and readiness both require at least three ducks.
    roundOneHeatCapacity: 3,
  }, { token: adminToken }), 201, "create event");
  const eventId = created.event.id;
  await body(await post(`/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "open registration");

  const participants = [];
  for (let index = 0; index < participantCount; index += 1) {
    const registration = await body(await post(`/api/v1/staff/events/${eventId}/registrations`, {
      commandId: crypto.randomUUID(),
      privateToken: randomToken(),
      firstName: `Replacement${index}`,
      lastName: "Racer",
      email: `replacement${index}@example.test`,
    }), 201, `register participant ${index}`);
    const tagToken = randomToken();
    const intake = await body(await post("/api/v1/staff/inventory/ducks", {
      commandId: crypto.randomUUID(),
      eventId,
      visibleNumber: 200 + index,
      tagToken,
      physicallyPresent: true,
    }), 201, `intake duck ${index}`);
    await body(await post(`/api/v1/staff/ducks/${tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId,
      lookupCode: registration.registration.lookupCode,
    }), 201, `pair duck ${index}`);
    participants.push({
      firstName: `Replacement${index}`,
      registrationId: registration.registration.registrationId,
      raceEntryId: registration.registration.raceEntryId,
      tagToken,
      duckId: intake.duck.id,
      visibleNumber: intake.duck.visibleNumber,
    });
  }
  const spareToken = randomToken();
  const spare = await body(await post("/api/v1/staff/inventory/ducks", {
    commandId: crypto.randomUUID(),
    eventId,
    visibleNumber: 900,
    tagToken: spareToken,
    physicallyPresent: true,
  }), 201, "intake spare duck");
  await body(await post(`/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  }), 201, "close registration");
  await body(await post(`/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }), 201, "start round one");
  return { api, post, eventId, participants, spare: { ...spare.duck, tagToken: spareToken } };
};

const replacementContext = async (api, eventId, spare, firstName) => {
  const search = await body(await api(
    `/api/v1/staff/registrations/replacement-search?eventId=${eventId}&q=${firstName}`,
  ), 200, "search replacement candidates");
  assert.equal(search.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(search), /email|phone|lookupCode|tagToken|notes|location/i);
  const candidate = search.candidates[0];
  const inspection = await body(await api(`/api/v1/staff/ducks/${spare.tagToken}`), 200, "inspect spare");
  return {
    candidate,
    payload: {
      commandId: crypto.randomUUID(),
      eventId,
      raceEntryId: candidate.raceEntryId,
      expectedAssignmentId: candidate.currentAssignment.id,
      expectedReplacementReservationId: inspection.duck.reservationId,
      expectedEventStatus: candidate.event.status,
      expectedEventRevision: candidate.event.revision,
      expectedHeatId: candidate.currentHeat.id,
      expectedHeatRevision: candidate.currentHeat.revision,
      expectedRegistrationRevision: candidate.registrationRevision,
      expectedRaceEntryRevision: candidate.raceEntryRevision,
      expectedCurrentDuckRevision: candidate.currentAssignment.duckRevision,
      expectedReplacementDuckRevision: inspection.duck.revision,
      incidentType: "LOST",
    },
  };
};

test("a round-one emergency replacement is atomic, revision-safe, and replayable", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, participants, spare } = await buildRoundOne(database, 3);
  const participant = participants[0];
  const { candidate, payload } = await replacementContext(api, eventId, spare, participant.firstName);
  const rosterBefore = database.prepare(
    "SELECT id, heat_id, slot_number FROM heat_entries WHERE race_entry_id = ? AND round = 'ROUND_ONE'",
  ).get(participant.raceEntryId);

  await body(await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, {
    ...payload,
    commandId: "not-a-v4-command",
  }), 400, "reject malformed command id");
  const staleCommandId = crypto.randomUUID();
  await body(await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, {
    ...payload,
    commandId: staleCommandId,
    expectedCurrentDuckRevision: payload.expectedCurrentDuckRevision + 1,
  }), 409, "reject stale current-duck revision");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE id = ?").get(staleCommandId).count, 0);
  const pairedReplacement = await body(
    await api(`/api/v1/staff/ducks/${participants[1].tagToken}`),
    200,
    "inspect an already-paired replacement",
  );
  await body(await post(`/api/v1/staff/ducks/${participants[1].tagToken}/replacement`, {
    ...payload,
    commandId: crypto.randomUUID(),
    expectedReplacementReservationId: pairedReplacement.duck.reservationId,
    expectedReplacementDuckRevision: pairedReplacement.duck.revision,
  }), 409, "reject an already-paired replacement duck");

  const blockedOrigin = await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, payload, {
    cookie: true,
    origin: null,
  });
  assert.equal(blockedOrigin.status, 403);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE id = ?").get(payload.commandId).count, 0);

  const denied = await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, payload, {
    token: duckOnlyToken,
  });
  assert.equal(denied.status, 403);

  const replaced = await body(
    await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, payload),
    201,
    "replace round-one duck",
  );
  assert.equal(replaced.replayed, false);
  assert.equal(replaced.oldDuck.visibleNumber, participant.visibleNumber);
  assert.equal(replaced.newDuck.visibleNumber, spare.visibleNumber);
  assert.equal(replaced.roundOneHeat.number, candidate.roundOneHeat.number);
  assert.deepEqual(
    database.prepare("SELECT id, heat_id, slot_number FROM heat_entries WHERE race_entry_id = ? AND round = 'ROUND_ONE'").get(participant.raceEntryId),
    rosterBefore,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_assignments WHERE race_entry_id = ? AND valid_to IS NULL").get(participant.raceEntryId).count, 1);
  assert.equal(database.prepare("SELECT end_reason FROM duck_assignments WHERE id = ?").get(candidate.currentAssignment.id).end_reason, "EMERGENCY_REPLACED");
  assert.equal(database.prepare("SELECT inventory_status FROM ducks WHERE id = ?").get(participant.duckId).inventory_status, "MISSING");

  const retry = await body(
    await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, payload),
    200,
    "replay replacement",
  );
  assert.equal(retry.replayed, true);
  assert.equal(retry.assignmentId, replaced.assignmentId);
  await body(
    await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, { ...payload, incidentType: "DAMAGED" }),
    409,
    "reject changed command material",
  );

  const newInspection = await body(await api(`/api/v1/staff/ducks/${spare.tagToken}`), 200, "inspect replacement tag");
  const oldInspection = await body(await api(`/api/v1/staff/ducks/${participant.tagToken}`), 200, "inspect old tag");
  assert.equal(newInspection.assignment.raceEntryId, participant.raceEntryId);
  assert.equal(oldInspection.assignment, null);
  assert.equal(oldInspection.winnerAction, null);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a finalist keeps advancement and the replacement tag owns the valid podium workflow", async (context) => {
  const database = createDatabase();
  context.after(() => database.close());
  const { api, post, eventId, participants, spare } = await buildRoundOne(database, 9);
  const roundOne = (await body(await api(`/api/v1/staff/events/${eventId}/heats`), 200, "list round one")).heats
    .filter((heat) => heat.round === "ROUND_ONE");
  for (const heat of roundOne) {
    const detail = await body(await api(`/api/v1/staff/events/${eventId}/heats/${heat.id}`), 200, "round-one roster");
    heat.revision = detail.heat.revision;
    for (const operation of ["ready", "call", "start", "finish"]) await transition(post, eventId, heat, operation);
    const recorded = await body(await post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`, {
      commandId: crypto.randomUUID(),
      revision: heat.revision,
      results: [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }],
    }), 201, "record round-one winner");
    Object.assign(heat, recorded.heat);
    const announced = await body(await post(
      `/api/v1/staff/events/${eventId}/heats/${heat.id}/winner-announced`,
      { commandId: crypto.randomUUID(), revision: heat.revision },
    ), 201, "confirm round-one winner announced");
    Object.assign(heat, announced.heat);
  }
  await body(await post(`/api/v1/staff/events/${eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  }), 201, "start final");
  const finalHeat = (await body(await api(`/api/v1/staff/events/${eventId}/heats`), 200, "list final")).heats
    .find((heat) => heat.round === "FINAL");
  const finalDetail = await body(await api(`/api/v1/staff/events/${eventId}/heats/${finalHeat.id}`), 200, "final roster");
  const finalist = participants.find((candidate) => candidate.raceEntryId === finalDetail.roster[0].raceEntryId);
  finalHeat.revision = finalDetail.heat.revision;
  for (const operation of ["ready", "call", "start", "finish"]) await transition(post, eventId, finalHeat, operation);
  const oldWinnerInspection = await body(
    await api(`/api/v1/staff/ducks/${finalist.tagToken}`),
    200,
    "inspect finalist before replacement",
  );
  await body(await post(`/api/v1/staff/ducks/${finalist.tagToken}/heat-winner`, {
    commandId: crypto.randomUUID(),
    eventId,
    heatId: oldWinnerInspection.winnerAction.heatId,
    raceEntryId: finalist.raceEntryId,
    revision: oldWinnerInspection.winnerAction.revision,
    place: 1,
  }), 201, "record a provisional final place before replacement");
  const { candidate, payload } = await replacementContext(api, eventId, spare, finalist.firstName);
  assert.ok(candidate.roundOneHeat.place === 1);
  assert.equal(candidate.finalHeat.id, finalHeat.id);
  const finalSlotBefore = database.prepare(
    "SELECT id, heat_id, slot_number FROM heat_entries WHERE race_entry_id = ? AND round = 'FINAL'",
  ).get(finalist.raceEntryId);

  await body(await post(`/api/v1/staff/ducks/${spare.tagToken}/replacement`, {
    ...payload,
    incidentType: "DAMAGED",
  }), 201, "replace finalist duck");
  assert.deepEqual(database.prepare(
    "SELECT id, heat_id, slot_number FROM heat_entries WHERE race_entry_id = ? AND round = 'FINAL'",
  ).get(finalist.raceEntryId), finalSlotBefore);
  assert.equal(database.prepare(
    "SELECT duck_assignment_id FROM heat_results WHERE race_entry_id = ? AND heat_id <> ?",
  ).get(finalist.raceEntryId, finalHeat.id).duck_assignment_id, candidate.currentAssignment.id);

  const replacementInspection = await body(await api(`/api/v1/staff/ducks/${spare.tagToken}`), 200, "inspect finalist replacement");
  assert.equal(replacementInspection.winnerAction.raceEntryId, finalist.raceEntryId);
  assert.equal(replacementInspection.winnerAction.round, "FINAL");
  assert.equal(replacementInspection.winnerAction.podium.selectedPlace, 1);
  assert.equal(replacementInspection.winnerAction.podium.placements
    .find((placement) => placement.raceEntryId === finalist.raceEntryId).visibleNumber, spare.visibleNumber);
  const oldInspection = await body(await api(`/api/v1/staff/ducks/${finalist.tagToken}`), 200, "inspect superseded finalist tag");
  assert.equal(oldInspection.assignment, null);
  assert.equal(oldInspection.winnerAction, null);
  await body(await post(`/api/v1/staff/events/${eventId}/heats/${finalHeat.id}/podium-place/clear`, {
    commandId: crypto.randomUUID(),
    raceEntryId: finalist.raceEntryId,
    place: 1,
  }), 201, "clear the carried provisional place");
  const rescannedReplacement = await body(
    await api(`/api/v1/staff/ducks/${spare.tagToken}`),
    200,
    "rescan replacement after clearing its place",
  );
  await body(await post(`/api/v1/staff/ducks/${spare.tagToken}/heat-winner`, {
    commandId: crypto.randomUUID(),
    eventId,
    heatId: rescannedReplacement.winnerAction.heatId,
    raceEntryId: finalist.raceEntryId,
    revision: rescannedReplacement.winnerAction.revision,
    place: 1,
  }), 201, "record replacement as a valid final place");
  assert.equal(database.prepare(
    "SELECT duck_assignment_id FROM final_podium_selections WHERE heat_id = ? AND race_entry_id = ?",
  ).get(finalHeat.id, finalist.raceEntryId).duck_assignment_id, rescannedReplacement.assignment.id);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
