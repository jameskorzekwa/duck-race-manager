import assert from "node:assert/strict";
import test from "node:test";

import worker, { createWorker } from "./index.ts";
import { renderStaffHome } from "./site.ts";

const env = {
  APP_ORIGIN: "https://quickducks.com",
  AWS_REGION: "us-east-1",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
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

test("renders the responsive landing page", async () => {
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
  assert.match(body, /\/api\/v1\/race-status\/search/);
});

test("serves registration and staff pairing browser clients", async () => {
  const registration = await worker.fetch(new Request("https://quickducks.com/assets/register.js"), env);
  const staff = await worker.fetch(new Request("https://quickducks.com/assets/staff-duck.js"), env);
  const staffHome = await worker.fetch(new Request("https://quickducks.com/assets/staff-home.js"), env);
  const live = await worker.fetch(new Request("https://quickducks.com/assets/live.js"), env);
  const startLine = await worker.fetch(new Request("https://quickducks.com/assets/start-line.js"), env);
  const finishLine = await worker.fetch(new Request("https://quickducks.com/assets/finish-line.js"), env);

  assert.equal(registration.status, 200);
  assert.equal(registration.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await registration.text(), /\/api\/v1\/registrations/);
  assert.equal(staff.status, 200);
  assert.equal(staff.headers.get("cache-control"), "no-store");
  assert.match(await staff.text(), /\/api\/v1\/staff\/ducks/);
  assert.equal(staffHome.status, 200);
  assert.match(await staffHome.text(), /\/api\/v1\/staff\/events\/return-review/);
  assert.match(await live.text(), /\/api\/v1\/race-board/);
  assert.equal(live.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await startLine.text(), /\/api\/v1\/live/);
  assert.equal(startLine.headers.get("cache-control"), "no-store");
  assert.match(await finishLine.text(), /NDEFReader/);
  assert.equal(finishLine.headers.get("cache-control"), "no-store");
});

test("gates focused station pages by operational role", async () => {
  const actor = (roles, isSystemAdmin = false) => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Station Staff",
    isSystemAdmin, roles, authentication: "bearer",
  });
  const page = (currentActor, path) => createWorker(async () => currentActor).fetch(
    new Request(`https://quickducks.com${path}`), env,
  );

  const anonymous = await page(null, "/staff/start-line");
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get("location") ?? "", /returnTo=%2Fstaff%2Fstart-line/);

  const heatStart = await page(actor(["HEAT_RUNNER"]), "/staff/start-line");
  const heatFinish = await page(actor(["HEAT_RUNNER"]), "/staff/finish-line");
  assert.equal(heatStart.status, 200);
  assert.match(await heatStart.text(), /Prepare the next heat/);
  assert.equal(heatFinish.status, 403);

  const resultStart = await page(actor(["RESULT_TAKER"]), "/staff/start-line");
  const resultFinish = await page(actor(["RESULT_TAKER"]), "/staff/finish-line");
  assert.equal(resultStart.status, 403);
  assert.equal(resultFinish.status, 200);
  const finishBody = await resultFinish.text();
  assert.match(finishBody, /Record one official result/);
  assert.match(finishBody, /Tag URL or duck number/);
  assert.doesNotMatch(finishBody, /participant email|participant phone/i);

  assert.equal((await page(actor(["RACE_DIRECTOR"]), "/staff/start-line")).status, 200);
  assert.equal((await page(actor(["RACE_DIRECTOR"]), "/staff/finish-line")).status, 200);
  assert.equal((await page(actor([], true), "/staff/start-line")).status, 200);
  assert.equal((await page(actor([], true), "/staff/finish-line")).status, 200);
});

test("protects newly composed staff operation routes", async () => {
  const response = await worker.fetch(
    new Request("https://quickducks.com/api/v1/staff/inventory/ducks"),
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await response.json(), { error: "Staff authentication required." });
});

test("serves the rubber-duck favicon", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/favicon.svg"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assert.match(body, /#ffd43b/);
});

test("renders working registration UI while protection remains fail-closed", async () => {
  const registration = await worker.fetch(new Request("https://quickducks.com/register"), env);
  const confirmation = await worker.fetch(new Request("https://quickducks.com/r/mock"), env);
  const registrationBody = await registration.text();

  assert.match(registrationBody, /Register participant/);
  assert.match(registrationBody, /data-protection-ready="false"/);
  assert.match(registrationBody, /src="\/assets\/register\.js"/);
  assert.doesNotMatch(registrationBody, /email updates/i);
  assert.match(registrationBody, /data-public-name-policy/);
  assert.match(registrationBody, /visible only to logged-in authorized race staff/);
  assert.match(registrationBody, /permanently deletes the complete race/);
  assert.match(await confirmation.text(), /DUCK8234/);
  assert.equal(confirmation.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("renders the Turnstile widget only when its public key is configured", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/register"), {
    ...env,
    TURNSTILE_SITE_KEY: "site-key-test",
    TURNSTILE_SECRET_KEY: "secret-key-test",
  });
  const body = await response.text();

  assert.match(body, /data-sitekey="site-key-test"/);
  assert.match(body, /challenges\.cloudflare\.com\/turnstile/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-src https:\/\/challenges\.cloudflare\.com/);
});

