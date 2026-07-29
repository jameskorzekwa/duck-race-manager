import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createWorker } from "./index.ts";
import { randomToken } from "./registration.ts";

// Real migrated SQLite behind the real Worker handlers. Every data path in this
// file — following from a scanned tag, following from a duck number, removing a
// followed link, and naming an owned duck — is exercised end to end so the
// guarded writes, the projections, and the rendered pages are all checked
// against the same schema production runs.

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
  for (const name of readdirSync(migrationsUrl).filter((item) => /^\d{4}_.+\.sql$/.test(item)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  return database;
};

const seedEvent = (database, status = "REGISTRATION_OPEN") => {
  database.exec(`
    INSERT INTO events (id, slug, name, event_date, timezone, status, public_name_policy)
    VALUES ('event-ducks', 'duck-race', 'Duck Race', '2026-08-30', 'America/Denver',
            '${status}', 'FIRST_NAME_LAST_INITIAL');
    INSERT INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES ('staff', 'staff-sub', 'staff@example.com', 'Race Staff', 0, 1);
  `);
};

const staffActor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Race Staff",
  isSystemAdmin: false,
  roles: ["REGISTRATION", "DUCK_MANAGER"],
  authentication: "bearer",
};

const makeEnv = (database, rateLimited = false) => ({
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
  DB: createD1(database),
  EMAIL_QUEUE: { async send() {} },
  PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: !rateLimited }; } },
  TURNSTILE_SECRET_KEY: "turnstile-test-secret",
});

const jsonBody = async (response, status, label) => {
  const body = await response.json();
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
  return body;
};

const cookieFrom = (response) => {
  const token = response.headers.get("set-cookie")?.match(/__Host-quickducks_browser=([^;]+)/)?.[1];
  assert.ok(token, "expected a browser collection cookie");
  return `__Host-quickducks_browser=${token}`;
};

