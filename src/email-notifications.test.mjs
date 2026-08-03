import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EmailSendError,
  handleEmailQueue,
  isSmsOptedOutByAws,
  sendEmailWithSes,
  sendSmsWithAws,
} from "./email-notifications.ts";
import worker from "./index.ts";

const config = (name) => JSON.parse(
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll(/^\s*\/\/.*$/gm, ""),
);

const sesEnv = {
  APP_ORIGIN: "https://quickducks.com",
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE1234567",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-that-is-long-enough-for-sigv4",
  EMAIL_FROM_ADDRESS: "race@quickducks.com",
};

const outboundEmail = {
  from: "race@quickducks.com",
  to: "racer@example.test",
  subject: "Round One, Heat 2 is being called now",
  text: "Please bring Duck #17 to the pond.",
  html: "<p>Please bring Duck #17 to the pond.</p>",
};

const smsEnv = {
  ...sesEnv,
  NOTIFICATION_HMAC_SECRET: "test-notification-hmac-secret-32-bytes-minimum",
  SMS_ORIGINATION_IDENTITY: "+18005550199",
  SMS_OPT_OUT_LIST_NAME: "quickducks-production",
};

const fixedDate = (context) => {
  const NativeDate = globalThis.Date;
  const now = "2026-08-01T12:34:56.000Z";
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [now] : args));
    }

    static now() {
      return NativeDate.parse(now);
    }
  };
  context.after(() => { globalThis.Date = NativeDate; });
};

const expectSendError = async (promise, safeCode, retryable) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof EmailSendError);
    assert.equal(error.safeCode, safeCode);
    assert.equal(error.retryable, retryable);
    assert.equal(error.message, safeCode);
    return true;
  });
};

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

test("SES v2 requests have a deterministic SigV4 signature and structured UTF-8 body", async (context) => {
  fixedDate(context);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ MessageId: "ses-message/123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  assert.deepEqual(await sendEmailWithSes(outboundEmail, sesEnv), {
    providerMessageId: "ses-message/123",
  });
  assert.equal(request.url, "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  assert.equal(request.options.method, "POST");
  const expectedBody = JSON.stringify({
    FromEmailAddress: outboundEmail.from,
    Destination: { ToAddresses: [outboundEmail.to] },
    Content: {
      Simple: {
        Subject: { Data: outboundEmail.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: outboundEmail.text, Charset: "UTF-8" },
          Html: { Data: outboundEmail.html, Charset: "UTF-8" },
        },
      },
    },
  });
  assert.equal(request.options.body, expectedBody);

  const payloadHash = createHash("sha256").update(expectedBody).digest("hex");
  const amzDate = "20260801T123456Z";
  const date = "20260801";
  const host = "email.us-east-1.amazonaws.com";
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/us-east-1/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const sign = (key, value) => createHmac("sha256", key).update(value).digest();
  const dateKey = sign(`AWS4${sesEnv.AWS_SECRET_ACCESS_KEY}`, date);
  const regionKey = sign(dateKey, "us-east-1");
  const serviceKey = sign(regionKey, "ses");
  const signingKey = sign(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  assert.deepEqual(request.options.headers, {
    authorization: `AWS4-HMAC-SHA256 Credential=${sesEnv.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
});

test("SES failures are safely classified without reading provider response bodies", async (context) => {
  fixedDate(context);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => { throw new Error("private network detail"); };
  await expectSendError(sendEmailWithSes(outboundEmail, sesEnv), "DELIVERY_OUTCOME_UNKNOWN", false);

  for (const [status, safeCode, retryable] of [
    [408, "SES_TEMPORARY_FAILURE", true],
    [429, "SES_TEMPORARY_FAILURE", true],
    [503, "SES_TEMPORARY_FAILURE", true],
    [400, "SES_REJECTED", false],
  ]) {
    let bodyRead = false;
    globalThis.fetch = async () => ({
      ok: false,
      status,
      async json() { bodyRead = true; return { recipient: outboundEmail.to }; },
      async text() { bodyRead = true; return outboundEmail.text; },
    });
    await expectSendError(sendEmailWithSes(outboundEmail, sesEnv), safeCode, retryable);
    assert.equal(bodyRead, false, `provider body is ignored for HTTP ${status}`);
  }
});

test("SES acceptance does not depend on a usable provider message ID", async (context) => {
  fixedDate(context);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const body of [
    JSON.stringify({}),
    JSON.stringify({ MessageId: "contains spaces" }),
    JSON.stringify({ MessageId: "x".repeat(257) }),
    "not-json",
  ]) {
    globalThis.fetch = async () => new Response(body, { status: 202 });
    assert.deepEqual(await sendEmailWithSes(outboundEmail, sesEnv), { providerMessageId: null });
  }
});

test("AWS SMS uses the transactional API and checks every configured opt-out-list page", async (context) => {
  fixedDate(context);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("opted-out-numbers")) {
      return requests.filter((request) => request.url.includes("opted-out-numbers")).length === 1
        ? Response.json({
          OptedOutNumbers: [{ OptedOutNumber: "+18175550000" }],
          NextToken: "next+/= page",
        })
        : Response.json({ OptedOutNumbers: [{ OptedOutNumber: "+18173206150" }] });
    }
    return Response.json({ MessageId: "sms-message-123" });
  };
  assert.deepEqual(await sendSmsWithAws({
    to: "+18173206150",
    text: "Your heat is next. Reply STOP to opt out.",
  }, smsEnv), { providerMessageId: "sms-message-123" });
  assert.equal(requests[0].url, "https://sms-voice.us-east-1.amazonaws.com/v1/sms/text");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    DestinationPhoneNumber: "+18173206150",
    OriginationIdentity: "+18005550199",
    MessageBody: "Your heat is next. Reply STOP to opt out.",
    MessageType: "TRANSACTIONAL",
  });
  assert.equal(await isSmsOptedOutByAws("+18173206150", smsEnv), true);
  assert.equal(
    requests[1].url,
    "https://sms-voice.us-east-1.amazonaws.com/v1/sms/opt-out-lists/quickducks-production/opted-out-numbers?MaxResults=100",
  );
  assert.equal(requests[1].options.method, "GET");
  assert.equal(requests[1].options.body, undefined);
  assert.equal(
    requests[2].url,
    "https://sms-voice.us-east-1.amazonaws.com/v1/sms/opt-out-lists/quickducks-production/opted-out-numbers?MaxResults=100&NextToken=next%2B%2F%3D%20page",
  );
  assert.equal(requests[2].options.method, "GET");
  assert.match(requests[2].options.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
});

test("ambiguous SMS transport outcomes are terminal", async (context) => {
  fixedDate(context);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("ambiguous network outcome"); };
  await expectSendError(sendSmsWithAws({
    to: "+18173206150",
    text: "Your heat is next. Reply STOP to opt out.",
  }, smsEnv), "DELIVERY_OUTCOME_UNKNOWN", false);
});

test("invalid or missing SES configuration fails closed before fetch", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    assert.fail("invalid SES configuration must not make a request");
  };
  for (const env of [
    { ...sesEnv, AWS_REGION: "us-west-2" },
    { ...sesEnv, EMAIL_FROM_ADDRESS: "other@example.test" },
    { ...sesEnv, AWS_ACCESS_KEY_ID: undefined },
    { ...sesEnv, AWS_SECRET_ACCESS_KEY: undefined },
  ]) {
    await expectSendError(sendEmailWithSes(outboundEmail, env), "SES_CONFIGURATION_INVALID", false);
  }
  assert.equal(fetchCalled, false);
});
