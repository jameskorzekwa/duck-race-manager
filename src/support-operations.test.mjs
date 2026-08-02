import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleSupportOperations } from "./support-operations.ts";

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["RACE_DIRECTOR"],
  authentication: "bearer",
};
const admin = { ...actor, id: "admin_test", isSystemAdmin: true, roles: [] };

const makeDb = (first = () => null, all = () => ({ results: [] })) => {
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
          return { success: true, meta: { changes: 1 } };
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

const makeEnv = (db, queue = { async send() {} }) => ({ DB: db, EMAIL_QUEUE: queue });

const post = (path, body) => new Request(`https://quickducks.com${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("returns null for routes owned by the shared staff router", async () => {
  const response = await handleSupportOperations(
    new Request("https://quickducks.com/api/v1/staff/profiles"),
    makeEnv(makeDb()),
    admin,
  );
  assert.equal(response, null);
});

test("strictly administrator-gates support summaries, notifications, and audit", async () => {
  const db = makeDb();
  const paths = [
    "/api/v1/staff/support/events/event_test/summary",
    "/api/v1/staff/support/events/event_test/notifications",
    "/api/v1/staff/support/events/event_test/audit",
  ];
  for (const path of paths) {
    const response = await handleSupportOperations(new Request(`https://quickducks.com${path}`), makeEnv(db), actor);
    assert.equal(response.status, 403);
  }
  assert.equal(db.statements.length, 0);
});

// Return batches and the staged purge ceremony are gone. These support paths
// must fall through to the shared router (null) rather than being handled, and
// they must never reach D1 on the way out.
test("retired return-batch and purge support routes are no longer handled", async () => {
  const db = makeDb(() => {
    throw new Error("a removed route must not read the database");
  });
  const retired = [
    ["GET", "/api/v1/staff/support/events/event_test/purge-gate"],
    ["POST", "/api/v1/staff/support/events/event_test/purge-claim"],
    ["POST", "/api/v1/staff/support/events/event_test/return-batches"],
    ["POST", "/api/v1/staff/support/events/event_test/return-batches/batch_test/items"],
    ["POST", "/api/v1/staff/support/events/event_test/return-batches/batch_test/undo-last"],
    ["POST", "/api/v1/staff/support/events/event_test/return-batches/batch_test/finalize"],
  ];
  for (const [method, path] of retired) {
    for (const candidate of [actor, admin]) {
      const request = method === "GET"
        ? new Request(`https://quickducks.com${path}`)
        : post(path, {
          commandId: crypto.randomUUID(),
          confirmation: "DELETE Test Race",
          visibleNumber: 42,
          disposition: "RETURNED",
        });
      assert.equal(await handleSupportOperations(request, makeEnv(db), candidate), null);
    }
  }
  assert.equal(db.statements.length, 0);
  assert.equal(db.batches.length, 0);
});

test("operational summary reports registration, duck, heat, and notification blockers", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM events e")) {
      return { id: "event_test", name: "Test Race", status: "COMPLETED" };
    }
    if (sql.includes("FROM registrations r")) {
      return { total_count: 10, submitted_count: 4, active_count: 6, unpaired_count: 2 };
    }
    if (sql.includes("FROM event_ducks ed") && sql.includes("missing_active_tag_count")) {
      return { reserved_count: 10, unassigned_count: 1, inventory_mismatch_count: 1, missing_active_tag_count: 1 };
    }
    if (sql.includes("FROM heats") && sql.includes("unfinished_count")) {
      return { total_count: 3, blocking_count: 1, unfinished_count: 1, awaiting_result_count: 1 };
    }
    if (sql.includes("FROM email_notifications")) {
      return { total_count: 10, nonterminal_count: 2, failed_count: 1, retry_pending_count: 1 };
    }
    return null;
  });
  const response = await handleSupportOperations(
    new Request("https://quickducks.com/api/v1/staff/support/events/event_test/summary"),
    makeEnv(db),
    admin,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.areas.registration.blockerCount, 2);
  assert.equal(body.areas.duck.blockerCount, 2);
  assert.equal(body.areas.heat.blockerCount, 1);
  assert.equal(body.areas.notification.blockerCount, 2);
  assert.equal(body.blockerCount, 7);

  // No returns area, no purge-claim projection, and no reads of retired tables.
  assert.deepEqual(Object.keys(body.areas), ["registration", "duck", "heat", "notification"]);
  assert.equal("purgeStatus" in body.event, false);
  const sql = db.statements.map((statement) => statement.sql).join("\n");
  assert.doesNotMatch(sql, /duck_event_dispositions|return_batches|event_purge_claims/);
  for (const statement of db.statements) assert.doesNotMatch(statement.sql, /event_test/);
});

