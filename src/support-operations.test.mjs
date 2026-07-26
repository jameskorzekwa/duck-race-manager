import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleSupportOperations } from "./support-operations.ts";

const actor = {
  id: "staff_test",
  cognitoSub: "staff-sub",
  email: "staff@example.com",
  displayName: "Staff Member",
  isSystemAdmin: false,
  roles: ["RETURN_STEWARD"],
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

test("strictly administrator-gates support summaries, notifications, audit, and purge", async () => {
  const db = makeDb();
  const paths = [
    "/api/v1/staff/support/events/event_test/summary",
    "/api/v1/staff/support/events/event_test/notifications",
    "/api/v1/staff/support/events/event_test/audit",
    "/api/v1/staff/support/events/event_test/purge-gate",
  ];
  for (const path of paths) {
    const response = await handleSupportOperations(new Request(`https://quickducks.com${path}`), makeEnv(db), actor);
    assert.equal(response.status, 403);
  }
  const claim = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/purge-claim", {
      commandId: crypto.randomUUID(),
      confirmation: "DELETE Test Race",
    }),
    makeEnv(db),
    actor,
  );
  assert.equal(claim.status, 403);
  assert.equal(db.statements.length, 0);
});

test("operational summary reports registration, duck, heat, return, and notification blockers", async () => {
  const db = makeDb((sql) => {
    if (sql.includes("FROM events e") && sql.includes("purge_status")) {
      return { id: "event_test", name: "Test Race", status: "RETURN_PROCESSING", purge_status: null };
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
    if (sql.includes("open_batch_count")) {
      return { total_count: 10, unresolved_count: 2, unreleased_count: 2, active_assignment_count: 1, open_batch_count: 1 };
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
  assert.equal(body.areas.return.blockerCount, 6);
  assert.equal(body.areas.notification.blockerCount, 2);
  assert.equal(body.blockerCount, 13);
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

test("bulk return create and add commands replay without duplicate writes", async () => {
  const createCommandId = crypto.randomUUID();
  const openBatch = {
    id: "batch_test",
    event_id: "event_test",
    status: "OPEN",
    started_at: "2026-07-25T00:00:00Z",
    finalized_at: null,
    item_count: 0,
  };
  let createCommandReads = 0;
  const createDb = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) {
      createCommandReads += 1;
      return createCommandReads === 1
        ? null
        : { event_id: "event_test", command_type: "CREATE_RETURN_BATCH", result_id: "batch_test" };
    }
    if (sql.includes("FROM events e") && sql.includes("purge_status")) {
      return { id: "event_test", name: "Test Race", status: "COMPLETED", purge_status: null };
    }
    if (sql.includes("JOIN return_batches rb ON rb.id = c.result_id")) return openBatch;
    return null;
  });
  const createPath = "/api/v1/staff/support/events/event_test/return-batches";
  const created = await handleSupportOperations(
    post(createPath, { commandId: createCommandId }),
    makeEnv(createDb),
    actor,
  );
  const createReplay = await handleSupportOperations(
    post(createPath, { commandId: createCommandId }),
    makeEnv(createDb),
    actor,
  );

  assert.equal(created.status, 201);
  assert.equal(createReplay.status, 200);
  assert.equal(createDb.batches.length, 1);

  const addCommandId = crypto.randomUUID();
  const returnItem = {
    id: "item_test",
    batch_id: "batch_test",
    event_id: "event_test",
    sequence_number: 1,
    disposition: "RETURNED",
    visible_number: 42,
    undone_at: null,
  };
  let addCommandReads = 0;
  const addDb = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) {
      addCommandReads += 1;
      return addCommandReads === 1
        ? null
        : { event_id: "event_test", command_type: "ADD_RETURN_BATCH_ITEM", result_id: "item_test" };
    }
    if (sql.includes("SELECT ed.id AS event_duck_id")) return { event_duck_id: "event_duck_test" };
    if (sql.includes("JOIN return_batch_items i ON i.id = c.result_id")) return returnItem;
    return null;
  });
  const addPath = "/api/v1/staff/support/events/event_test/return-batches/batch_test/items";
  const added = await handleSupportOperations(
    post(addPath, { commandId: addCommandId, visibleNumber: 42 }),
    makeEnv(addDb),
    actor,
  );
  const addReplay = await handleSupportOperations(
    post(addPath, { commandId: addCommandId, visibleNumber: 42 }),
    makeEnv(addDb),
    actor,
  );

  assert.equal(added.status, 201);
  assert.equal(addReplay.status, 200);
  assert.equal(addDb.batches.length, 1);
  assert.match(addDb.batches[0][0].sql, /duck_event_dispositions/);
  assert.match(addDb.batches[0][0].sql, /released_at IS NULL/);
});

