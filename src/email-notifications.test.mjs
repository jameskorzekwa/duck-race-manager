import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleEmailQueue } from "./email-notifications.ts";
import worker from "./index.ts";

const config = (name) => JSON.parse(
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll(/^\s*\/\/.*$/gm, ""),
);

test("production wires the opaque-ID queue consumer, bounded retries, DLQ, and outbox cron", () => {
  const production = config("wrangler.jsonc");
  assert.deepEqual(production.queues.consumers, [{
    queue: "quickducks-email",
    max_batch_size: 10,
    max_batch_timeout: 5,
    max_retries: 5,
    dead_letter_queue: "quickducks-email-dlq",
  }]);
  assert.deepEqual(production.triggers.crons, ["*/1 * * * *"]);
  assert.equal(production.vars.EMAIL_FROM_ADDRESS, "race@quickducks.com");
  assert.equal(typeof worker.queue, "function");
  assert.equal(typeof worker.scheduled, "function");
});

test("the consumer acknowledges malformed bodies without reading D1 or calling a sender", async () => {
  const acknowledged = [];
  let retried = false;
  const messages = [
    { body: { email: "private@example.test" }, attempts: 1 },
    { body: "contains spaces", attempts: 1 },
    { body: "x".repeat(129), attempts: 1 },
  ].map((message, index) => ({
    ...message,
    ack() { acknowledged.push(index); },
    retry() { retried = true; },
  }));
  const env = {
    DB: { prepare() { assert.fail("malformed queue bodies must not read D1"); } },
  };
  await handleEmailQueue({ messages, queue: "quickducks-email" }, env, async () => {
    assert.fail("malformed queue bodies must not call the email sender");
  });
  assert.deepEqual(acknowledged, [0, 1, 2]);
  assert.equal(retried, false);
});