test("renders staff sign-in and protects staff duck pages", async () => {
  const staff = await worker.fetch(new Request("https://quickducks.com/staff?returnTo=%2Ft%2Ftoken"), env);
  const protectedDuck = await worker.fetch(
    new Request(`https://quickducks.com/staff/ducks/${"a".repeat(32)}`),
    env,
  );
  const staffBody = await staff.text();

  assert.equal(staff.status, 200);
  assert.match(staffBody, /Continue to secure sign in/);
  assert.match(staffBody, /returnTo=%2Ft%2Ftoken/);
  assert.equal(protectedDuck.status, 303);
  assert.match(protectedDuck.headers.get("location") ?? "", /^\/staff\?returnTo=/);
});

test("starts hosted Cognito sign-in and renders safe callback failures", async () => {
  const start = await worker.fetch(
    new Request("https://quickducks.com/staff/login/start?returnTo=%2Fstaff"),
    env,
  );
  const callback = await worker.fetch(
    new Request("https://quickducks.com/auth/callback?error=access_denied"),
    env,
  );

  assert.equal(start.status, 302);
  assert.match(start.headers.get("location") ?? "", /^https:\/\/quickducks-staff\.example\.com\/oauth2\/authorize/);
  assert.match(start.headers.get("set-cookie") ?? "", /__Host-quickducks_oauth=/);
  assert.equal(start.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(callback.status, 400);
  assert.match(await callback.text(), /sign-in request expired/i);
  assert.match(callback.headers.get("set-cookie") ?? "", /__Host-quickducks_oauth=;/);
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
      prepare: (sql) => ({
        bind() { return this; },
        async first() {
          if (sql.includes("FROM registrations r")) {
            return {
              first_name: "Daisy",
              last_name: "Duck",
              status: "ACTIVE",
              lookup_code: "ABCD2345",
              submitted_at: "2026-07-26T00:00:00.000Z",
              event_name: "Summer Duck Race",
              event_date: "2026-08-30",
              race_entry_id: "entry_test",
              duck_keep_preference: "UNDECIDED",
            };
          }
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
    new Request(`https://quickducks.com/r/${"a".repeat(43)}`),
    privateEnv,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Daisy/);
  assert.match(body, /ABCD2345/);
  assert.match(body, /Duck #42/);
  assert.match(body, /Round one · Heat 7/);
  assert.match(body, /Round one · Heat 5/);
  assert.match(body, /Not raced/);
  assert.doesNotMatch(body, /daisy@example\.com|555-0100/);
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

  const working = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/ducks/128/working"),
    env,
  );
  const workingBody = await working.text();
  assert.match(workingBody, /data-staff-duck/);
  assert.match(workingBody, /data-disposition-form/);
  assert.match(workingBody, /\/assets\/staff-duck\.js/);

  const staffHome = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/home"),
    env,
  );
  const staffHomeBody = await staffHome.text();
  assert.match(staffHomeBody, /data-return-review/);
  assert.match(staffHomeBody, /data-system-admin="true"/);
  assert.match(staffHomeBody, /data-staff-access-form/);
  assert.match(staffHomeBody, /id="events"/);
  assert.match(staffHomeBody, /id="participants"/);
  assert.match(staffHomeBody, /id="inventory"/);
  assert.match(staffHomeBody, /id="heats"/);
  assert.match(staffHomeBody, /id="returns"/);
  assert.match(staffHomeBody, /id="support"/);
  assert.match(staffHomeBody, /data-final-purge-form/);
  assert.match(staffHomeBody, /Regular staff/);
  assert.match(staffHomeBody, /Administrator/);
  assert.match(staffHomeBody, /\/assets\/staff-home\.js/);

  const startLine = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/start-line"),
    env,
  );
  const finishLine = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/finish-line"),
    env,
  );
  assert.match(await startLine.text(), /data-start-line/);
  assert.match(await finishLine.text(), /data-finish-line/);

  const regularStaffHome = renderStaffHome("Regular Staff", false, ["RETURN_STEWARD"]);
  assert.doesNotMatch(regularStaffHome, /data-staff-access-form/);
  assert.doesNotMatch(regularStaffHome, /Administrators have deletion authority/);
  assert.doesNotMatch(regularStaffHome, /id="support"/);
  assert.doesNotMatch(regularStaffHome, /data-final-purge-form/);
  assert.match(regularStaffHome, /data-return-batch-item-form/);
  assert.match(regularStaffHome, /<a href="#returns">Returns<\/a>/);
  assert.doesNotMatch(regularStaffHome, /<a href="#participants">Participants<\/a>/);
  assert.match(regularStaffHome, /id="participants"[^>]* hidden/);
  assert.match(regularStaffHome, /id="returns"/);

  const announcerHome = renderStaffHome("Announcer", false, ["ANNOUNCER"]);
  assert.match(announcerHome, /<a href="#heats">Heats<\/a>/);
  assert.match(announcerHome, /id="inventory"[^>]* hidden/);
  assert.match(announcerHome, /data-roles="ANNOUNCER"/);

  const heatRunnerHome = renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"]);
  assert.match(heatRunnerHome, /href="\/staff\/start-line"/);
  assert.doesNotMatch(heatRunnerHome, /href="\/staff\/finish-line"/);
  const resultTakerHome = renderStaffHome("Result Taker", false, ["RESULT_TAKER"]);
  assert.match(resultTakerHome, /href="\/staff\/finish-line"/);
  assert.doesNotMatch(resultTakerHome, /href="\/staff\/start-line"/);

  const noRoleHome = renderStaffHome("No Role", false, []);
  assert.match(noRoleHome, /No operational roles assigned/);
  assert.doesNotMatch(noRoleHome, /src="\/assets\/staff-home\.js"/);
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