const harness = (context, { rateLimited = false } = {}) => {
  const database = createDatabase();
  context.after(() => database.close());
  const env = makeEnv(database, rateLimited);
  const call = (worker) => (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie !== undefined) headers.set("cookie", options.cookie);
    let body;
    if (options.body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    return worker.fetch(new Request(`https://quickducks.com${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }), env, { waitUntil() {} });
  };
  return {
    api: call(createWorker(async () => null)),
    staffApi: call(createWorker(async () => staffActor)),
    // Same Worker, a different authenticated staff identity, so the moderation
    // route can be exercised against each role that must and must not have it.
    staffApiAs: (actor) => call(createWorker(async () => actor)),
    database,
  };
};

const register = async (api, context, firstName, lastName, options = {}) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    success: true,
    hostname: "quickducks.com",
  }));
  const response = await api("/api/v1/registrations", {
    method: "POST",
    cookie: options.cookie,
    headers: { origin: "https://quickducks.com" },
    body: {
      eventId: "event-ducks",
      commandId: options.commandId ?? crypto.randomUUID(),
      privateToken: options.privateToken ?? randomToken(),
      firstName,
      lastName,
      turnstileToken: "turnstile-test",
    },
  });
  const body = await jsonBody(response, 201, `register ${firstName}`);
  context.mock.restoreAll();
  return { ...body, cookie: cookieFrom(response) };
};

// Staff pairing, written directly so these tests stay about the participant
// surfaces. The rows are the same ones the pairing endpoint writes.
const pairDuck = (database, registrationId, visibleNumber, tagToken) => {
  const raceEntryId = database
    .prepare("SELECT id FROM race_entries WHERE registration_id = ?")
    .get(registrationId).id;
  const suffix = String(visibleNumber);
  database.prepare(
    `INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
     VALUES (?, ?, 'IN_USE', '2026-08-01T00:00:00Z')`,
  ).run(`duck-${suffix}`, visibleNumber);
  database.prepare(
    `INSERT INTO event_ducks (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
     VALUES (?, 'event-ducks', ?, '2026-08-01T00:00:00Z', 'staff')`,
  ).run(`event-duck-${suffix}`, `duck-${suffix}`);
  database.prepare(
    `INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
     VALUES (?, 'event-ducks', 'ASSIGN_DUCK', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).run(`pair-command-${suffix}`);
  database.prepare(
    `INSERT INTO duck_assignments
       (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
        assigned_by_staff_profile_id, source_command_id)
     VALUES (?, 'event-ducks', ?, ?, ?, '2026-08-01T00:00:00Z', 'staff', ?)`,
  ).run(`assignment-${suffix}`, raceEntryId, `event-duck-${suffix}`, `duck-${suffix}`, `pair-command-${suffix}`);
  database.prepare(
    `INSERT INTO duck_tags (id, duck_id, token, status, activated_at)
     VALUES (?, ?, ?, 'ACTIVE', '2026-08-01T00:00:00Z')`,
  ).run(`tag-${suffix}`, `duck-${suffix}`, tagToken);
  database.prepare("UPDATE registrations SET status = 'ACTIVE' WHERE id = ?").run(registrationId);
  return raceEntryId;
};

// Puts a paired entry onto a heat roster, optionally with a finalized place so
// the public board also publishes a podium for it.
const seedHeat = (database, raceEntryId, { round = "ROUND_ONE", heatNumber = 1, place = null } = {}) => {
  const heatId = `heat-${round}-${heatNumber}`;
  const existing = database.prepare("SELECT id FROM heats WHERE id = ?").get(heatId);
  if (existing === undefined) {
    database.prepare(
      `INSERT INTO heats (id, event_id, round, heat_number, status)
       VALUES (?, 'event-ducks', ?, ?, 'PLANNED')`,
    ).run(heatId, round, heatNumber);
  }
  // Rosters are only writable while the heat is planned and unlocked, so the
  // entry goes in first and the heat is finalized afterwards.
  database.prepare(
    `INSERT INTO heat_entries
       (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
     VALUES (?, 'event-ducks', ?, ?, ?, ?, 'BALANCED_DRAW', '2026-08-01T00:00:00Z')`,
  ).run(`heat-entry-${raceEntryId}-${heatId}`, heatId, raceEntryId, round, place ?? 1);
  if (place === null) return heatId;
  database.prepare(
    `UPDATE heats
        SET status = 'FINALIZED', roster_locked_at = '2026-08-01T00:00:00Z',
            finalized_at = '2026-08-01T00:00:00Z'
      WHERE id = ?`,
  ).run(heatId);
  const assignmentId = database
    .prepare("SELECT id FROM duck_assignments WHERE race_entry_id = ? AND valid_to IS NULL")
    .get(raceEntryId).id;
  database.prepare(
    `INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
     VALUES (?, 'event-ducks', 'FINALIZE_HEAT_RESULT', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).run(`result-command-${raceEntryId}-${heatId}`);
  database.prepare(
    `INSERT INTO heat_results
       (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
        finalized_at, recorded_by_staff_profile_id, source_command_id)
     VALUES (?, 'event-ducks', ?, ?, ?, ?, 'FINALIZED', 1, '2026-08-01T00:00:00Z', 'staff', ?)`,
  ).run(
    `result-${raceEntryId}-${heatId}`,
    heatId,
    raceEntryId,
    assignmentId,
    place,
    `result-command-${raceEntryId}-${heatId}`,
  );
  return heatId;
};

const tagToken = "t".repeat(32);
const linkRows = (database) => database
  .prepare("SELECT collection_id, registration_id, added_via FROM browser_collection_registrations ORDER BY added_at, registration_id")
  .all()
  .map((row) => ({ ...row }));
const duckNameOf = (database, registrationId) => database
  .prepare("SELECT duck_name FROM race_entries WHERE registration_id = ?")
  .get(registrationId).duck_name;
const clean = (database) =>
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

// ---------------------------------------------------------------------------
// Following from a scanned tag
// ---------------------------------------------------------------------------

test("scanning a duck tag offers a follow to a browser that does not have that duck", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);

  // A visitor with no collection sees the offer, on the page and in the API.
  const page = await (await api(`/t/${tagToken}`)).text();
  assert.match(page, new RegExp(`data-duck-follow data-follow-id="${raceEntryId}"`));
  assert.match(page, /data-follow-button>Follow this duck<\/button>/);
  assert.doesNotMatch(page, /In My Ducks/);
  assert.equal(page.includes(owner.lookupCode), false);

  const scan = await jsonBody(await api(`/api/v1/ducks/${tagToken}`), 200, "tag scan");
  assert.equal(scan.destination, "RACE_STATUS");
  assert.equal(scan.raceStatus.followId, raceEntryId);
  assert.equal(scan.raceStatus.inMyDucks, false);
  assert.equal(scan.raceStatus.duck.visibleNumber, 12);
  // This duck has no chosen name, so the public field is present and null; the
  // scan still carries no contact detail, code, or private path.
  assert.equal(scan.raceStatus.duckName, null);
  assert.equal(/lookupCode|email|phone|privateStatusPath/i.test(JSON.stringify(scan)), false);

  // Following uses the existing endpoint and the existing collection semantics.
  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: scan.raceStatus.followId },
  });
  assert.deepEqual(await jsonBody(followResponse, 200, "follow"), {
    followed: true,
    alreadyInCollection: false,
  });
  const follower = cookieFrom(followResponse);
  assert.deepEqual(
    linkRows(database).map((row) => row.added_via),
    ["REGISTRATION", "FOLLOWED"],
  );

  // The same page now renders the already-added state with no second action.
  const added = await (await api(`/t/${tagToken}`, { cookie: follower })).text();
  assert.match(added, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(added, /data-follow-button/);
  const rescan = await jsonBody(
    await api(`/api/v1/ducks/${tagToken}`, { cookie: follower }),
    200,
    "tag rescan",
  );
  assert.equal(rescan.raceStatus.inMyDucks, true);

  // Following again is the same idempotent no-op the search path already has.
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/follow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { followId: raceEntryId },
      }),
      200,
      "repeat follow",
    ),
    { followed: true, alreadyInCollection: true },
  );
  assert.equal(linkRows(database).length, 2);

  // The registering browser already holds this duck, so it is offered nothing.
  const ownerPage = await (await api(`/t/${tagToken}`, { cookie: owner.cookie })).text();
  assert.match(ownerPage, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(ownerPage, /data-follow-button/);
  clean(database);
});

test("the public duck page offers the identical follow control and identifier", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);

  const page = await (await api("/duck/12")).text();
  assert.match(page, new RegExp(`data-duck-follow data-follow-id="${raceEntryId}"`));
  assert.match(page, /data-follow-button>Follow this duck<\/button>/);
  assert.equal(page.includes(tagToken), false, "the duck page never exposes the tag");

  const detail = await jsonBody(await api("/api/v1/ducks/number/12"), 200, "duck number");
  assert.equal(detail.raceStatus.followId, raceEntryId);
  assert.equal(detail.raceStatus.inMyDucks, false);

  const followResponse = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { followId: detail.raceStatus.followId },
  });
  await jsonBody(followResponse, 200, "follow from duck page");
  const follower = cookieFrom(followResponse);

  const added = await (await api("/duck/12", { cookie: follower })).text();
  assert.match(added, /data-follow-added>In My Ducks<\/span>/);
  assert.doesNotMatch(added, /data-follow-button/);
  assert.equal(
    (await jsonBody(await api("/api/v1/ducks/number/12", { cookie: follower }), 200, "recheck"))
      .raceStatus.inMyDucks,
    true,
  );

  // The follower's collection carries the public projection and nothing more.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: follower }),
    200,
    "follower collection",
  );
  assert.equal(mine.registrations.length, 1);
  assert.equal(mine.registrations[0].followed, true);
  assert.equal(mine.registrations[0].lookupCode, null);
  assert.equal(mine.registrations[0].duckName, null);
  assert.equal(mine.registrations[0].nameable, false);
  clean(database);
});

// A participant who withdrew or was disqualified keeps their duck: it is sealed
// in a heat bag and nobody unpacks a bag on race day. Publicly, though, the duck
// is not racing, so a scan of its tag and a visit to its numbered page both stop
// resolving to that participant entirely. They fall back to the behaviour those
// routes already have for a duck with no current racer — the tag redirects home
// and the number serves the shared friendly 404 — so no new page shape and no
// participant identity is exposed, and there is nothing left to follow.
for (const status of ["WITHDRAWN", "DISQUALIFIED"]) {
  test(`a ${status} participant disappears from the tag scan and the public duck page`, async (context) => {
    const { api, database } = harness(context);
    seedEvent(database);
    const owner = await register(api, context, "Daisy", "Duck");
    pairDuck(database, owner.registrationId, 12, tagToken);

    // While still racing, both public surfaces resolve normally.
    assert.equal((await api(`/t/${tagToken}`)).status, 200);
    assert.equal((await api("/duck/12")).status, 200);

    database.prepare("UPDATE registrations SET status = ? WHERE id = ?")
      .run(status, owner.registrationId);

    const tagPage = await api(`/t/${tagToken}`);
    assert.equal(tagPage.status, 303);
    assert.equal(tagPage.headers.get("location"), "/");
    const scan = await jsonBody(await api(`/api/v1/ducks/${tagToken}`), 200, "withdrawn scan");
    assert.deepEqual(scan, { destination: "HOME" });

    const duckPage = await api("/duck/12");
    assert.equal(duckPage.status, 404);
    const duckPageHtml = await duckPage.text();
    // The page is honest about the duck the visitor is holding without naming
    // anyone: it is the shared "isn't racing" page, with no participant, no duck
    // name, and no follow control.
    assert.match(duckPageHtml, /Duck #12 isn’t racing\./);
    assert.equal(/Daisy|Mallard|data-follow-button|data-duck-follow data-follow-id/.test(duckPageHtml), false);
    assert.deepEqual(
      await jsonBody(await api("/api/v1/ducks/number/12"), 404, "withdrawn duck number"),
      { error: "Not found." },
    );

    // Nothing about the participant survives on either public response.
    assert.equal(/Daisy|lookupCode|followId/i.test(JSON.stringify(scan)), false);

    // The duck, its tag, its assignment, and the registration are all untouched:
    // this is a projection rule, not a data change.
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL").get().count,
      1,
    );
    assert.equal(
      database.prepare("SELECT status FROM duck_tags WHERE token = ?").get(tagToken).status,
      "ACTIVE",
    );
    clean(database);
  });
}

// A shared round-one heat and a shared finalized final for two racers. The
// entries go in while both heats are still open plans and the final is
// finalized only afterwards, which is the same order the real roster lock uses
// and the only order the roster-lock trigger permits.
const seedSharedHeats = (database, racers) => {
  database.exec(`
    INSERT INTO heats (id, event_id, round, heat_number, status, target_size)
    VALUES ('shared-round', 'event-ducks', 'ROUND_ONE', 1, 'PLANNED', 2),
           ('shared-final', 'event-ducks', 'FINAL', 1, 'PLANNED', 2);
  `);
  for (const [index, racer] of racers.entries()) {
    for (const [heatId, round] of [["shared-round", "ROUND_ONE"], ["shared-final", "FINAL"]]) {
      database.prepare(
        `INSERT INTO heat_entries
           (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
         VALUES (?, 'event-ducks', ?, ?, ?, ?, 'PAIRING', '2026-08-01T00:00:00Z')`,
      ).run(`${heatId}-slot-${index + 1}`, heatId, racer.entryId, round, index + 1);
    }
  }
  database.exec(`
    UPDATE heats
       SET status = 'FINALIZED', roster_locked_at = '2026-08-01T00:30:00Z',
           finalized_at = '2026-08-01T01:00:00Z'
     WHERE id = 'shared-final';
    INSERT INTO race_commands (id, event_id, command_type, requested_at, completed_at)
    VALUES ('shared-final-result', 'event-ducks', 'FINALIZE_HEAT_RESULT',
            '2026-08-01T01:00:00Z', '2026-08-01T01:00:00Z');
  `);
  for (const [index, racer] of racers.entries()) {
    const assignmentId = database
      .prepare("SELECT id FROM duck_assignments WHERE race_entry_id = ? AND valid_to IS NULL")
      .get(racer.entryId).id;
    database.prepare(
      `INSERT INTO heat_results
         (id, event_id, heat_id, race_entry_id, duck_assignment_id, place, status, revision,
          finalized_at, recorded_by_staff_profile_id, source_command_id)
       VALUES (?, 'event-ducks', 'shared-final', ?, ?, ?, 'FINALIZED', 1,
               '2026-08-01T01:00:00Z', 'staff', 'shared-final-result')`,
    ).run(`shared-final-place-${index + 1}`, racer.entryId, assignmentId, index + 1);
  }
};

// The complete public-versus-owner split for a participant who leaves the race.
// The duck is still in its bag and may still float past the finish line, so this
// is a projection rule everywhere and a data change nowhere.
for (const leftStatus of ["WITHDRAWN", "DISQUALIFIED"]) {
  test(`a ${leftStatus} participant leaves every public surface but stays visible to their owner`, async (context) => {
    const { api, database } = harness(context);
    seedEvent(database);
    const secondTag = "s".repeat(32);

    const leaver = await register(api, context, "Daisy", "Duck");
    const stayer = await register(api, context, "Donald", "Mallard");
    const leaverEntry = pairDuck(database, leaver.registrationId, 12, tagToken);
    const stayerEntry = pairDuck(database, stayer.registrationId, 13, secondTag);
    seedSharedHeats(database, [{ entryId: leaverEntry }, { entryId: stayerEntry }]);
    database.prepare("UPDATE events SET status = 'COMPLETED' WHERE id = 'event-ducks'").run();

    // A third browser follows the participant who is about to leave.
    const follower = await followFrom(api, leaverEntry);

    const boardBefore = await jsonBody(await api("/api/v1/race-board"), 200, "board before");
    assert.deepEqual(boardBefore.event.podium.map((entry) => [entry.place, entry.duckNumber]), [[1, 12], [2, 13]]);

    const heatEntriesBefore = database
      .prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
      .all().map((row) => ({ ...row }));

    database.prepare("UPDATE registrations SET status = ? WHERE id = ?")
      .run(leftStatus, leaver.registrationId);

    // --- public surfaces: gone -------------------------------------------
    const search = await jsonBody(
      await api("/api/v1/race-status/search?eventId=event-ducks&name=Daisy"),
      200,
      "public search",
    );
    assert.deepEqual(search.results, []);
    const stillSearchable = await jsonBody(
      await api("/api/v1/race-status/search?eventId=event-ducks&name=Donald"),
      200,
      "public search for the racer who stayed",
    );
    assert.equal(stillSearchable.results.length, 1);

    const board = await jsonBody(await api("/api/v1/race-board"), 200, "board after");
    assert.deepEqual(board.event.roundOneHeats[0].roster.map((entry) => entry.duckNumber), [13]);
    assert.deepEqual(board.event.finalHeats[0].roster.map((entry) => entry.duckNumber), [13]);
    // The winner is simply absent; second place is not promoted to first.
    assert.deepEqual(board.event.podium.map((entry) => [entry.place, entry.duckNumber]), [[2, 13]]);
    assert.equal(JSON.stringify(board).includes("Daisy"), false);

    assert.deepEqual(
      await jsonBody(await api(`/api/v1/ducks/${tagToken}`), 200, "tag scan"),
      { destination: "HOME" },
    );
    assert.equal((await api("/api/v1/ducks/number/12")).status, 404);
    // The racer who stayed is untouched on both duck surfaces.
    assert.equal((await api("/api/v1/ducks/number/13")).status, 200);
    assert.equal(
      (await jsonBody(await api(`/api/v1/ducks/${secondTag}`), 200, "other tag scan")).destination,
      "RACE_STATUS",
    );

    // The follow endpoint refuses them, so no new follower can appear either.
    assert.equal(
      (await api("/api/v1/registrations/mine/follow", {
        method: "POST",
        headers: { origin: "https://quickducks.com" },
        body: { followId: leaverEntry },
      })).status,
      404,
    );

    // --- the follower's saved list: gone ---------------------------------
    const followerCollection = await jsonBody(
      await api("/api/v1/registrations/mine", { cookie: follower }),
      200,
      "follower collection",
    );
    assert.deepEqual(followerCollection.registrations, []);
    assert.deepEqual(
      await jsonBody(
        await api("/api/v1/registrations/mine/presence", { cookie: follower }),
        200,
        "follower presence",
      ),
      { hasRegistrations: false },
    );
    // The link row itself survives, so reactivation restores the followed card
    // rather than silently losing it.
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM browser_collection_registrations WHERE added_via = 'FOLLOWED'").get().count,
      1,
    );

    // --- the owner's own surfaces: unchanged and honest -------------------
    const privateToken = leaver.privateStatusPath.replace("/r/", "");
    const privateStatus = await jsonBody(
      await api(`/api/v1/registrations/${privateToken}`),
      200,
      "private status",
    );
    assert.equal(privateStatus.status, leftStatus);
    assert.equal(privateStatus.raceStatus.outcome, leftStatus);
    assert.equal(privateStatus.firstName, "Daisy");
    const privatePage = await api(`/r/${privateToken}`);
    assert.equal(privatePage.status, 200);
    assert.match(
      await privatePage.text(),
      leftStatus === "WITHDRAWN" ? /Registration withdrawn, Daisy\./ : /Race status updated, Daisy\./,
    );

    const ownerCollection = await jsonBody(
      await api("/api/v1/registrations/mine", { cookie: leaver.cookie }),
      200,
      "owner collection",
    );
    assert.equal(ownerCollection.registrations.length, 1);
    assert.equal(ownerCollection.registrations[0].registrationStatus, leftStatus);
    assert.equal(ownerCollection.registrations[0].raceStatus.outcome, leftStatus);
    assert.equal(ownerCollection.registrations[0].paired, true);
    assert.deepEqual(
      await jsonBody(
        await api("/api/v1/registrations/mine/presence", { cookie: leaver.cookie }),
        200,
        "owner presence",
      ),
      { hasRegistrations: true },
    );

    // --- nothing physical moved ------------------------------------------
    assert.deepEqual(
      database.prepare("SELECT id, heat_id, race_entry_id, slot_number FROM heat_entries ORDER BY id")
        .all().map((row) => ({ ...row })),
      heatEntriesBefore,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM duck_assignments WHERE valid_to IS NULL").get().count,
      2,
    );
    // The official result rows are untouched too: the participant who left keeps
    // their recorded first place in the database, it simply stops being
    // published.
    assert.deepEqual(
      database.prepare("SELECT id, race_entry_id, place FROM heat_results ORDER BY place")
        .all().map((row) => ({ ...row })),
      [
        { id: "shared-final-place-1", race_entry_id: leaverEntry, place: 1 },
        { id: "shared-final-place-2", race_entry_id: stayerEntry, place: 2 },
      ],
    );
    clean(database);
  });
}

// ---------------------------------------------------------------------------
// Unfollowing
// ---------------------------------------------------------------------------

const followFrom = async (api, raceEntryId, cookie) => {
  const response = await api("/api/v1/registrations/mine/follow", {
    method: "POST",
    cookie,
    headers: { origin: "https://quickducks.com" },
    body: { followId: raceEntryId },
  });
  await jsonBody(response, 200, "follow");
  return cookieFrom(response);
};

test("unfollowing removes only the followed link and never the registration", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const commandId = crypto.randomUUID();

  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/unfollow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { commandId, registrationId: owner.registrationId },
      }),
      200,
      "unfollow",
    ),
    { unfollowed: true, replayed: false },
  );

  // The link is gone; the registration, its race entry, and the owner's own
  // link are untouched.
  assert.deepEqual(linkRows(database).map((row) => row.added_via), ["REGISTRATION"]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM registrations WHERE id = ?").get(owner.registrationId).count,
    1,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_entries WHERE id = ?").get(raceEntryId).count,
    1,
  );
  const ownerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "owner collection",
  );
  assert.equal(ownerMine.registrations.length, 1);
  assert.equal(ownerMine.registrations[0].lookupCode, owner.lookupCode);
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine", { cookie: follower }),
      200,
      "follower collection",
    ),
    { registrations: [] },
  );

  // Retrying the identical command is a deterministic success, and the same
  // identifier reused for different material conflicts.
  assert.deepEqual(
    await jsonBody(
      await api("/api/v1/registrations/mine/unfollow", {
        method: "POST",
        cookie: follower,
        headers: { origin: "https://quickducks.com" },
        body: { commandId, registrationId: owner.registrationId },
      }),
      200,
      "replayed unfollow",
    ),
    { unfollowed: true, replayed: true },
  );
  assert.equal(
    (await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      cookie: follower,
      headers: { origin: "https://quickducks.com" },
      body: { commandId, registrationId: crypto.randomUUID() },
    })).status,
    409,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'",
    ).get().count,
    1,
  );
  clean(database);
});

test("unfollow refuses an owned registration, a foreign cookie, and a bad transport", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const stranger = await register(api, context, "Donald", "Mallard");
  const before = linkRows(database);
  assert.equal(before.length, 3);

  const refused = [
    // A registration this browser created is never removable through unfollow;
    // it has its own delete flow.
    ["owned registration", 404, {
      cookie: owner.cookie,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    // Another browser's followed link is invisible here.
    ["foreign cookie", 404, {
      cookie: stranger.cookie,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    ["no cookie at all", 404, {
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
    }],
    // An unrelated registration is the same 404, so nothing is disclosed.
    ["unknown registration", 404, {
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: crypto.randomUUID() },
    }],
    ["non-uuid registration", 400, {
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: "registration-one" },
    }],
    ["non-v4 command", 400, {
      cookie: follower,
      body: { commandId: "not-a-command", registrationId: owner.registrationId },
    }],
    ["array body", 400, { cookie: follower, body: [owner.registrationId] }],
    ["invalid json", 400, { cookie: follower, body: "{" }],
  ];
  for (const [label, status, options] of refused) {
    const response = await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      headers: { origin: "https://quickducks.com" },
      ...options,
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.deepEqual(linkRows(database), before, `${label} must not write`);
  }

  // Transport failures are refused before anything else, including the
  // command history.
  const transport = [
    ["missing origin", 403, {}],
    ["cross origin", 403, { headers: { origin: "https://evil.example" } }],
    ["wrong content type", 415, {
      headers: { origin: "https://quickducks.com", "content-type": "text/plain" },
    }],
  ];
  for (const [label, status, options] of transport) {
    const response = await api("/api/v1/registrations/mine/unfollow", {
      method: "POST",
      cookie: follower,
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
      ...options,
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.deepEqual(linkRows(database), before, `${label} must not write`);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'").get().count,
    0,
  );
  clean(database);
});

test("a rate-limited unfollow writes nothing at all", async (context) => {
  const limited = harness(context, { rateLimited: true });
  seedEvent(limited.database);
  // Registration does not use this binding, so the browser still has a link to
  // attempt an unfollow against.
  const owner = await register(limited.api, context, "Daisy", "Duck");
  const response = await limited.api("/api/v1/registrations/mine/unfollow", {
    method: "POST",
    cookie: owner.cookie,
    headers: { origin: "https://quickducks.com" },
    body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId },
  });

  assert.equal(response.status, 429);
  assert.equal(
    limited.database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'UNFOLLOW_REGISTRATION'").get().count,
    0,
  );
  assert.deepEqual(limited.database.prepare("PRAGMA foreign_key_check").all(), []);
});

// ---------------------------------------------------------------------------
// Naming an owned duck
// ---------------------------------------------------------------------------

const nameDuck = (api, cookie, registrationId, duckName, commandId = crypto.randomUUID()) =>
  api("/api/v1/registrations/mine/duck-name", {
    method: "POST",
    cookie,
    headers: { origin: "https://quickducks.com" },
    body: { commandId, registrationId, duckName },
  });

test("the owner names their paired duck and every public surface shows it beside the number", async (context) => {
  const { api, staffApi, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);

  const commandId = crypto.randomUUID();
  assert.deepEqual(
    await jsonBody(
      await nameDuck(api, owner.cookie, owner.registrationId, "  Sir   Quacks-a-Lot  ", commandId),
      200,
      "name duck",
    ),
    { named: true, duckName: "Sir Quacks-a-Lot", replayed: false },
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Sir Quacks-a-Lot");

  // The owner's own card still shows it, as it always did.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: owner.cookie }),
    200,
    "owner collection",
  );
  assert.equal(mine.registrations[0].duckName, "Sir Quacks-a-Lot");
  assert.equal(mine.registrations[0].nameable, true);
  assert.equal(mine.registrations[0].paired, true);

  // Every public surface now carries the name, and every one of them keeps the
  // canonical duck number so the duck on the page still matches the duck in the
  // water.
  const surfaces = [
    ["tag scan api", await (await api(`/api/v1/ducks/${tagToken}`)).text()],
    ["duck number api", await (await api("/api/v1/ducks/number/12")).text()],
    ["public search", await (await api("/api/v1/race-status/search?eventId=event-ducks&name=Daisy")).text()],
    ["tag page", await (await api(`/t/${tagToken}`)).text()],
    ["duck page", await (await api("/duck/12")).text()],
  ];
  for (const [label, body] of surfaces) {
    assert.equal(body.includes("Sir Quacks-a-Lot"), true, `${label} must carry the duck name`);
    assert.match(body, /Duck #12|"visibleNumber":12|"duckNumber":12/, `${label} must keep the number`);
  }

  // A follower now sees the public name of the duck they follow, through the
  // same public race-status projection every other visitor gets. The name is
  // still not editable there and the follower still gets no lookup code.
  const followerMine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: follower }),
    200,
    "follower collection",
  );
  assert.equal(followerMine.registrations.length, 1);
  assert.equal(followerMine.registrations[0].followed, true);
  assert.equal(followerMine.registrations[0].duckName, null, "a followed card owns no name to edit");
  assert.equal(followerMine.registrations[0].nameable, false);
  assert.equal(followerMine.registrations[0].lookupCode, null);
  assert.equal(followerMine.registrations[0].raceStatus.duckName, "Sir Quacks-a-Lot");

  // Staff see the stored name so they can moderate it, and it is not hidden.
  const staffDuck = await jsonBody(
    await staffApi(`/api/v1/staff/ducks/${tagToken}`),
    200,
    "staff duck view",
  );
  assert.equal(staffDuck.duck.visibleNumber, 12);
  assert.equal(staffDuck.assignment.participant.duckName, "Sir Quacks-a-Lot");
  assert.equal(staffDuck.assignment.participant.duckNamePubliclyHidden, false);
  assert.equal(staffDuck.assignment.participant.registrationId, owner.registrationId);

  // The audit records the changed field, never the free text.
  const audit = database
    .prepare("SELECT subject_id, actor_type, details_json FROM audit_events WHERE action = 'DUCK_NAME_SET'")
    .all()
    .map((row) => ({ ...row }));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, owner.registrationId);
  assert.equal(audit[0].actor_type, "PUBLIC");
  assert.equal(audit[0].details_json.includes("Sir Quacks-a-Lot"), false);
  assert.deepEqual(JSON.parse(audit[0].details_json).changed_fields, ["duck_name"]);
  // The command log stores a hash of the accepted name, not the name.
  const command = database
    .prepare("SELECT request_fingerprint FROM race_commands WHERE id = ?")
    .get(commandId);
  assert.match(command.request_fingerprint, /^[0-9a-f]{64}$/);

  // Replaying the identical command returns the same result and writes nothing
  // new; reusing it for a different name conflicts.
  assert.deepEqual(
    await jsonBody(
      await nameDuck(api, owner.cookie, owner.registrationId, "Sir Quacks-a-Lot", commandId),
      200,
      "replayed name",
    ),
    { named: true, duckName: "Sir Quacks-a-Lot", replayed: true },
  );
  assert.equal(
    (await nameDuck(api, owner.cookie, owner.registrationId, "Something Else", commandId)).status,
    409,
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Sir Quacks-a-Lot");

  // Renaming with a fresh command replaces the previous name.
  await jsonBody(
    await nameDuck(api, owner.cookie, owner.registrationId, "Bubbles"),
    200,
    "rename",
  );
  assert.equal(duckNameOf(database, owner.registrationId), "Bubbles");
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
    2,
  );
  clean(database);
});

test("the live race board carries the duck name on the roster and the podium", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  seedHeat(database, raceEntryId, { round: "ROUND_ONE", heatNumber: 1 });
  seedHeat(database, raceEntryId, { round: "FINAL", heatNumber: 1, place: 1 });
  database.prepare("UPDATE events SET status = 'FINAL' WHERE id = 'event-ducks'").run();
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, "Bubbles"), 200, "name duck");

  const board = await jsonBody(await api("/api/v1/race-board"), 200, "race board");
  const roster = board.event.roundOneHeats[0].roster[0];
  assert.equal(roster.duckNumber, 12, "the roster keeps the canonical number");
  assert.equal(roster.duckName, "Bubbles");
  const podium = board.event.podium[0];
  assert.equal(podium.place, 1);
  assert.equal(podium.duckNumber, 12);
  assert.equal(podium.duckName, "Bubbles");
  // The board still publishes only the policy display name for the person.
  assert.equal(roster.participantDisplayName, "Daisy D.");
  assert.equal(/lookupCode|email|phone/i.test(JSON.stringify(board)), false);
  clean(database);
});

test("duck names are validated and trimmed before any database access", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);

  const rejected = [
    ["blank", 422, ""],
    ["whitespace only", 422, "   \t  "],
    ["one character over the limit", 422, "a".repeat(41)],
    ["control characters", 422, "Bub\u0000bles"],
    ["zero-width joiner", 422, "Bub\u200dbles"],
    ["not a string", 400, 12],
    ["missing", 400, undefined],
  ];
  for (const [label, status, duckName] of rejected) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: { origin: "https://quickducks.com" },
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId, duckName },
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
    assert.equal(duckNameOf(database, owner.registrationId), null, `${label} must not write`);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
      0,
      `${label} must not record a command`,
    );
  }

  // The boundary values are accepted, trimmed and collapsed.
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, "a"), 200, "one character");
  assert.equal(duckNameOf(database, owner.registrationId), "a");
  const longest = "b".repeat(40);
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, ` ${longest} `), 200, "limit");
  assert.equal(duckNameOf(database, owner.registrationId), longest);
  clean(database);
});

test("only the owner of a paired duck may name it", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  const follower = await followFrom(api, raceEntryId);
  const unpaired = await register(api, context, "Donald", "Mallard");

  const refused = [
    // A follower holds the public projection only, so their link can never name
    // someone else's duck.
    ["follower", 404, { cookie: follower, registrationId: owner.registrationId }],
    ["no cookie", 404, { registrationId: owner.registrationId }],
    ["unrelated registration", 404, { cookie: owner.cookie, registrationId: crypto.randomUUID() }],
    // Owned, but there is no duck to name yet.
    ["own unpaired entry", 409, { cookie: unpaired.cookie, registrationId: unpaired.registrationId }],
  ];
  for (const [label, status, options] of refused) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: options.cookie,
      headers: { origin: "https://quickducks.com" },
      body: {
        commandId: crypto.randomUUID(),
        registrationId: options.registrationId,
        duckName: "Not Allowed",
      },
    });
    assert.equal(response.status, status, `${label}: ${await response.text()}`);
  }
  assert.equal(duckNameOf(database, owner.registrationId), null);
  assert.equal(duckNameOf(database, unpaired.registrationId), null);

  // The unpaired owner's own collection reports the same refusal in advance.
  const mine = await jsonBody(
    await api("/api/v1/registrations/mine", { cookie: unpaired.cookie }),
    200,
    "unpaired collection",
  );
  assert.equal(mine.registrations[0].nameable, false);
  assert.equal(mine.registrations[0].duckName, null);

  // Cross-origin and missing-origin naming is refused outright.
  for (const [label, origin] of [["missing origin", undefined], ["cross origin", "https://evil.example"]]) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: origin === undefined ? {} : { origin },
      body: {
        commandId: crypto.randomUUID(),
        registrationId: owner.registrationId,
        duckName: "Not Allowed",
      },
    });
    assert.equal(response.status, 403, label);
  }
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
    0,
  );
  clean(database);
});

// ---------------------------------------------------------------------------
// Filtering a public duck name
// ---------------------------------------------------------------------------

test("a disallowed duck name is refused without echoing it, logging it, or writing it", async (context) => {
  const { api, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);

  const logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    context.mock.method(console, method, (...args) => logged.push(args));
  }

  const refused = [
    "Fucking Duck",
    "sh1t duck",
    "F.U.C.K.",
    "a s s",
    "Total Ass",
    // Evasions found by adversarial testing of the first filter.
    "fvck",
    "cvnt",
    "kunt",
    "niggr",
    "ƒuck",
    "azz hole",
    "biatch",
    "badass",
  ];
  for (const duckName of refused) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: { origin: "https://quickducks.com" },
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId, duckName },
    });
    const body = await response.json();
    // A well-formed value refused on its meaning is the codebase's 422.
    assert.equal(response.status, 422, `${duckName}: ${JSON.stringify(body)}`);
    // The response explains the rule without ever repeating the word back.
    assert.equal(JSON.stringify(body).includes(duckName), false, `${duckName} must not be echoed`);
    assert.match(body.fields.duckName, /can’t be used on the public race board/);
    assert.equal(duckNameOf(database, owner.registrationId), null, `${duckName} must not be stored`);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM race_commands WHERE command_type = 'NAME_DUCK'").get().count,
      0,
      `${duckName} must not record a command`,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'DUCK_NAME%'").get().count,
      0,
      `${duckName} must not write an audit row`,
    );
  }
  // A name written in symbols or emoji is refused by the alphabet rule, which
  // reports itself as the mechanical rule it is rather than as an accusation.
  for (const duckName of ["🖕", "Duck 🖕", "★ Duck", "\uE000 Duck"]) {
    const response = await api("/api/v1/registrations/mine/duck-name", {
      method: "POST",
      cookie: owner.cookie,
      headers: { origin: "https://quickducks.com" },
      body: { commandId: crypto.randomUUID(), registrationId: owner.registrationId, duckName },
    });
    const body = await response.json();
    assert.equal(response.status, 422, `${duckName}: ${JSON.stringify(body)}`);
    assert.equal(JSON.stringify(body).includes(duckName), false, `${duckName} must not be echoed`);
    assert.match(body.fields.duckName, /letters, numbers, spaces, and simple punctuation/);
    assert.equal(duckNameOf(database, owner.registrationId), null, `${duckName} must not be stored`);
  }
  assert.deepEqual(logged, [], "a refused name is never logged");

  // The filter refuses only what it should: ordinary names still save,
  // including the surnames a first-pass filter wrongly rejected.
  for (const duckName of ["Sir Quacks-a-Lot", "Cockburn", "Shitake Mushroom"]) {
    await jsonBody(
      await nameDuck(api, owner.cookie, owner.registrationId, duckName),
      200,
      "innocent name",
    );
    assert.equal(duckNameOf(database, owner.registrationId), duckName);
  }
  clean(database);
});

test("a name already in the database is suppressed at read time on every public surface", async (context) => {
  const { api, staffApi, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  seedHeat(database, raceEntryId, { round: "ROUND_ONE", heatNumber: 1 });

  // Written straight into D1, exactly like a row stored before duck names
  // became public or one that only a later wordlist rejects. The endpoint would
  // refuse this value today.
  database.prepare("UPDATE race_entries SET duck_name = ? WHERE registration_id = ?")
    .run("Bastard Duck", owner.registrationId);
  assert.equal(duckNameOf(database, owner.registrationId), "Bastard Duck");

  const surfaces = [
    ["tag scan api", await (await api(`/api/v1/ducks/${tagToken}`)).text()],
    ["duck number api", await (await api("/api/v1/ducks/number/12")).text()],
    ["race board", await (await api("/api/v1/race-board")).text()],
    ["public search", await (await api("/api/v1/race-status/search?eventId=event-ducks&name=Daisy")).text()],
    ["tag page", await (await api(`/t/${tagToken}`)).text()],
    ["duck page", await (await api("/duck/12")).text()],
    ["owner collection", await (await api("/api/v1/registrations/mine", { cookie: owner.cookie })).text()],
  ];
  for (const [label, body] of surfaces) {
    assert.equal(body.includes("Bastard"), false, `${label} must suppress the stored name`);
  }
  // The duck is still fully identified by its canonical number everywhere.
  assert.match(surfaces.find(([label]) => label === "duck page")[1], /Duck #12/);
  assert.equal(
    JSON.parse(surfaces.find(([label]) => label === "duck number api")[1]).raceStatus.duckName,
    null,
  );
  assert.equal(
    JSON.parse(surfaces.find(([label]) => label === "race board")[1])
      .event.roundOneHeats[0].roster[0].duckNumber,
    12,
  );

  // Staff still see the stored text, flagged as already hidden, because that is
  // what they need in order to decide to clear it.
  const staffDuck = await jsonBody(await staffApi(`/api/v1/staff/ducks/${tagToken}`), 200, "staff duck");
  assert.equal(staffDuck.assignment.participant.duckName, "Bastard Duck");
  assert.equal(staffDuck.assignment.participant.duckNamePubliclyHidden, true);
  clean(database);
});

// ---------------------------------------------------------------------------
// Staff moderation of a duck name
// ---------------------------------------------------------------------------

const clearDuckName = (staffApi, registrationId, commandId = crypto.randomUUID()) =>
  staffApi(`/api/v1/staff/registrations/${registrationId}/clear-duck-name`, {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { commandId },
  });

test("staff clear a duck name idempotently, audit it without the text, and remove it from public view", async (context) => {
  const { api, staffApi, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  const raceEntryId = pairDuck(database, owner.registrationId, 12, tagToken);
  seedHeat(database, raceEntryId, { round: "ROUND_ONE", heatNumber: 1 });
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, "Regrettable Pun"), 200, "name");
  assert.match(await (await api("/duck/12")).text(), /Regrettable Pun/);

  const commandId = crypto.randomUUID();
  const cleared = await jsonBody(
    await clearDuckName(staffApi, owner.registrationId, commandId),
    200,
    "clear duck name",
  );
  assert.equal(cleared.replayed, false);
  assert.equal(cleared.registration.duckName, null);
  assert.equal(duckNameOf(database, owner.registrationId), null, "the name is cleared, not blanked");

  // Every public surface falls back to the canonical duck number.
  for (const [label, body] of [
    ["duck page", await (await api("/duck/12")).text()],
    ["tag page", await (await api(`/t/${tagToken}`)).text()],
    ["duck number api", await (await api("/api/v1/ducks/number/12")).text()],
    ["race board", await (await api("/api/v1/race-board")).text()],
    ["owner collection", await (await api("/api/v1/registrations/mine", { cookie: owner.cookie })).text()],
  ]) {
    assert.equal(body.includes("Regrettable Pun"), false, `${label} must drop the cleared name`);
  }
  assert.match(await (await api("/duck/12")).text(), /Duck #12/);

  // The audit records the action, the actor, and the changed field only.
  const audit = database
    .prepare("SELECT subject_id, actor_type, details_json FROM audit_events WHERE action = 'DUCK_NAME_CLEARED'")
    .all()
    .map((row) => ({ ...row }));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, owner.registrationId);
  assert.equal(audit[0].actor_type, "STAFF");
  assert.equal(audit[0].details_json.includes("Regrettable"), false, "the audit never carries the text");
  const details = JSON.parse(audit[0].details_json);
  assert.deepEqual(details.changed_fields, ["duck_name"]);
  assert.equal(details.staff_profile_id, "staff");
  assert.equal(details.cleared_via, "STAFF_MODERATION");
  assert.equal(details.had_name, true);
  // The command row carries no request fingerprint of the offending text.
  assert.equal(
    database.prepare("SELECT request_fingerprint FROM race_commands WHERE id = ?").get(commandId).request_fingerprint,
    null,
  );

  // Replaying the same command is the same success and writes nothing new.
  const replay = await jsonBody(
    await clearDuckName(staffApi, owner.registrationId, commandId),
    200,
    "replayed clear",
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.duckName, null);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'DUCK_NAME_CLEARED'").get().count,
    1,
  );
  // Reusing that identifier for another operation is the usual conflict.
  assert.equal((await clearDuckName(staffApi, crypto.randomUUID(), commandId)).status, 409);

  // Clearing an already-clear name is still a success, with a fresh command.
  const again = await jsonBody(
    await clearDuckName(staffApi, owner.registrationId),
    200,
    "second clear",
  );
  assert.equal(again.registration.duckName, null);
  assert.equal(
    JSON.parse(
      database
        .prepare("SELECT details_json FROM audit_events WHERE action = 'DUCK_NAME_CLEARED' ORDER BY occurred_at DESC")
        .all()
        .map((row) => ({ ...row }))
        .find((row) => JSON.parse(row.details_json).had_name === false).details_json,
    ).had_name,
    false,
  );

  // The participant may name the duck again afterwards, and the filter still
  // applies to that attempt.
  await jsonBody(await nameDuck(api, owner.cookie, owner.registrationId, "Bubbles"), 200, "rename");
  assert.equal(duckNameOf(database, owner.registrationId), "Bubbles");
  clean(database);
});

test("clearing a duck name is gated to registration, race director, and administrators", async (context) => {
  const { api, staffApiAs, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);

  const actor = (roles, isSystemAdmin = false) => ({
    id: "staff",
    cognitoSub: "staff-sub",
    email: "staff@example.com",
    displayName: "Race Staff",
    isSystemAdmin,
    roles,
    authentication: "bearer",
  });

  for (const [label, roles] of [
    ["duck manager", ["DUCK_MANAGER"]],
    ["announcer", ["ANNOUNCER"]],
    ["heat runner", ["HEAT_RUNNER"]],
    ["result taker", ["RESULT_TAKER"]],
    ["no roles", []],
  ]) {
    await nameDuck(api, owner.cookie, owner.registrationId, "Regrettable Pun");
    const response = await clearDuckName(staffApiAs(actor(roles)), owner.registrationId);
    assert.equal(response.status, 403, label);
    assert.equal(duckNameOf(database, owner.registrationId), "Regrettable Pun", `${label} must not write`);
  }
  // An unauthenticated caller never reaches the route at all.
  const anonymous = await api(`/api/v1/staff/registrations/${owner.registrationId}/clear-duck-name`, {
    method: "POST",
    headers: { origin: "https://quickducks.com" },
    body: { commandId: crypto.randomUUID() },
  });
  assert.equal(anonymous.status, 401);

  for (const [label, roles, isSystemAdmin] of [
    ["registration", ["REGISTRATION"], false],
    ["race director", ["RACE_DIRECTOR"], false],
    ["administrator", [], true],
  ]) {
    await nameDuck(api, owner.cookie, owner.registrationId, "Regrettable Pun");
    assert.equal(duckNameOf(database, owner.registrationId), "Regrettable Pun");
    const response = await clearDuckName(staffApiAs(actor(roles, isSystemAdmin)), owner.registrationId);
    assert.equal(response.status, 200, `${label}: ${await response.text()}`);
    assert.equal(duckNameOf(database, owner.registrationId), null, label);
  }
  clean(database);
});

test("a cookie-authenticated staff clear requires the exact application origin", async (context) => {
  const { api, staffApiAs, database } = harness(context);
  seedEvent(database);
  const owner = await register(api, context, "Daisy", "Duck");
  pairDuck(database, owner.registrationId, 12, tagToken);
  await nameDuck(api, owner.cookie, owner.registrationId, "Regrettable Pun");

  const cookieStaff = staffApiAs({
    id: "staff",
    cognitoSub: "staff-sub",
    email: "staff@example.com",
    displayName: "Race Staff",
    isSystemAdmin: false,
    roles: ["REGISTRATION"],
    authentication: "cookie",
  });
  for (const [label, origin] of [["missing origin", undefined], ["cross origin", "https://evil.example"]]) {
    const response = await cookieStaff(
      `/api/v1/staff/registrations/${owner.registrationId}/clear-duck-name`,
      {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
        body: { commandId: crypto.randomUUID() },
      },
    );
    assert.equal(response.status, 403, label);
    assert.equal(duckNameOf(database, owner.registrationId), "Regrettable Pun", label);
  }
  clean(database);
});

test("the schema refuses a stored duck name that the API would never accept", async (context) => {
  const { database } = harness(context);
  seedEvent(database);
  database.exec(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration-1', 'event-ducks', 'Daisy', 'Duck', 'ACTIVE', 'DAASY234', 'hash-1',
            '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry-1', 'event-ducks', 'registration-1');
  `);

  for (const value of ["", "   ", " Bubbles", "Bubbles ", "c".repeat(41)]) {
    assert.throws(
      () => database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run(value),
      /CHECK constraint failed/,
      JSON.stringify(value),
    );
  }
  database.prepare("UPDATE race_entries SET duck_name = ? WHERE id = 'entry-1'").run("Bubbles");
  assert.equal(duckNameOf(database, "registration-1"), "Bubbles");
  // The column stays optional, so a Worker that never writes it still works.
  database.prepare("UPDATE race_entries SET duck_name = NULL WHERE id = 'entry-1'").run();
  assert.equal(duckNameOf(database, "registration-1"), null);
  clean(database);
});
