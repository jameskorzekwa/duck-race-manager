import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  EmailDeliveryError,
  createSesEmailSender,
  publishPendingEmailNotifications,
  renderRaceReminder,
} from "./email-notifications.ts";
import { createWorker } from "./index.ts";

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
  const migrations = new URL("../db/migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_.+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  database.exec(`
    INSERT INTO staff_profiles
      (id, cognito_sub, email, display_name, is_system_admin, is_active)
    VALUES ('staff', 'staff-sub', 'staff@example.test', 'Race Staff', 0, 1);
    INSERT INTO events
      (id, slug, name, timezone, status, round_one_heat_capacity, final_heat_capacity)
    VALUES ('event', 'harbor-race', 'Harbor <Duck> Derby', 'UTC', 'REGISTRATION_OPEN', 3, 3);
  `);
  return database;
};

const seedParticipant = (database, index, enabled = true) => {
  const registrationId = `registration-${index}`;
  const raceEntryId = `entry-${index}`;
  const duckId = `duck-${index}`;
  const tagToken = String(index).repeat(24);
  const lookupCode = `RACER${String.fromCharCode(64 + index)}AB`;
  database.prepare(`
    INSERT INTO registrations
      (id, event_id, first_name, last_name, email, status, lookup_code,
       private_token_hash, email_notifications_enabled, submitted_at, status_changed_at)
    VALUES (?, 'event', ?, 'Racer', ?, 'SUBMITTED', ?, ?, ?, ?, ?)
  `).run(
    registrationId,
    `Racer${index}`,
    `racer${index}@example.test`,
    lookupCode,
    `private-hash-${index}`,
    enabled ? 1 : 0,
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z",
  );
  database.prepare("INSERT INTO race_entries (id, event_id, registration_id) VALUES (?, 'event', ?)")
    .run(raceEntryId, registrationId);
  database.prepare(`
    INSERT INTO ducks (id, visible_number, inventory_status, inventory_status_changed_at)
    VALUES (?, ?, 'AVAILABLE', '2026-07-30T00:00:00.000Z')
  `).run(duckId, 100 + index);
  database.prepare(`
    INSERT INTO duck_tags (id, duck_id, token, status, activated_at)
    VALUES (?, ?, ?, 'ACTIVE', '2026-07-30T00:00:00.000Z')
  `).run(`tag-${index}`, duckId, tagToken);
  return {
    registrationId,
    lookupCode,
    tagToken,
    visibleNumber: 100 + index,
  };
};

const actor = {
  id: "staff",
  cognitoSub: "staff-sub",
  email: "staff@example.test",
  displayName: "Race Staff",
  isSystemAdmin: false,
  roles: ["REGISTRATION", "HEAT_RUNNER"],
  authentication: "bearer",
};

const envFor = (database, queued) => ({
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  SES_FROM_ADDRESS: "reminders@quickducks.com",
  COGNITO_USER_POOL_ID: "us-east-1_test",
  COGNITO_USER_POOL_CLIENT_ID: "test-client",
  COGNITO_DOMAIN: "https://staff.example.test",
  DB: createD1(database),
  EMAIL_QUEUE: { async send(body) { queued.push(body); } },
  PUBLIC_SEARCH_RATE_LIMITER: { async limit() { return { success: true }; } },
});

const post = (worker, env, path, body, origin = "https://quickducks.com") => worker.fetch(
  new Request(`https://quickducks.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  }),
  env,
);

const queueMessage = (body) => ({
  body,
  acked: false,
  retried: false,
  retryOptions: null,
  ack() { this.acked = true; },
  retry(options) { this.retried = true; this.retryOptions = options; },
});

