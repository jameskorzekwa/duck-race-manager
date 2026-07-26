import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";

const env = {
  APP_ORIGIN: "https://quickducks.com",
  AWS_REGION: "us-east-1",
  DB: {
    prepare: () => ({
      async first() {
        return { ok: 1 };
      },
    }),
  },
};

test("redirects HTTP requests to canonical HTTPS", async () => {
  const response = await worker.fetch(
    new Request("http://quickducks.com/api/v1/events/current"),
    env,
  );

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://quickducks.com/api/v1/events/current");
});

test("redirects alternate hosts to the canonical origin", async () => {
  const response = await worker.fetch(new Request("https://www.quickducks.com/"), env);

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://quickducks.com/");
});

test("renders the responsive landing-page mockup", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(body, /Find your duck\. Follow the race\./);
  assert.match(body, /href="\/favicon\.svg"/);
});

test("serves the rubber-duck favicon", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/favicon.svg"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(body, /#ffd43b/);
});

test("renders the clickable registration and status mockups", async () => {
  const registration = await worker.fetch(new Request("https://quickducks.com/register"), env);
  const confirmation = await worker.fetch(new Request("https://quickducks.com/r/mock"), env);
  const registrationBody = await registration.text();

  assert.match(registrationBody, /Preview confirmation/);
  assert.match(registrationBody, /You can disable these later/);
  assert.doesNotMatch(registrationBody, /After the race/);
  assert.match(await confirmation.text(), /DUCK-824/);
  assert.equal(confirmation.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("keeps the database health check", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/health"), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: "quickducks",
    status: "ok",
    database: "connected",
    region: "us-east-1",
  });
});

test("renders a secured noindex not-found page", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/missing"), env);
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /Nothing is swimming here/);
});
