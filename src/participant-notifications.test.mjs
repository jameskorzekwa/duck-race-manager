import assert from "node:assert/strict";
import test from "node:test";

import {
  ParticipantSendError,
  sendSmsWithSns,
  smsSuppressedBySns,
} from "./participant-notifications.ts";

const env = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE1234567",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-that-is-long-enough-for-sigv4",
};

test("SNS checks provider STOP before sending only transactional direct SMS", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const body = String(options.body);
    if (body.includes("Action=CheckIfPhoneNumberIsOptedOut")) {
      return new Response("<CheckIfPhoneNumberIsOptedOutResponse><isOptedOut>false</isOptedOut></CheckIfPhoneNumberIsOptedOutResponse>");
    }
    return new Response("<PublishResponse><MessageId>00000000-0000-4000-8000-000000000001</MessageId></PublishResponse>");
  };

  assert.equal(await smsSuppressedBySns("+12025550100", env), false);
  assert.deepEqual(await sendSmsWithSns({
    to: "+12025550100",
    text: "QuickDucks: Round One, Heat 1 is next to race. Reply STOP to opt out.",
  }, env), { providerMessageId: "00000000-0000-4000-8000-000000000001" });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === "https://sns.us-east-1.amazonaws.com/"));
  assert.match(String(requests[1].options.body), /PhoneNumber=%2B12025550100/);
  assert.match(String(requests[1].options.body), /AWS.SNS.SMS.SMSType/);
  assert.match(String(requests[1].options.body), /Transactional/);
  assert.doesNotMatch(JSON.stringify(requests[1].options.headers), /2025550100/);
});

test("SNS STOP and provider failures are classified without persisting provider detail", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(
    "<CheckIfPhoneNumberIsOptedOutResponse><isOptedOut>true</isOptedOut></CheckIfPhoneNumberIsOptedOutResponse>",
  );
  assert.equal(await smsSuppressedBySns("+12025550100", env), true);

  let bodyRead = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async text() { bodyRead = true; return "private provider detail"; },
  });
  await assert.rejects(
    sendSmsWithSns({ to: "+12025550100", text: "QuickDucks test" }, env),
    (error) => error instanceof ParticipantSendError
      && error.safeCode === "SNS_TEMPORARY_FAILURE"
      && error.retryable === true,
  );
  assert.equal(bodyRead, false);
});
