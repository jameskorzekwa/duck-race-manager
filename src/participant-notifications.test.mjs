import assert from "node:assert/strict";
import test from "node:test";

import {
  destinationHash,
  isEmailSuppressedWithSes,
  isSmsSuppressedWithAws,
  NotificationProviderError,
  sendSmsWithAws,
} from "./participant-notifications.ts";

const env = {
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLEACCESSKEY",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "example-secret-access-key-that-is-long-enough",
  NOTIFICATION_HMAC_KEY: "notification-hmac-key-one-that-is-long-enough",
  SMS_OPT_OUT_LIST_NAME: "quickducks",
  SMS_ORIGINATION_IDENTITY: "+15555550100",
};

test("destination identifiers are secret-keyed and never reveal enumerable contact values", async () => {
  const first = await destinationHash("EMAIL", "racer@example.test", env);
  const second = await destinationHash("EMAIL", "racer@example.test", {
    ...env,
    NOTIFICATION_HMAC_KEY: "different-notification-key-that-is-long-enough",
  });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /racer|example/i);
});

test("AWS SMS suppression uses the configured opted-out-number list contract and pagination", async (context) => {
  const nativeFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = nativeFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers) });
    return requests.length === 1
      ? Response.json({ OptedOutNumbers: [{ OptedOutNumber: "+15555550199" }], NextToken: "page-two" })
      : Response.json({ OptedOutNumbers: [{ OptedOutNumber: "+18175550100" }] });
  };

  assert.equal(await isSmsSuppressedWithAws("+18175550100", env), true);
  assert.equal(requests.length, 2);
  assert.equal(
    new URL(requests[0].url).pathname,
    "/v2/sms-voice/opt-out-lists/quickducks/opted-out-numbers",
  );
  assert.equal(requests[0].method, "GET");
  assert.deepEqual(Object.fromEntries(new URL(requests[0].url).searchParams), { MaxResults: "100" });
  assert.deepEqual(Object.fromEntries(new URL(requests[1].url).searchParams), {
    MaxResults: "100",
    NextToken: "page-two",
  });
  assert.match(requests[0].headers.get("authorization"), /Credential=AKIAEXAMPLEACCESSKEY/);
  assert.equal(new URL(requests[0].url).searchParams.has("PhoneNumber"), false, "not the incorrect point-lookup contract");
});

test("SES account suppression is checked without retaining provider bodies", async (context) => {
  const nativeFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = nativeFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    return new Response(null, { status: requests.length === 1 ? 404 : 200 });
  };
  assert.equal(await isEmailSuppressedWithSes("racer@example.test", env), false);
  assert.equal(await isEmailSuppressedWithSes("racer@example.test", env), true);
  assert.equal(requests[0].method, "GET");
  assert.equal(new URL(requests[0].url).pathname, "/v2/email/suppression/addresses/racer%40example.test");
});

test("AWS SMS suppression fails closed on malformed provider output", async (context) => {
  const nativeFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = nativeFetch; });
  globalThis.fetch = async () => Response.json({ IsOptedOut: false });
  await assert.rejects(
    isSmsSuppressedWithAws("+18175550100", env),
    (error) => error instanceof NotificationProviderError
      && error.safeCode === "SMS_OPT_OUT_RESPONSE_INVALID"
      && error.retryable,
  );
});

test("AWS SMS sending uses only the transactional text-message contract", async (context) => {
  const nativeFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = nativeFetch; });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return Response.json({ MessageId: "provider-message-1" });
  };
  assert.deepEqual(await sendSmsWithAws({
    to: "+18175550100",
    text: "QuickDucks: your heat is up next. Reply STOP to opt out.",
  }, env), { providerMessageId: "provider-message-1" });
  assert.equal(new URL(request.url).pathname, "/v2/sms-voice/text-message");
  assert.deepEqual(request.body, {
    DestinationPhoneNumber: "+18175550100",
    OriginationIdentity: "+15555550100",
    MessageBody: "QuickDucks: your heat is up next. Reply STOP to opt out.",
    MessageType: "TRANSACTIONAL",
  });
});