test("undo-last targets only the latest active item in an open return batch", async () => {
  const commandId = crypto.randomUUID();
  const item = {
    id: "item_test",
    batch_id: "batch_test",
    event_id: "event_test",
    sequence_number: 3,
    disposition: "RETURNED",
    visible_number: 42,
    undone_at: null,
  };
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) return null;
    if (sql.includes("ORDER BY i.sequence_number DESC")) return item;
    if (sql.includes("JOIN return_batch_items i ON i.id = c.result_id")) {
      return { ...item, undone_at: "2026-07-25T00:05:00Z" };
    }
    return null;
  });
  const response = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/return-batches/batch_test/undo-last", { commandId }),
    makeEnv(db),
    actor,
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.item.sequence, 3);
  assert.equal(body.item.undone, true);
  assert.match(db.batches[0][0].sql, /i\.undone_at IS NULL/);
  assert.match(db.batches[0][0].sql, /rb\.status = 'OPEN'/);
});

test("bulk finalize atomically writes dispositions and updates assignment, reservation, and inventory", async () => {
  const commandId = crypto.randomUUID();
  const finalized = {
    id: "batch_test",
    event_id: "event_test",
    status: "FINALIZED",
    started_at: "2026-07-25T00:00:00Z",
    finalized_at: "2026-07-25T01:00:00Z",
    item_count: 2,
  };
  let batchReads = 0;
  const db = makeDb((sql) => {
    if (sql.includes("FROM race_commands WHERE id")) return null;
    if (sql.includes("COUNT(i.id) AS item_count")) {
      return { ...finalized, status: "OPEN", finalized_at: null };
    }
    if (sql.includes("JOIN return_batches rb ON rb.id = c.result_id")) {
      batchReads += 1;
      return finalized;
    }
    return null;
  });
  const response = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/return-batches/batch_test/finalize", { commandId }),
    makeEnv(db),
    actor,
  );

  assert.equal(response.status, 201);
  assert.equal(batchReads, 1);
  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  assert.match(sql, /INSERT INTO duck_event_dispositions/);
  assert.match(sql, /UPDATE duck_assignments/);
  assert.match(sql, /UPDATE event_ducks/);
  assert.match(sql, /UPDATE ducks/);
  assert.match(sql, /status = 'FINALIZED'/);
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

test("purge claim is an atomic administrator command with every gate in the write", async () => {
  const commandId = crypto.randomUUID();
  let claimReads = 0;
  const db = makeDb((sql) => {
    if (sql.startsWith("SELECT id, name, status FROM events")) {
      return { id: "event_test", name: "Test Race", status: "ARCHIVED" };
    }
    if (sql.includes("FROM event_purge_claims")) {
      claimReads += 1;
      return claimReads === 1
        ? null
        : { command_id: commandId, status: "PURGING", claimed_at: "2026-07-25T00:00:00Z" };
    }
    return null;
  });
  const response = await handleSupportOperations(
    post("/api/v1/staff/support/events/event_test/purge-claim", {
      commandId,
      confirmation: "DELETE Test Race",
    }),
    makeEnv(db),
    admin,
  );

  assert.equal(response.status, 201);
  const claimSql = db.batches[0][0].sql;
  assert.match(claimSql, /INSERT INTO event_purge_claims/);
  assert.match(claimSql, /status = 'ARCHIVED'/);
  assert.match(claimSql, /email_notifications/);
  assert.match(claimSql, /duck_event_dispositions/);
  assert.match(claimSql, /return_batches/);
  assert.doesNotMatch(claimSql, /event_test/);
});

test("support migration enforces terminal notifications and a PURGING delete claim", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_staff_identity.sql",
    "0002_registration_foundation.sql",
    "0003_assignment_and_heat_status.sql",
    "0004_pairing_status_and_purge.sql",
    "0005_staff_access_management.sql",
    "0011_support_operations.sql",
  ]) {
    database.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles (id, cognito_sub, email, is_system_admin)
    VALUES ('admin', 'admin-sub', 'admin@example.com', 1);
    INSERT INTO events (id, slug, name, timezone, status)
    VALUES ('event', 'test-race', 'Test Race', 'America/Denver', 'ARCHIVED');
    INSERT INTO registrations
      (id, event_id, first_name, last_name, lookup_code, private_token_hash, submitted_at, status_changed_at)
    VALUES ('registration', 'event', 'Daisy', 'Duck', 'DAISY234', 'hash', '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z');
  `);

  assert.throws(() => database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status)
    VALUES ('notification', 'event', 'registration', 'UPCOMING_HEAT', 'FAILED');
  `), /CHECK constraint failed/);
  database.exec(`
    INSERT INTO email_notifications
      (id, event_id, registration_id, notification_type, status, terminal_at)
    VALUES ('notification', 'event', 'registration', 'UPCOMING_HEAT', 'FAILED', '2026-07-25T00:00:00Z');
  `);
  assert.throws(() => database.exec("DELETE FROM events WHERE id = 'event'"), /requires PURGING claim/);
  database.exec(`
    INSERT INTO event_purge_claims
      (event_id, command_id, status, claimed_by_staff_profile_id, claimed_at)
    VALUES ('event', 'command', 'PURGING', 'admin', '2026-07-25T00:00:00Z');
  `);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