test("notification retry creates a durable attempt and queues only its notification ID", async () => {
  const commandId = crypto.randomUUID();
  const sent = [];
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) return null;
    if (sql.includes("FROM email_attempts") && sql.includes("source_command_id")) {
      return { id: "attempt_test", notification_id: "notification_test", status: "PENDING", attempt_number: 2 };
    }
    if (sql.includes("SELECT status, retry_after, publication_failure_count")) {
      return { status: "PENDING", retry_after: null, publication_failure_count: 0 };
    }
    return null;
  });
  const response = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/notifications/notification_test/retry", { commandId }),
    makeEnv(db, { async send(message) { sent.push(message); } }),
    admin,
  );

  assert.equal(response.status, 202);
  assert.deepEqual(sent, ["notification_test"]);
  assert.equal(db.batches.length, 2);
  assert.match(db.batches[0][2].sql, /INSERT INTO email_attempts/);
  assert.doesNotMatch(JSON.stringify(db.batches), /private_token|provider_message_id|error_detail/);
});

test("notification cancellation records the reason outside redacted audit details", async () => {
  const commandId = crypto.randomUUID();
  let commandLookups = 0;
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) {
      commandLookups += 1;
      return commandLookups === 1
        ? null
        : { event_id: "event_test", command_type: "CANCEL_NOTIFICATION", result_id: "notification_test" };
    }
    return null;
  });
  const reason = `No longer needed ${"x".repeat(43)}`;
  const response = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/notifications/notification_test/cancel", { commandId, reason }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 201);
  const audit = db.batches[0][2];
  assert.doesNotMatch(JSON.stringify(audit.args), new RegExp("x{43}"));
  assert.match(JSON.stringify(audit.args), /reason_recorded/);
});

test("audit timeline selects only redacted fields", async () => {
  const db = makeDb(() => null, () => ({
    results: [{
      id: "audit_test",
      source: "NOTIFICATION_ATTEMPT",
      action: "NOTIFICATION_DELIVERY_PERMANENT_FAILURE",
      subject_type: "EMAIL_NOTIFICATION",
      subject_id: "notification_test",
      actor_type: "SYSTEM",
      actor_display_name: null,
      occurred_at: "2026-07-25T00:00:00Z",
      safe_code: "MAILBOX_REJECTED",
    }],
  }));
  const response = await handleSupportOperations(
    new Request("https://quickducks.com/api/v1/staff/support/events/event_test/audit"),
    makeEnv(db),
    admin,
  );
  const body = await response.json();
  const sql = db.statements[0].sql;

  assert.equal(response.status, 200);
  assert.equal(body.events[0].code, "MAILBOX_REJECTED");
  assert.doesNotMatch(sql, /private_token|provider_message_id|error_detail/);
  assert.doesNotMatch(sql, /SELECT\s+[^;]*details_json\s+FROM/i);
  assert.deepEqual(db.statements[0].args.slice(0, 2), ["event_test", "event_test"]);
});

test("the migrated schema enforces terminal notifications and retired the purge claim", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../db/migrations/", import.meta.url))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('admin', 'admin-sub', 'admin@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'COMPLETED');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Daisy', 'Duck', 'DAISY234', 'hash', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
  `);

  // A terminal status still requires a terminal timestamp, and vice versa.
  assert.throws(() => database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status)
    VALUES ('notification', 'event', 'registration', 'UPCOMING_HEAT', 'FAILED');
  `), /CHECK constraint failed/);
  assert.throws(() => database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status, terminal_at)
    VALUES ('pending', 'event', 'registration', 'UPCOMING_HEAT', 'PENDING', '2026-07-25T00:00:00Z');
  `), /CHECK constraint failed/);
  database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status, terminal_at)
    VALUES ('notification', 'event', 'registration', 'UPCOMING_HEAT', 'FAILED', '2026-07-25T00:00:00Z');
  `);

  // The purge claim table and its delete gate are gone; nothing stands between
  // an administrator force delete and an event with no child rows left.
  for (const name of ["event_purge_claims", "return_batches", "return_batch_items"]) {
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?").get(name).count,
      0,
      name,
    );
  }
  for (const name of ["events_require_purge_claim", "purging_events_are_read_only"]) {
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(name).count,
      0,
      name,
    );
  }
  database.exec("DELETE FROM email_notifications WHERE event_id = 'event'");
  database.exec("DELETE FROM registrations WHERE event_id = 'event'");
  database.exec("DELETE FROM events WHERE id = 'event'");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
