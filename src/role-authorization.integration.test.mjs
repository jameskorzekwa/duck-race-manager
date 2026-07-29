import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleApi } from "./api.ts";
import { authenticateStaff } from "./auth.ts";
import { hasAllRoles, hasAnyRole, normalizeOperationalRoles } from "./authorization.ts";
import { createWorker } from "./index.ts";
import { handleStaffLifecycleOperations } from "./staff-lifecycle-operations.ts";

const migrationsUrl = new URL("../db/migrations/", import.meta.url);
const migrationNames = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

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

const d1 = (database) => ({
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

const applyMigrations = (database, names = migrationNames) => {
  for (const name of names) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
};

const json = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

test("shared any/all checks fail closed and allow administrator bypass", () => {
  const regular = {
    id: "regular",
    cognitoSub: "regular-sub",
    email: "regular@example.com",
    displayName: "Regular",
    isSystemAdmin: false,
    roles: ["REGISTRATION"],
    authentication: "bearer",
  };
  assert.equal(hasAnyRole(regular, ["REGISTRATION", "DUCK_MANAGER"]), true);
  assert.equal(hasAllRoles(regular, ["REGISTRATION", "DUCK_MANAGER"]), false);
  assert.equal(hasAnyRole({ ...regular, roles: [] }, ["REGISTRATION"]), false);
  assert.equal(hasAllRoles({ ...regular, isSystemAdmin: true, roles: [] }, ["REGISTRATION", "RACE_DIRECTOR"]), true);
});

// One strict reader now covers both caller-supplied and stored role lists.
// Anything outside the current vocabulary invalidates the whole list rather
// than being silently dropped, so a corrupt stored set denies instead of
// authorizing a guessed subset. `staff_role_assignments` constrains `role` to
// exactly this vocabulary, so these inputs are unrepresentable in D1.
test("role normalization is strict, exact, and rejects anything outside the vocabulary", () => {
  // Non-strings can never match an enum member and must not throw.
  assert.equal(normalizeOperationalRoles([null]), null);
  assert.equal(normalizeOperationalRoles([0]), null);
  assert.equal(normalizeOperationalRoles([undefined]), null);
  // Prototype keys are values, not lookups: nothing is inherited or granted.
  assert.equal(normalizeOperationalRoles(["__proto__"]), null);
  assert.equal(normalizeOperationalRoles(["constructor"]), null);
  // Matching is exact and case-sensitive.
  assert.equal(normalizeOperationalRoles(["registration"]), null);
  assert.equal(normalizeOperationalRoles(["REGISTRATION "]), null);
  // Duplicates are rejected rather than collapsed.
  assert.equal(normalizeOperationalRoles(["REGISTRATION", "REGISTRATION"]), null);
  // The retired vocabulary is rejected exactly like any other unknown value.
  assert.equal(normalizeOperationalRoles(["RETURN_STEWARD"]), null);
  assert.equal(normalizeOperationalRoles(["RACE_DIRECTOR", "RETURN_STEWARD"]), null);
  // Valid lists normalize to canonical enum order.
  assert.deepEqual(normalizeOperationalRoles([]), []);
  assert.deepEqual(
    normalizeOperationalRoles(["RACE_DIRECTOR", "REGISTRATION"]),
    ["REGISTRATION", "RACE_DIRECTOR"],
  );
  // An empty projection can never satisfy a required-role check.
  const roleless = {
    id: "roleless",
    cognitoSub: "roleless-sub",
    email: "roleless@example.com",
    displayName: "Roleless",
    isSystemAdmin: false,
    roles: normalizeOperationalRoles([]),
    authentication: "bearer",
  };
  assert.equal(hasAnyRole(roleless, ["REGISTRATION", "DUCK_MANAGER", "RACE_DIRECTOR"]), false);
});

test("0012 does not seed existing regular staff and enforces normalized role constraints", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  // Migrations are ordered, so an upgrade test for 0012 applies only 0001-0011.
  applyMigrations(database, migrationNames.slice(0, migrationNames.indexOf("0012_staff_role_assignments.sql")));
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES
      ('admin', 'admin-sub', 'admin@example.com', 1),
      ('legacy-staff', 'legacy-sub', 'legacy@example.com', 0);
  `);
  applyMigrations(database, ["0012_staff_role_assignments.sql"]);

  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'legacy-staff' AND revoked_at IS NULL",
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'admin'",
  ).get().count, 0);
  assert.throws(() => database.exec(`
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('bad-role', 'legacy-staff', 'ADMIN', '2026-07-26T00:00:00Z');
  `), /CHECK constraint failed/);
  database.exec(`
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('valid-role', 'legacy-staff', 'REGISTRATION', '2026-07-26T00:00:00Z');
  `);
  assert.throws(() => database.exec(`
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('duplicate-role', 'legacy-staff', 'REGISTRATION', '2026-07-27T00:00:00Z');
  `), /UNIQUE constraint failed/);
  assert.throws(() => database.exec(`
    INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
    VALUES ('missing-profile', 'missing', 'REGISTRATION', '2026-07-26T00:00:00Z');
  `), /FOREIGN KEY constraint failed/);
  assert.throws(
    () => database.exec("UPDATE staff_profiles SET is_active = 0 WHERE id = 'admin'"),
    /at least one active system administrator is required/,
  );
  database.close();
});

test("station roles enforce the complete operational matrix with live D1 actors", async (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);

  const profiles = {
    admin: ["admin", "admin-sub", "admin@example.com", 1],
    registration: ["registration", "registration-sub", "registration@example.com", 0],
    ducks: ["ducks", "ducks-sub", "ducks@example.com", 0],
    announcer: ["announcer", "announcer-sub", "announcer@example.com", 0],
    heats: ["heats", "heats-sub", "heats@example.com", 0],
    results: ["results", "results-sub", "results@example.com", 0],
    director: ["director", "director-sub", "director@example.com", 0],
    none: ["none", "none-sub", "none@example.com", 0],
  };
  const roleByProfile = {
    registration: "REGISTRATION",
    ducks: "DUCK_MANAGER",
    announcer: "ANNOUNCER",
    heats: "HEAT_RUNNER",
    results: "RESULT_TAKER",
    director: "RACE_DIRECTOR",
  };
  const insertProfile = database.prepare(
    "INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [name, [id, sub, email, isAdmin]] of Object.entries(profiles)) {
    insertProfile.run(id, sub, email, name, isAdmin);
  }
  const insertRole = database.prepare(
    "INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at) VALUES (?, ?, ?, ?)",
  );
  for (const [profileId, role] of Object.entries(roleByProfile)) {
    insertRole.run(`${profileId}-${role}`, profileId, role, "2026-07-26T00:00:00Z");
  }

  const env = {
    APP_ORIGIN: "https://quickducks.com",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_REGION: "us-east-1",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_USER_POOL_CLIENT_ID: "client-example",
    COGNITO_DOMAIN: "https://quickducks-staff.example.com",
    DB: d1(database),
    EMAIL_QUEUE: { async send() {} },
    PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const loadActor = (sub) => authenticateStaff(
    new Request("https://quickducks.com/api/v1/staff/events", {
      headers: { authorization: "Bearer valid.test.token" },
    }),
    env,
    async () => ({ sub }),
  );
  const actors = {};
  for (const [name, [, sub]] of Object.entries(profiles)) actors[name] = await loadActor(sub);
  assert.deepEqual(actors.admin.roles, []);
  assert.deepEqual(actors.registration.roles, ["REGISTRATION"]);
  assert.deepEqual(actors.none.roles, []);
  assert.equal(actors.none.isSystemAdmin, false);
  // The retired role is no longer representable, so it cannot be assigned to a
  // profile and then read back as a session role.
  assert.throws(() => database.exec(
    `INSERT INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
     VALUES ('none-returns', 'none', 'RETURN_STEWARD', '2026-07-26T00:00:00Z')`,
  ), /CHECK constraint failed/);

  const api = (actor, path, options = {}) => {
    const headers = new Headers({ authorization: "Bearer test.actor.token" });
    let body;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    return handleApi(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, async () => actor);
  };
  const post = (actor, path, body) => api(actor, path, { method: "POST", body });
  const command = () => crypto.randomUUID();

  assert.equal((await post(actors.director, "/api/v1/staff/events", {
    commandId: command(), slug: "role-race", name: "Role Race", eventDate: "2026-08-30",
  })).status, 403);
  assert.equal((await api(actors.none, "/api/v1/staff/events")).status, 403);

  const created = await json(await post(actors.admin, "/api/v1/staff/events", {
    commandId: command(), slug: "role-race", name: "Role Race", eventDate: "2026-08-30",
    roundOneHeatCapacity: 10,
  }), 201, "administrator creates draft");
  const eventId = created.event.id;
  await json(await api(actors.admin, `/api/v1/staff/events/${eventId}/configuration`, {
    method: "PATCH",
    body: { commandId: command(), revision: 0, heatAssignmentMode: "IMMEDIATE_FIXED" },
  }), 200, "administrator configures immediate heats");
  await json(await post(actors.director, `/api/v1/staff/events/${eventId}/open-registration`, {
    commandId: command(),
  }), 201, "race director opens registration");

  const duckOneToken = "a".repeat(32);
  const duckTwoToken = "b".repeat(32);
  // A heat needs at least three ducks before round one can start.
  const fillerTokens = ["d".repeat(32), "e".repeat(32)];
  const intake = async (number, tagToken) => json(await post(
    actors.ducks,
    "/api/v1/staff/inventory/ducks",
    {
      commandId: command(), eventId, visibleNumber: number, tagToken,
      condition: "GOOD", location: "Race tent", notes: null, physicallyPresent: true,
    },
  ), 201, `duck manager intakes duck ${number}`);
  await intake(101, duckOneToken);
  await intake(102, duckTwoToken);
  for (const [index, token] of fillerTokens.entries()) await intake(200 + index, token);
  assert.equal((await api(actors.registration, "/api/v1/staff/inventory/ducks")).status, 403);

  const walkUp = await json(await post(
    actors.registration,
    `/api/v1/staff/events/${eventId}/registrations`,
    {
      commandId: command(), privateToken: "c".repeat(43), firstName: "Daisy", lastName: "Duck",
      email: "daisy@example.com", phone: "555-0100", emailNotificationsEnabled: true,
      notes: "Role matrix test",
    },
  ), 201, "registration creates walk-up");
  const registrationId = walkUp.registration.registrationId;
  const raceEntryId = walkUp.registration.raceEntryId;
  const lookupCode = walkUp.registration.lookupCode;
  const search = await json(await api(
    actors.registration,
    `/api/v1/staff/registrations/search?eventId=${eventId}&q=${lookupCode}`,
  ), 200, "registration searches participants");
  assert.equal(search.registrations[0].email, "daisy@example.com");
  assert.equal((await api(actors.ducks, `/api/v1/staff/events/${eventId}/registrations`)).status, 403);

  await json(await post(actors.registration, `/api/v1/staff/ducks/${duckOneToken}/assignments`, {
    commandId: command(), eventId, lookupCode,
  }), 201, "registration pairs scanned duck");
  // Two more paired racers bring the single heat up to the minimum heat size.
  for (const [index, token] of fillerTokens.entries()) {
    const filler = await json(await post(
      actors.registration,
      `/api/v1/staff/events/${eventId}/registrations`,
      {
        commandId: command(), privateToken: String.fromCharCode(102 + index).repeat(43),
        firstName: `Filler${index}`, lastName: "Duck", email: null, phone: null,
        emailNotificationsEnabled: false, notes: null,
      },
    ), 201, `registration creates filler ${index}`);
    await json(await post(actors.registration, `/api/v1/staff/ducks/${token}/assignments`, {
      commandId: command(), eventId, lookupCode: filler.registration.lookupCode,
    }), 201, `registration pairs filler ${index}`);
  }
  const inventory = await json(await api(actors.ducks, "/api/v1/staff/inventory/ducks"), 200, "duck manager inspects inventory");
  assert.equal(JSON.stringify(inventory).includes("daisy@example.com"), false);
  assert.equal(JSON.stringify(inventory).includes("Daisy"), false);

  // Moderating a participant-chosen duck name is registration work. Every other
  // operational role, including the duck manager who may hold the duck, is
  // refused it.
  for (const [label, actor] of [
    ["duck manager", actors.ducks],
    ["announcer", actors.announcer],
    ["heat runner", actors.heats],
    ["result taker", actors.results],
  ]) {
    assert.equal(
      (await post(actor, `/api/v1/staff/registrations/${registrationId}/clear-duck-name`, {
        commandId: command(),
      })).status,
      403,
      `${label} cannot clear a duck name`,
    );
  }
  await json(await post(
    actors.registration,
    `/api/v1/staff/registrations/${registrationId}/clear-duck-name`,
    { commandId: command() },
  ), 200, "registration clears a duck name");

  const heats = await json(await api(actors.announcer, `/api/v1/staff/events/${eventId}/heats`), 200, "announcer lists heats");
  const roundOneHeatId = heats.heats[0].id;
  const announcerDetail = await json(await api(
    actors.announcer, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}`,
  ), 200, "announcer reads heat detail");
  assert.equal(JSON.stringify(announcerDetail).includes("daisy@example.com"), false);
  assert.equal(JSON.stringify(announcerDetail).includes("555-0100"), false);
  assert.equal((await post(actors.announcer, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/lock`, {
    commandId: command(), revision: 0,
  })).status, 403);

  // An actor with no operational roles reaches nothing, including the duck scan
  // the retired steward role used to unlock and every other station's read.
  for (const path of [
    `/api/v1/staff/ducks/${duckOneToken}`,
    `/api/v1/staff/registrations/${registrationId}`,
    `/api/v1/staff/events/${eventId}/heats`,
    "/api/v1/staff/inventory/ducks",
    `/api/v1/staff/support/events/${eventId}/summary`,
  ]) {
    assert.equal((await api(actors.none, path)).status, 403, `roleless actor denied ${path}`);
  }

  // Every race-control surface a race director exists to use lives inside the
  // `/staff` Admin view, so the page has to open for them. `is_system_admin` is
  // an account type, not a race-day role; `RACE_DIRECTOR` is the race-day role
  // for changing the state of the overall race, and this actor holds only that.
  const staffPage = async (actor, path) => {
    const response = await createWorker(async () => actor).fetch(
      new Request(`https://quickducks.com${path}`),
      env,
    );
    return { status: response.status, location: response.headers.get("location"), body: await response.text() };
  };
  assert.equal(actors.director.isSystemAdmin, false, "the matrix director is not an administrator");
  const directorConsole = await staffPage(actors.director, "/staff");
  assert.equal(directorConsole.status, 200, "a race director opens the Admin view");
  assert.match(directorConsole.body, /<a href="\/staff" aria-current="page">Admin<\/a>/);
  for (const view of ["event", "heats", "participants"]) {
    assert.match(
      directorConsole.body,
      new RegExp(`<section class="console-section" id="${view}"[^>]* data-role-allowed="true"`),
      view,
    );
  }
  // Administrator-only surfaces stay administrator-only inside that view.
  assert.doesNotMatch(directorConsole.body, /<section class="console-section" id="support"/);
  assert.doesNotMatch(directorConsole.body, /data-event-create-form|data-event-config-form|data-force-delete-form/);
  assert.equal((await staffPage(actors.director, "/staff/access")).status, 403);
  // A staffer with neither is still sent to a page they can use rather than
  // being shown a console they cannot drive.
  const announcerLanding = await staffPage(actors.announcer, "/staff");
  assert.equal(announcerLanding.status, 303);
  assert.equal(announcerLanding.location, "/staff/announcer");
  // And a role-less account gets a page that says so instead of a dead end.
  const rolelessLanding = await staffPage(actors.none, "/staff");
  assert.equal(rolelessLanding.status, 200);
  assert.match(rolelessLanding.body, /No operational roles assigned/);

  await json(await post(actors.director, `/api/v1/staff/events/${eventId}/close-registration`, {
    commandId: command(),
  }), 201, "race director closes registration");
  await json(await post(actors.director, `/api/v1/staff/events/${eventId}/start-round-one`, {
    commandId: command(),
  }), 201, "race director starts round one");

  // Starting the round locked the roster, so the heat runner picks up at
  // LOADING with no lock step of its own.
  const lockedHeat = await json(await api(
    actors.heats, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}`,
  ), 200, "heat runner reads the locked heat");
  assert.equal(lockedHeat.heat.status, "LOADING");
  assert.equal(lockedHeat.heat.rosterLocked, true);
  let revision = lockedHeat.heat.revision;
  for (const transition of ["ready", "call", "start"]) {
    const result = await json(await post(
      actors.heats,
      `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/${transition}`,
      { commandId: command(), revision },
    ), 201, `heat runner ${transition}`);
    revision = result.heat.revision;
  }
  for (const [label, deniedActor] of [
    ["announcer", actors.announcer],
    ["heat runner", actors.heats],
    ["result taker", actors.results],
    ["roleless actor", actors.none],
  ]) {
    assert.equal((await post(
      deniedActor,
      `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/reset`,
      { commandId: command(), revision },
    )).status, 403, `${label} cannot reset a heat`);
  }
  let reset = await json(await post(
    actors.director,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/reset`,
    { commandId: command(), revision },
  ), 201, "race director resets heat");
  assert.equal(reset.heat.status, "LOADING");
  revision = reset.heat.revision;
  for (const transition of ["ready", "call", "start"]) {
    const result = await json(await post(
      actors.heats,
      `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/${transition}`,
      { commandId: command(), revision },
    ), 201, `heat runner repeats ${transition}`);
    revision = result.heat.revision;
  }
  reset = await json(await post(
    actors.admin,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/reset`,
    { commandId: command(), revision },
  ), 201, "administrator resets heat");
  assert.equal(reset.heat.status, "LOADING");
  revision = reset.heat.revision;
  for (const transition of ["ready", "call", "start"]) {
    const result = await json(await post(
      actors.heats,
      `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/${transition}`,
      { commandId: command(), revision },
    ), 201, `heat runner repeats ${transition} after admin reset`);
    revision = result.heat.revision;
  }
  assert.equal((await post(actors.heats, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/finish`, {
    commandId: command(), revision,
  })).status, 403);
  assert.equal((await post(actors.results, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/start`, {
    commandId: command(), revision,
  })).status, 403);

  let finished = await json(await post(
    actors.results,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/finish`,
    { commandId: command(), revision },
  ), 201, "result taker finishes round-one heat");
  assert.equal((await api(
    actors.heats,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/finish-scan?value=101`,
  )).status, 403);
  const selectedWinner = await json(await api(
    actors.results,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/finish-scan?value=101`,
  ), 200, "result taker validates finish-line duck");
  assert.equal(selectedWinner.selection.raceEntryId, raceEntryId);
  assert.equal(JSON.stringify(selectedWinner).includes("daisy@example.com"), false);
  const inspection = await json(await api(
    actors.results,
    `/api/v1/staff/ducks/${duckOneToken}`,
  ), 200, "result taker inspects scanned winner");
  assert.equal(inspection.winnerAction.heatId, roundOneHeatId);
  assert.equal(inspection.winnerAction.raceEntryId, raceEntryId);
  assert.deepEqual(Object.keys(inspection.assignment.participant), ["registrationStatus"]);
  assert.equal(/email|phone|lookup|duckName|registrationId/i.test(JSON.stringify(inspection)), false);
  const winnerPayload = {
    commandId: command(),
    eventId,
    heatId: roundOneHeatId,
    raceEntryId,
    revision: finished.heat.revision,
  };
  assert.equal((await post(
    actors.registration,
    `/api/v1/staff/ducks/${duckOneToken}/heat-winner`,
    winnerPayload,
  )).status, 403);
  const finalized = await json(await post(
    actors.results,
    `/api/v1/staff/ducks/${duckOneToken}/heat-winner`,
    winnerPayload,
  ), 201, "result taker publishes scanned round-one winner");
  const replayedWinner = await json(await post(
    actors.results,
    `/api/v1/staff/ducks/${duckOneToken}/heat-winner`,
    winnerPayload,
  ), 200, "result taker replays scanned winner command");
  assert.equal(replayedWinner.replayed, true);
  assert.equal((await post(
    actors.results,
    `/api/v1/staff/ducks/${duckOneToken}/heat-winner`,
    { ...winnerPayload, raceEntryId: "forged-entry" },
  )).status, 409);
  assert.equal((await post(
    actors.results,
    `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/results/finalize`,
    { commandId: command(), revision: finished.heat.revision, results: [{ raceEntryId, place: 1 }] },
  )).status, 403);
  assert.equal(JSON.stringify(finalized).includes("daisy@example.com"), false);
  assert.equal((await post(actors.results, `/api/v1/staff/events/${eventId}/heats/${roundOneHeatId}/results/correct`, {
    commandId: command(), revision: finalized.heat.revision, reason: "Neighbor denial", results: [{ raceEntryId, place: 1 }],
  })).status, 403);

  await json(await post(actors.director, `/api/v1/staff/events/${eventId}/start-final`, {
    commandId: command(),
  }), 201, "race director starts final");
  const finalList = await json(await api(actors.announcer, `/api/v1/staff/events/${eventId}/heats`), 200, "announcer reads final state");
  const finalHeat = finalList.heats.find((heat) => heat.round === "FINAL");
  const finalHeatId = finalHeat.id;
  // Starting the final locked its roster too.
  assert.equal(finalHeat.status, "LOADING");
  assert.equal(finalHeat.rosterLocked, true);
  revision = finalHeat.revision;
  for (const transition of ["ready", "call", "start"]) {
    const result = await json(await post(
      actors.heats,
      `/api/v1/staff/events/${eventId}/heats/${finalHeatId}/${transition}`,
      { commandId: command(), revision },
    ), 201, `heat runner final ${transition}`);
    revision = result.heat.revision;
  }
  finished = await json(await post(actors.results, `/api/v1/staff/events/${eventId}/heats/${finalHeatId}/finish`, {
    commandId: command(), revision,
  }), 201, "result taker finishes final");
  await json(await post(actors.results, `/api/v1/staff/events/${eventId}/heats/${finalHeatId}/results/finalize`, {
    commandId: command(), revision: finished.heat.revision, results: [{ raceEntryId, place: 1 }],
  }), 201, "result taker finalizes podium");
  await json(await post(actors.director, `/api/v1/staff/events/${eventId}/complete`, {
    commandId: command(),
  }), 201, "race director completes event");

  // COMPLETED is terminal. Every retired return and purge route is gone for
  // every actor, including the administrator, and nothing advances past it.
  // "return-review" is no longer a route; it is just an unknown event id, so
  // a roleless actor is denied and role holders get a plain not-found.
  assert.equal((await api(actors.none, "/api/v1/staff/events/return-review")).status, 403);
  for (const actorName of ["director", "admin"]) {
    const response = await api(actors[actorName], "/api/v1/staff/events/return-review");
    assert.equal(response.status, 404, `${actorName} return-review`);
    assert.equal((await response.json()).error, "Event not found.");
  }
  for (const [actorName, path] of [
    ["director", `/api/v1/staff/ducks/${duckOneToken}/dispositions`],
    ["admin", `/api/v1/staff/events/${eventId}/ducks/102/dispositions`],
    ["admin", `/api/v1/staff/support/events/${eventId}/return-batches`],
    ["admin", `/api/v1/staff/support/events/${eventId}/return-batches/batch_test/items`],
    ["admin", `/api/v1/staff/support/events/${eventId}/return-batches/batch_test/undo-last`],
    ["admin", `/api/v1/staff/support/events/${eventId}/return-batches/batch_test/finalize`],
    ["admin", `/api/v1/staff/support/events/${eventId}/purge-claim`],
    ["admin", `/api/v1/staff/events/${eventId}/purge-ready`],
    ["admin", `/api/v1/staff/events/${eventId}/purge-ready/cancel`],
    ["admin", `/api/v1/staff/events/${eventId}/purge`],
    ["director", `/api/v1/staff/events/${eventId}/start-return-processing`],
  ]) {
    const response = await post(actors[actorName], path, {
      commandId: command(),
      eventId,
      disposition: "RETURNED",
      visibleNumber: 102,
      confirmation: "DELETE Role Matrix Race",
      returnReviewCompleted: true,
      permanentDeletionAcknowledged: true,
      reason: "correction reason",
    });
    assert.equal(response.status, 404, `${actorName} POST ${path}`);
  }
  assert.equal((await api(actors.admin, `/api/v1/staff/support/events/${eventId}/purge-gate`)).status, 404);

  // The event stays COMPLETED and its results stay readable.
  const stillCompleted = await json(await api(actors.announcer, `/api/v1/staff/events/${eventId}`), 200, "event after returns removal");
  assert.equal(stillCompleted.event.status, "COMPLETED");

  assert.equal((await api(actors.director, `/api/v1/staff/support/events/${eventId}/summary`)).status, 403);
  assert.equal((await api(actors.admin, "/api/v1/staff/inventory/ducks")).status, 200);
  assert.equal((await api(actors.admin, `/api/v1/staff/support/events/${eventId}/summary`)).status, 200);

  const roleCommandId = command();
  const changed = await json(await post(actors.admin, "/api/v1/staff/profiles/none/role", {
    commandId: roleCommandId, role: "STAFF", roles: ["ANNOUNCER"], revision: 0,
  }), 200, "administrator assigns announcer role");
  assert.deepEqual(changed.staff.roles, ["ANNOUNCER"]);
  assert.equal(changed.staff.roleRevision, 1);
  const replayed = await json(await post(actors.admin, "/api/v1/staff/profiles/none/role", {
    commandId: roleCommandId, role: "STAFF", roles: ["ANNOUNCER"], revision: 0,
  }), 200, "role change replay");
  assert.equal(replayed.replayed, true);
  const changedActor = await loadActor("none-sub");
  assert.deepEqual(changedActor.roles, ["ANNOUNCER"]);
  assert.equal((await api(changedActor, `/api/v1/staff/events/${eventId}/heats`)).status, 200);
  assert.equal((await api(changedActor, `/api/v1/staff/events/${eventId}/registrations`)).status, 403);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_lifecycle_audit_events WHERE target_staff_profile_id = 'none' AND action = 'STAFF_ROLE_CHANGED'",
  ).get().count, 1);

  const identityCalls = [];
  const identity = {
    async disable(email) { identityCalls.push(["disable", email]); },
    async enable(email) { identityCalls.push(["enable", email]); },
    async globalSignOut(email) { identityCalls.push(["globalSignOut", email]); },
  };
  const lifecycleRequest = (action) => new Request(
    `https://quickducks.com/api/v1/staff/profiles/none/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: command() }),
    },
  );
  await json(await handleStaffLifecycleOperations(
    lifecycleRequest("deactivate"), env, actors.admin, identity,
  ), 200, "deactivate preserves role history");
  assert.equal(await loadActor("none-sub"), null);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM staff_role_assignments WHERE staff_profile_id = 'none' AND revoked_at IS NULL",
  ).get().count, 1);
  await json(await handleStaffLifecycleOperations(
    lifecycleRequest("reactivate"), env, actors.admin, identity,
  ), 200, "reactivate restores assigned roles");
  assert.deepEqual((await loadActor("none-sub")).roles, ["ANNOUNCER"]);
  assert.deepEqual(identityCalls, [
    ["disable", "none@example.com"],
    ["globalSignOut", "none@example.com"],
    ["enable", "none@example.com"],
  ]);
});