test("pairing and heat calls create one logical reminder and the exported queue handler sends current data", async () => {
  const database = createDatabase();
  const first = seedParticipant(database, 1);
  const second = seedParticipant(database, 2);
  const optedOut = seedParticipant(database, 3, false);
  const queued = [];
  const sent = [];
  const sender = {
    async send(message) {
      sent.push(message);
      return { messageId: `ses-${sent.length}` };
    },
  };
  const env = envFor(database, queued);
  const worker = createWorker(async () => actor, fetch, sender);

  const pair = async (participant, commandId = crypto.randomUUID()) => {
    const response = await post(worker, env, `/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId,
      eventId: "event",
      lookupCode: participant.lookupCode,
    });
    return { response, commandId };
  };

  const firstPair = await pair(first);
  assert.equal(firstPair.response.status, 201);
  assert.equal((await firstPair.response.json()).heat.number, 1);
  const secondPair = await pair(second);
  assert.equal(secondPair.response.status, 201);
  assert.equal((await pair(optedOut)).response.status, 201);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM email_notifications WHERE notification_type = 'HEAT_ASSIGNED'",
  ).get().count, 2);

  // Matching domain-command replay neither creates nor publishes another row.
  const replay = await pair(first, firstPair.commandId);
  assert.equal(replay.response.status, 200);
  assert.equal((await replay.response.json()).replayed, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM email_notifications").get().count, 2);

  await publishPendingEmailNotifications(env);
  assert.equal(queued.length, 2);
  assert.ok(queued.every((body) => typeof body === "string" && /^[A-Za-z0-9_-]+$/.test(body)));
  for (const body of queued.splice(0)) {
    const message = queueMessage(body);
    await worker.queue({ messages: [message] }, env, {});
    assert.equal(message.acked, true);
    assert.equal(message.retried, false);
  }
  assert.equal(sent.length, 2);
  for (const message of sent) {
    assert.match(message.subject, /Duck #10[12] is assigned to Round One \/ Heat 1/);
    assert.match(message.text, /head|pond|announcements/i);
    assert.match(message.text, /Round One \/ Heat 1/);
    assert.doesNotMatch(message.text + message.html, /private-hash|RACER[A-C]AB|111111111111111111111111/);
    assert.doesNotMatch(message.html, /<Duck>/);
    assert.match(message.html, /Harbor &lt;Duck&gt; Derby/);
  }

  database.exec("UPDATE events SET status = 'ROUND_ONE' WHERE id = 'event'");
  database.exec("UPDATE heats SET status = 'READY' WHERE event_id = 'event'");
  const heat = database.prepare("SELECT id, revision FROM heats WHERE event_id = 'event'").get();
  const callCommand = crypto.randomUUID();
  const called = await post(worker, env, `/api/v1/staff/events/event/heats/${heat.id}/call`, {
    commandId: callCommand,
    revision: heat.revision,
  });
  assert.equal(called.status, 201, JSON.stringify(await called.clone().json()));
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM email_notifications WHERE notification_type = 'HEAT_UPCOMING'",
  ).get().count, 2);
  const calledReplay = await post(worker, env, `/api/v1/staff/events/event/heats/${heat.id}/call`, {
    commandId: callCommand,
    revision: heat.revision,
  });
  assert.equal(calledReplay.status, 200);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM email_notifications WHERE notification_type = 'HEAT_UPCOMING'",
  ).get().count, 2);

  await publishPendingEmailNotifications(env);
  assert.equal(queued.length, 2);
  // Consent is authoritative at consumption time, not when the row was made.
  database.prepare("UPDATE registrations SET email_notifications_enabled = 0 WHERE id = ?")
    .run(second.registrationId);
  for (const body of queued.splice(0)) {
    const message = queueMessage(body);
    await worker.queue({ messages: [message] }, env, {});
    assert.equal(message.acked, true);
  }
  assert.equal(sent.length, 3);
  assert.match(sent.at(-1).subject, /Round One \/ Heat 1 is being called/);
  assert.match(sent.at(-1).text, /head back to the pond/);
  assert.equal(database.prepare(
    "SELECT status FROM email_notifications WHERE registration_id = ? AND notification_type = 'HEAT_UPCOMING'",
  ).get(second.registrationId).status, "CANCELLED");

  // Duplicate delivery after SES acceptance is acknowledged without another send.
  const sentId = database.prepare(
    "SELECT id FROM email_notifications WHERE status = 'SENT' ORDER BY sent_at DESC LIMIT 1",
  ).get().id;
  const duplicate = queueMessage(sentId);
  await worker.queue({ messages: [duplicate] }, env, {});
  assert.equal(duplicate.acked, true);
  assert.equal(sent.length, 3);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("denied role and wrong cookie Origin cannot create reminder side effects", async () => {
  const database = createDatabase();
  const participant = seedParticipant(database, 4);
  const queued = [];
  const env = envFor(database, queued);
  const roleless = createWorker(async () => ({ ...actor, roles: [] }));
  const body = { commandId: crypto.randomUUID(), eventId: "event", lookupCode: participant.lookupCode };
  const denied = await post(roleless, env, `/api/v1/staff/ducks/${participant.tagToken}/assignments`, body);
  assert.equal(denied.status, 403);

  const cookieWorker = createWorker(async () => ({ ...actor, authentication: "cookie" }));
  const wrongOrigin = await post(
    cookieWorker,
    env,
    `/api/v1/staff/ducks/${participant.tagToken}/assignments`,
    { ...body, commandId: crypto.randomUUID() },
    "https://evil.example",
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM email_notifications").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_assignments").get().count, 0);
  assert.deepEqual(queued, []);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("queue publication failure never replaces a committed pairing response", async () => {
  const database = createDatabase();
  const participant = seedParticipant(database, 1);
  const env = envFor(database, []);
  env.EMAIL_QUEUE = { async send() { throw new Error("synthetic queue outage"); } };
  const worker = createWorker(async () => actor);
  const tasks = [];
  const response = await worker.fetch(new Request(
    `https://quickducks.com/api/v1/staff/ducks/${participant.tagToken}/assignments`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://quickducks.com" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event",
        lookupCode: participant.lookupCode,
      }),
    },
  ), env, { waitUntil(promise) { tasks.push(promise); } });
  assert.equal(response.status, 201);
  await Promise.all(tasks);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM duck_assignments").get().count, 1);
  assert.deepEqual({ ...database.prepare(
    "SELECT status, last_error_code FROM email_notifications",
  ).get() }, { status: "RETRY_PENDING", last_error_code: "QUEUE_PUBLISH_FAILED" });
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("the queue handler retries temporary SES failures and terminally records permanent failures", async () => {
  const database = createDatabase();
  const temporaryParticipant = seedParticipant(database, 1);
  const permanentParticipant = seedParticipant(database, 2);
  const queued = [];
  const calls = new Map();
  const sender = {
    async send(message) {
      const count = (calls.get(message.to) ?? 0) + 1;
      calls.set(message.to, count);
      if (message.to === "racer1@example.test" && count === 1) {
        throw new EmailDeliveryError("SES_THROTTLED", true);
      }
      if (message.to === "racer2@example.test") {
        throw new EmailDeliveryError("SES_REJECTED", false);
      }
      return { messageId: "ses-retry-success" };
    },
  };
  const env = envFor(database, queued);
  const worker = createWorker(async () => actor, fetch, sender);
  for (const participant of [temporaryParticipant, permanentParticipant]) {
    const response = await post(worker, env, `/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
      commandId: crypto.randomUUID(),
      eventId: "event",
      lookupCode: participant.lookupCode,
    });
    assert.equal(response.status, 201);
  }
  await publishPendingEmailNotifications(env);
  const idsByRegistration = new Map(database.prepare(
    "SELECT registration_id, id FROM email_notifications",
  ).all().map((row) => [row.registration_id, row.id]));

  const temporaryMessage = queueMessage(idsByRegistration.get(temporaryParticipant.registrationId));
  await worker.queue({ messages: [temporaryMessage] }, env, {});
  assert.equal(temporaryMessage.retried, true);
  assert.deepEqual(temporaryMessage.retryOptions, { delaySeconds: 60 });
  assert.equal(database.prepare(
    "SELECT status, last_error_code FROM email_notifications WHERE registration_id = ?",
  ).get(temporaryParticipant.registrationId).status, "RETRY_PENDING");

  const permanentMessage = queueMessage(idsByRegistration.get(permanentParticipant.registrationId));
  await worker.queue({ messages: [permanentMessage] }, env, {});
  assert.equal(permanentMessage.acked, true);
  assert.equal(permanentMessage.retried, false);
  assert.deepEqual({ ...database.prepare(
    "SELECT status, last_error_code FROM email_notifications WHERE registration_id = ?",
  ).get(permanentParticipant.registrationId) }, { status: "FAILED", last_error_code: "SES_REJECTED" });

  const retry = queueMessage(idsByRegistration.get(temporaryParticipant.registrationId));
  await worker.queue({ messages: [retry] }, env, {});
  assert.equal(retry.acked, true);
  assert.equal(database.prepare(
    "SELECT status FROM email_notifications WHERE registration_id = ?",
  ).get(temporaryParticipant.registrationId).status, "SENT");
  const attempts = database.prepare(
    "SELECT status, error_code, error_detail FROM email_attempts WHERE stage = 'DELIVERY' ORDER BY created_at, id",
  ).all();
  assert.ok(attempts.some((attempt) => attempt.status === "TEMPORARY_FAILURE" && attempt.error_code === "SES_THROTTLED"));
  assert.ok(attempts.some((attempt) => attempt.status === "PERMANENT_FAILURE" && attempt.error_code === "SES_REJECTED"));
  assert.ok(attempts.every((attempt) => attempt.error_detail === null));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("stale SENDING uses the explicit unknown-outcome policy instead of resending", async () => {
  const database = createDatabase();
  const participant = seedParticipant(database, 1);
  const queued = [];
  let providerCalls = 0;
  const env = envFor(database, queued);
  const worker = createWorker(async () => actor, fetch, {
    async send() {
      providerCalls += 1;
      return { messageId: "must-not-send" };
    },
  });
  const paired = await post(worker, env, `/api/v1/staff/ducks/${participant.tagToken}/assignments`, {
    commandId: crypto.randomUUID(),
    eventId: "event",
    lookupCode: participant.lookupCode,
  });
  assert.equal(paired.status, 201);
  await publishPendingEmailNotifications(env);
  const id = queued[0];
  database.prepare(`
    UPDATE email_notifications
       SET status = 'SENDING', sending_started_at = '2020-01-01T00:00:00.000Z'
     WHERE id = ?
  `).run(id);
  database.prepare(`
    INSERT INTO email_attempts
      (id, event_id, notification_id, attempt_number, stage, status, started_at)
    VALUES ('stale-delivery', 'event', ?, 2, 'DELIVERY', 'SENDING', '2020-01-01T00:00:00.000Z')
  `).run(id);

  const message = queueMessage(id);
  await worker.queue({ messages: [message] }, env, {});
  assert.equal(message.acked, true);
  assert.equal(message.retried, false);
  assert.equal(providerCalls, 0);
  assert.deepEqual({ ...database.prepare(
    "SELECT status, last_error_code FROM email_notifications WHERE id = ?",
  ).get(id) }, { status: "FAILED", last_error_code: "DELIVERY_OUTCOME_UNKNOWN" });
  assert.deepEqual({ ...database.prepare(
    "SELECT status, error_code FROM email_attempts WHERE id = 'stale-delivery'",
  ).get() }, { status: "PERMANENT_FAILURE", error_code: "DELIVERY_OUTCOME_UNKNOWN" });

  const malformed = queueMessage({ recipient: "must-not-be-in-a-queue-body@example.test" });
  await worker.queue({ messages: [malformed] }, env, {});
  assert.equal(malformed.acked, true);
  assert.equal(providerCalls, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("SES requests are SigV4 signed, contain structured reminder fields, and classify safe failures", async () => {
  let captured;
  const sender = createSesEmailSender(async (request) => {
    captured = request;
    return Response.json({ MessageId: "provider-message-1" });
  });
  const env = {
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_REGION: "us-east-1",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    SES_FROM_ADDRESS: "reminders@quickducks.com",
  };
  const message = {
    to: "racer@example.test",
    subject: "Harbor Derby reminder",
    text: "Head back to the pond.",
    html: "<p>Head back to the pond.</p>",
  };
  assert.deepEqual(await sender.send(message, env), { messageId: "provider-message-1" });
  assert.equal(captured.url, "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  assert.match(captured.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
  assert.doesNotMatch(captured.headers.get("authorization"), /test-secret-key/);
  assert.match(captured.headers.get("x-amz-content-sha256"), /^[0-9a-f]{64}$/);
  const payload = JSON.parse(await captured.text());
  assert.doesNotMatch(JSON.stringify(payload), /test-access-key|test-secret-key/);
  assert.equal(payload.FromEmailAddress, "reminders@quickducks.com");
  assert.deepEqual(payload.Destination.ToAddresses, ["racer@example.test"]);
  assert.equal(payload.Content.Simple.Body.Text.Data, message.text);
  assert.equal(payload.Content.Simple.Body.Html.Data, message.html);

  const throttled = createSesEmailSender(async () => new Response(null, { status: 429 }));
  await assert.rejects(
    throttled.send(message, env),
    (error) => error instanceof EmailDeliveryError
      && error.code === "SES_THROTTLED"
      && error.temporary === true,
  );
  const rejected = createSesEmailSender(async () => new Response("recipient details must not be retained", { status: 400 }));
  await assert.rejects(
    rejected.send(message, env),
    (error) => error instanceof EmailDeliveryError
      && error.code === "SES_REJECTED"
      && error.temporary === false
      && !error.message.includes("recipient details"),
  );
});

test("templates escape dynamic HTML and never add private credentials", () => {
  const reminder = renderRaceReminder({
    notification_type: "HEAT_UPCOMING",
    event_name: "Derby <script>alert(1)</script>",
    first_name: "Daisy <img>",
    last_name: "Duck",
    email: "daisy@example.test",
    visible_number: 42,
    round: "FINAL",
    heat_number: 1,
  }, "https://quickducks.com");
  assert.ok(reminder);
  assert.doesNotMatch(reminder.html, /<script>|<img>/);
  assert.match(reminder.html, /&lt;script&gt;|&lt;img&gt;/);
  assert.match(reminder.text, /Final \/ Heat 1/);
  assert.doesNotMatch(reminder.text + reminder.html, /lookup|private token|\/r\//i);
});
