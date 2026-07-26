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
  assert.match(body, /My ducks/);
  assert.match(body, /Find race status by name/);
  assert.match(body, /src="\/assets\/home\.js"/);
  assert.match(body, /href="\/favicon\.svg"/);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

test("serves the home-page status client", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/assets/home.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(body, /\/api\/v1\/registrations\/mine/);
  assert.match(body, /\/api\/v1\/race-status\/search/);
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
  assert.match(registrationBody, /visible only to logged-in authorized race staff/);
  assert.match(registrationBody, /permanently deletes the complete race/);
  assert.match(await confirmation.text(), /DUCK8234/);
  assert.equal(confirmation.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("redirects an anonymous unpaired duck scan home", async () => {
  const unpairedEnv = {
    ...env,
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() { return null; },
      }),
    },
  };
  const response = await worker.fetch(
    new Request(`https://quickducks.com/t/${"a".repeat(32)}`),
    unpairedEnv,
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
});

test("renders paired duck heat and race status without contact data", async () => {
  const pairedEnv = {
    ...env,
    DB: {
      prepare: (sql) => ({
        bind() { return this; },
        async first() {
          if (sql.includes("FROM heats")) {
            return { round: "ROUND_ONE", heat_number: 5, status: "RUNNING" };
          }
          return {
            event_id: "event_test",
            event_slug: "summer-duck-race",
            event_name: "Summer Duck Race",
            event_date: "2026-08-30",
            event_status: "ROUND_ONE",
            public_name_policy: "FIRST_NAME_LAST_INITIAL",
            first_name: "Daisy",
            last_name: "Duck",
            registration_status: "ACTIVE",
            race_entry_id: "entry_test",
            visible_number: 42,
            round_one_heat_number: 7,
            round_one_heat_status: "PLANNED",
            round_one_place: null,
            final_heat_number: null,
            final_heat_status: null,
            final_place: null,
          };
        },
      }),
    },
  };
  const response = await worker.fetch(
    new Request(`https://quickducks.com/t/${"a".repeat(32)}`),
    pairedEnv,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Daisy D\./);
  assert.match(body, /Heat 7/);
  assert.match(body, /Heat 5/);
  assert.doesNotMatch(body, /Email|Phone|lookup code/i);
});

test("renders a valid private registration status path", async () => {
  const privateEnv = {
    ...env,
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() {
          return {
            first_name: "Daisy",
            last_name: "Duck",
            status: "SUBMITTED",
            lookup_code: "ABCD2345",
            submitted_at: "2026-07-26T00:00:00.000Z",
            event_name: "Summer Duck Race",
            event_date: "2026-08-30",
            duck_keep_preference: "UNDECIDED",
          };
        },
      }),
    },
  };
  const response = await worker.fetch(
    new Request(`https://quickducks.com/r/${"a".repeat(43)}`),
    privateEnv,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Daisy/);
  assert.match(body, /ABCD2345/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("renders protected staff pairing preview with code and name lookup", async () => {
  const response = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/ducks/128/pair"),
    env,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Participant duck code/);
  assert.match(body, /Search participant name/);
  assert.match(body, /Staff authentication required/);
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
