import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSmsOptedOutWithSns,
  sendSmsWithSns,
  SmsSendError,
} from "./participant-notifications.ts";

const env = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE1234567",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-that-is-long-enough-for-sigv4",
};

test("SNS sends only transactional direct SMS with a signed request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(
      "<PublishResponse><PublishResult><MessageId>sns-message-1</MessageId></PublishResult></PublishResponse>",
      { status: 200 },
    );
  };
  assert.deepEqual(await sendSmsWithSns({
    to: "+18175550100",
    text: "QuickDucks synthetic message. Reply STOP to opt out.",
  }, env), { providerMessageId: "sns-message-1" });
  assert.equal(captured.url, "https://sns.us-east-1.amazonaws.com/");
  assert.equal(captured.options.method, "POST");
  const body = new URLSearchParams(captured.options.body);
  assert.equal(body.get("Action"), "Publish");
  assert.equal(body.get("PhoneNumber"), "+18175550100");
  assert.equal(body.get("MessageAttributes.entry.1.Value.StringValue"), "Transactional");
  assert.match(captured.options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
});

test("SNS STOP state is checked separately immediately before delivery", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(new URLSearchParams(options.body));
    return new Response(
      "<CheckIfPhoneNumberIsOptedOutResponse><CheckIfPhoneNumberIsOptedOutResult><isOptedOut>true</isOptedOut></CheckIfPhoneNumberIsOptedOutResult></CheckIfPhoneNumberIsOptedOutResponse>",
      { status: 200 },
    );
  };
  assert.equal(await checkSmsOptedOutWithSns("+18175550100", env), true);
  assert.equal(bodies[0].get("Action"), "CheckIfPhoneNumberIsOptedOut");
  assert.equal(bodies[0].get("phoneNumber"), "+18175550100");
});

test("SNS classifies throttling as retryable and ambiguous sends as terminal", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(null, { status: 429 });
  await assert.rejects(
    sendSmsWithSns({ to: "+18175550100", text: "synthetic" }, env),
    (error) => error instanceof SmsSendError
      && error.safeCode === "SNS_THROTTLED" && error.retryable === true && error.ambiguous === false,
  );

  globalThis.fetch = async () => { throw new Error("network detail must not escape"); };
  await assert.rejects(
    sendSmsWithSns({ to: "+18175550100", text: "synthetic" }, env),
    (error) => error instanceof SmsSendError
      && error.safeCode === "DELIVERY_OUTCOME_UNKNOWN" && error.retryable === false && error.ambiguous === true,
  );
});

test("SNS opt-out lookup retries request timeouts before any SMS is sent", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(null, { status: 408 });

  await assert.rejects(
    checkSmsOptedOutWithSns("+18175550100", env),
    (error) => error instanceof SmsSendError
      && error.safeCode === "SNS_OPT_OUT_CHECK_FAILED"
      && error.retryable === true
      && error.ambiguous === false,
  );
});
