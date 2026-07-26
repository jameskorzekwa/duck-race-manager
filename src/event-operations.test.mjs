import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleEventOperations } from "./event-operations.ts";

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
  in_progress_heat_count: 0,
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

test("an administrator creates one draft from retained organization defaults", async () => {
  const defaults = {
    timezone: "America/Denver",
    email_required: 1,
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
  const commandId = crypto.randomUUID();
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events", "POST", {
      commandId,
      slug: "annual-race",
      name: "Annual Duck Race",
      eventDate: "2026-09-01",
    }),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.event.status, "DRAFT");
  assert.equal(body.event.timezone, defaults.timezone);
  assert.equal(body.event.emailRequired, true);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /FROM organization_event_defaults/);
  assert.match(sql, /'CREATE_EVENT'/);
  assert.match(sql, /'EVENT_CREATED'/);
  assert.equal(sql.includes("Annual Duck Race"), false);
  assert.ok(db.batches[0].every((statement) => statement.args.length > 0));
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
      slug: "second-race",
      name: "Second Race",
      eventDate: "2027-09-01",
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
  assert.equal(body.event.timezone, "UTC");
  assert.equal(body.event.registrationOpensAt, "2026-08-01T18:00:00.000Z");
  assert.match(db.batches[0][0].sql, /'CONFIGURE_EVENT'.*revision = \?/s);
  assert.match(db.batches[0][1].sql, /EXISTS \(\s*SELECT 1 FROM race_commands/s);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /WHERE id = \? AND status = 'DRAFT' AND revision = \?/);
  assert.match(sql, /UPDATE organization_event_defaults/);
  assert.match(sql, /'CONFIGURE_EVENT'/);
  assert.match(sql, /'EVENT_CONFIGURED'/);
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
  ["start-return-processing", "COMPLETED", "RETURN_PROCESSING", "START_RETURN_PROCESSING"],
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
    INSERT INTO registrations
      (id, event_id, first_name, last_name, status, lookup_code, private_token_hash,
       submitted_at, status_changed_at)
    VALUES
      ('registration', 'event_test', 'Daisy', 'Duck', 'ACTIVE', 'DAISY123', 'private-hash',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO race_entries (id, event_id, registration_id)
    VALUES ('entry', 'event_test', 'registration');
    INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
    VALUES
      ('pair-command', 'event_test', 'PAIR_DUCK', 'assignment',
       '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
    INSERT INTO ducks
      (id, visible_number, inventory_status, inventory_status_changed_at, physical_condition)
    VALUES ('duck', 1, 'IN_USE', '2026-07-26T00:00:00Z', 'GOOD');
    INSERT INTO event_ducks
      (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
    VALUES ('event-duck', 'event_test', 'duck', '2026-07-26T00:00:00Z', 'staff_test');
    INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
    VALUES
      ('assignment', 'event_test', 'entry', 'event-duck', 'duck',
       '2026-07-26T00:00:00Z', 'staff_test', 'pair-command');
    INSERT INTO heats (id, event_id, round, heat_number, status)
    VALUES ('heat', 'event_test', 'ROUND_ONE', 1, 'PLANNED');
    INSERT INTO heat_entries
      (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
    VALUES
      ('heat-entry', 'event_test', 'heat', 'entry', 'ROUND_ONE', 1,
       'BALANCED_DRAW', '2026-07-26T00:00:00Z');
  `);

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

test("an administrator can delete only a revision-matched, truly empty draft", async () => {
  const commandId = crypto.randomUUID();
  const safe = {
    registration_count: 0,
    race_entry_count: 0,
    event_duck_count: 0,
    duck_assignment_count: 0,
    heat_count: 0,
    heat_entry_count: 0,
    heat_result_count: 0,
    disposition_count: 0,
    unsafe_command_count: 0,
    unsafe_audit_count: 0,
  };
  const db = makeDb((sql) => {
    if (sql.includes("AS race_entry_count")) return safe;
    if (sql.includes("action = 'EMPTY_DRAFT_DELETED'")) return null;
    if (sql.includes("FROM race_commands")) return null;
    return draftEvent;
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test", "DELETE", {
      commandId,
      revision: 0,
      confirmation: "DELETE Test Duck Race",
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 204);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /'DELETE_EMPTY_DRAFT'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM registrations/);
  assert.match(sql, /DELETE FROM race_commands/);
  assert.match(sql, /DELETE FROM events/);
  assert.match(sql, /'EMPTY_DRAFT_DELETED'/);
  assert.doesNotMatch(sql, /DELETE FROM organization_event_defaults/);
});

test("draft deletion is blocked when participant or operational data exists", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("AS race_entry_count")) {
      return {
        registration_count: 1,
        race_entry_count: 1,
        event_duck_count: 0,
        duck_assignment_count: 0,
        heat_count: 0,
        heat_entry_count: 0,
        heat_result_count: 0,
        disposition_count: 0,
        unsafe_command_count: 0,
        unsafe_audit_count: 0,
      };
    }
    if (sql.includes("action = 'EMPTY_DRAFT_DELETED'") || sql.includes("FROM race_commands")) return null;
    return draftEvent;
  });
  const response = await handleEventOperations(
    jsonRequest("/api/v1/staff/events/event_test", "DELETE", {
      commandId: crypto.randomUUID(),
      revision: 0,
      confirmation: "DELETE Test Duck Race",
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /race data/);
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
