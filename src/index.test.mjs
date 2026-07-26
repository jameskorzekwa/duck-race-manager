import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";
import { registrationCookie } from "./browser-registrations.ts";

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

test("shows multiple participant registrations from one browser cookie", async () => {
  const firstStatusPath = `/r/${"a".repeat(43)}`;
  const secondStatusPath = `/r/${"b".repeat(43)}`;
  const firstCookie = registrationCookie(null, {
    name: "Daisy Duck",
    lookupCode: "ABCD2345",
    statusPath: firstStatusPath,
  });
  const cookie = registrationCookie(firstCookie, {
    name: "Donald Duck",
    lookupCode: "WXYZ6789",
    statusPath: secondStatusPath,
  });
  const response = await worker.fetch(new Request("https://quickducks.com/", {
    headers: { cookie },
  }), env);
  const body = await response.text();

  assert.match(body, /Your registrations/);
  assert.match(body, /Daisy Duck/);
  assert.match(body, /Donald Duck/);
  assert.match(body, /ABCD2345/);
  assert.match(body, /WXYZ6789/);
  assert.match(body, new RegExp(firstStatusPath));
  assert.match(body, new RegExp(secondStatusPath));
  assert.match(body, /Register another participant/);
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
      prepare: () => ({
        bind() { return this; },
        async first() {
          return {
            first_name: "Daisy",
            last_name: "Duck",
            registration_status: "ACTIVE",
            event_name: "Summer Duck Race",
            event_status: "ROUND_ONE",
            visible_number: 42,
            round_type: "ROUND_ONE",
            heat_number: 7,
            heat_status: "PLANNED",
            current_heat_number: 5,
            current_heat_round: "ROUND_ONE",
            result_position: null,
            advanced: 0,
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
  assert.match(body, /Daisy Duck/);
  assert.match(body, /Heat 7/);
  assert.match(body, /Heat 5/);
  assert.doesNotMatch(body, /Email|Phone|lookup code/i);
});

test("opens a persisted private status path from the home-page cookie", async () => {
  const privateEnv = {
    ...env,
    DB: {
      prepare: () => ({
        bind() { return this; },
        async first() {
          return {
            first_name: "Daisy",
            last_name: "Duck",
            email: "daisy@example.com",
            phone: null,
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
