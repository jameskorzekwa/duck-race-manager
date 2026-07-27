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

const androidChromeUserAgent = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
const iPhoneUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const desktopChromeUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

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
  assert.match(body, /<a href="\/my-ducks" data-my-ducks-nav hidden>My Ducks<\/a>/);
  assert.doesNotMatch(body, /Saved on this device|data-my-ducks-list/);
  assert.match(body, /Find race status by name/);
  assert.match(body, /src="\/assets\/home\.js"/);
  assert.match(body, /src="\/assets\/participant\.js"/);
  assert.match(body, /src="\/assets\/live-ui\.js"/);
  assert.match(body, /href="\/favicon\.svg"/);
  assert.match(body, /<div class="hero-water" aria-hidden="true"><\/div>/);
  assert.match(body, /background-size:var\(--wave-length\) 3rem/);
  assert.match(body, /@keyframes water-flow \{ to \{ background-position:-10rem 0/);
  assert.match(body, /transform-box:fill-box; transform-origin:center/);
  assert.match(body, /@keyframes duck-rock[^@]+translateY\(-12px\) rotate\(3deg\)/);
  assert.match(body, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(body, /radial-gradient\(ellipse|M8 61c12 5|preserveAspectRatio="none"/);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("serves the home-page status client", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/assets/home.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(body, /\/api\/v1\/race-status\/search/);
  assert.match(body, /\/api\/v1\/registrations\/mine\/follow/);
});

test("the public home page explains the race without linking out of its cards", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/"), env);
  const body = await response.text();
  const explainers = body.match(/<section id="how-it-works"[\s\S]*?<\/section>/)?.[0];

  assert.equal(response.status, 200);
  assert.ok(explainers);
  assert.equal((explainers.match(/<a\b/g) ?? []).length, 0);
  assert.doesNotMatch(explainers, /href=/);
  assert.match(explainers, /<strong>Before the race<\/strong>/);
  assert.match(explainers, /<strong>At check-in<\/strong>/);
  assert.match(explainers, /<strong>On race day<\/strong>/);
  assert.doesNotMatch(body, /Open registration →|Open staff tools →|Preview status →/);
});

test("serves registration and staff pairing browser clients", async () => {
  const registration = await worker.fetch(new Request("https://quickducks.com/assets/register.js"), env);
  const participant = await worker.fetch(new Request("https://quickducks.com/assets/participant.js"), env);
  const staff = await worker.fetch(new Request("https://quickducks.com/assets/staff-duck.js"), env);
  const staffHome = await worker.fetch(new Request("https://quickducks.com/assets/staff-home.js"), env);
  const staffAccess = await worker.fetch(new Request("https://quickducks.com/assets/staff-access.js"), env);
  const live = await worker.fetch(new Request("https://quickducks.com/assets/live.js"), env);
  const liveUi = await worker.fetch(new Request("https://quickducks.com/assets/live-ui.js"), env);
  const startLine = await worker.fetch(new Request("https://quickducks.com/assets/start-line.js"), env);
  const finishLine = await worker.fetch(new Request("https://quickducks.com/assets/finish-line.js"), env);
  const inventoryIntake = await worker.fetch(new Request("https://quickducks.com/assets/inventory-intake.js"), env);
  const liveUiBody = await liveUi.text();

  assert.equal(registration.status, 200);
  assert.equal(registration.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await registration.text(), /\/api\/v1\/registrations/);
  assert.equal(participant.status, 200);
  assert.equal(participant.headers.get("cache-control"), "public, max-age=3600");
  assert.match(await participant.text(), /\/api\/v1\/registrations\/mine/);
  assert.equal(staff.status, 200);
  assert.equal(staff.headers.get("cache-control"), "no-store");
  assert.match(await staff.text(), /\/api\/v1\/staff\/ducks/);
  assert.equal(staffHome.status, 200);
  assert.equal(staffHome.headers.get("cache-control"), "no-store");
  assert.match(await staffHome.text(), /\/api\/v1\/staff\/events\/return-review/);
  // The staff access client is served like the other protected staff assets.
  assert.equal(staffAccess.status, 200);
  assert.equal(staffAccess.headers.get("cache-control"), "no-store");
  assert.match(staffAccess.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(staffAccess.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(await staffAccess.text(), /\/api\/v1\/staff\/profiles/);
  assert.match(await live.text(), /\/api\/v1\/race-board/);
  assert.equal(live.headers.get("cache-control"), "public, max-age=3600");
  assert.match(liveUiBody, /\/api\/v1\/live/);
  assert.match(liveUiBody, /\/api\/v1\/staff\/session/);
  assert.equal(liveUi.headers.get("cache-control"), "no-store");
  assert.match(await startLine.text(), /quickDucksLive\.subscribe/);
  assert.equal(startLine.headers.get("cache-control"), "no-store");
  assert.match(await finishLine.text(), /NDEFReader/);
  assert.equal(finishLine.headers.get("cache-control"), "no-store");
  assert.match(await inventoryIntake.text(), /intakeCreateProvisioningMachine/);
  assert.equal(inventoryIntake.headers.get("cache-control"), "no-store");
});

test("renders the private My Ducks page with two accessible horizontal sections", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/my-ducks"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(body, /<h2 id="awaiting-participants-title">Awaiting Participants<\/h2>/);
  assert.match(body, /<h2 id="paired-participants-title">My Ducks<\/h2>/);
  assert.match(body, /data-carousel-previous/);
  assert.match(body, /data-carousel-next/);
  assert.match(body, /tabindex="0" aria-label="Awaiting participant registrations"/);
  assert.match(body, /scroll-snap-type:x mandatory/);
  assert.doesNotMatch(body, /data-my-ducks-freshness|Loading saved registrations|Updated just now/);
  assert.match(body, /<p class="message-line muted" data-my-ducks-error role="alert" hidden><\/p>/);
  // Neither group ships a per-section empty state; an empty group hides its
  // whole section and the page keeps one guidance message instead.
  assert.doesNotMatch(body, /data-carousel-empty/);
  assert.match(body, /data-participant-section="awaiting" aria-labelledby="awaiting-participants-title" hidden>/);
  assert.match(body, /data-participant-section="paired" aria-labelledby="paired-participants-title" hidden>/);
  assert.match(body, /<p class="empty-state" data-my-ducks-empty hidden>No registrations are saved on this device yet\./);
  assert.match(body, /Register another participant/);
  assert.match(body, /src="\/assets\/participant\.js"/);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
});

test("gates the Android inventory intake station after authentication and role checks", async () => {
  const actor = (roles, isSystemAdmin = false) => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Inventory Staff",
    isSystemAdmin, roles, authentication: "bearer",
  });
  const page = (currentActor, userAgent) => createWorker(async () => currentActor).fetch(
    new Request("https://quickducks.com/staff/inventory-intake", {
      headers: userAgent === undefined ? {} : { "user-agent": userAgent },
    }), env,
  );

  const anonymous = await page(null, iPhoneUserAgent);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/staff?returnTo=%2Fstaff%2Finventory-intake");

  const denied = await page(actor(["REGISTRATION"]), desktopChromeUserAgent);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await denied.text(), /permission to use the inventory intake station/);

  for (const userAgent of [iPhoneUserAgent, desktopChromeUserAgent, undefined]) {
    const unsupported = await page(actor(["DUCK_MANAGER"]), userAgent);
    const body = await unsupported.text();
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(unsupported.headers.get("vary"), "User-Agent");
    assert.match(body, /Unsupported device/);
    assert.match(body, /Back to staff inventory/);
    assert.match(body, /compatibility check, not an authorization control/);
    assert.doesNotMatch(body, /data-inventory-intake|data-app-origin|inventory-intake\.js|\/api\/v1\/|\/t\//);
  }

  for (const currentActor of [actor(["DUCK_MANAGER"]), actor(["RACE_DIRECTOR"]), actor([], true)]) {
    const allowed = await page(currentActor, androidChromeUserAgent);
    const body = await allowed.text();
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(allowed.headers.get("vary"), "User-Agent");
    assert.match(body, /data-inventory-intake/);
    assert.match(body, /data-app-origin="https:\/\/quickducks\.com"/);
    assert.match(body, /data-intake-controls hidden/);
    assert.match(body, /Checking this device/);
    assert.match(body, /Reserved for race/);
    assert.match(body, /Added this session/);
    assert.match(body, /Start NFC provisioning/);
    assert.match(body, /End NFC provisioning/);
    assert.match(body, /data-end-intake-nfc hidden disabled/);
    assert.match(body, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(body, /data-end-intake-nfc[^>]*class="button secondary station-control"|class="button secondary station-control"[^>]*data-end-intake-nfc/);
    assert.match(body, /Android Chrome over HTTPS only/);
    assert.match(body, /data-intake-takeover hidden/);
    assert.match(body, /Take over pending sticker/);
    assert.doesNotMatch(body, /name="visibleNumber"|name="tagUrl"|name="condition"|name="physicallyPresent"/);
    assert.match(body, /src="\/assets\/inventory-intake\.js"/);
  }
});

test("gates the standalone staff access page to system administrators", async () => {
  const actor = (roles, isSystemAdmin = false) => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Access Staff",
    isSystemAdmin, roles, authentication: "bearer",
  });
  const page = (currentActor) => createWorker(async () => currentActor).fetch(
    new Request("https://quickducks.com/staff/access"), env,
  );

  // Anonymous: redirect to sign-in with a safe same-origin return target.
  const anonymous = await page(null);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/staff?returnTo=%2Fstaff%2Faccess");

  // Authenticated non-administrators: 403 through the shared staff auth error.
  for (const roles of [[], ["REGISTRATION"], ["RACE_DIRECTOR"], ["DUCK_MANAGER", "RETURN_STEWARD"]]) {
    const denied = await page(actor(roles));
    const body = await denied.text();
    assert.equal(denied.status, 403, roles.join(","));
    assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.match(body, /permission to manage staff access/);
    assert.doesNotMatch(body, /data-staff-access-form|data-staff-access-list/);
  }

  // Administrator: the page renders with the staff page header contract.
  const allowed = await page(actor([], true));
  const body = await allowed.text();
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal(allowed.headers.get("referrer-policy"), "same-origin");
  assert.match(
    allowed.headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/quickducks-staff\.example\.com; frame-ancestors/,
  );
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(body, /data-staff-access data-live-staff data-system-admin="true"/);
  assert.match(body, /data-staff-access-form/);
  assert.match(body, /data-staff-access-list/);
  assert.match(body, /src="\/assets\/staff-access\.js"/);
  assert.match(body, /src="\/assets\/app-select\.js"/);
  assert.match(body, /Signed in as Access Staff/);

  // Only GET renders the page; other methods fall through to not-found.
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await createWorker(async () => actor([], true)).fetch(
      new Request("https://quickducks.com/staff/access", { method }), env,
    );
    assert.equal(response.status, 404, method);
  }
});

test("propagates rotated session cookies from the staff access page", async () => {
  const response = await refreshWorker().fetch(
    new Request("https://quickducks.com/staff/access", { headers: { cookie: expiredSessionCookie } }),
    env,
  );
  const cookies = response.headers.get("set-cookie");

  // The refreshed actor is a regular staff member, so this is the 403 path and
  // it must still hand the browser its rotated cookies.
  assert.equal(response.status, 403);
  assert.match(cookies, /__Host-quickducks_staff=new\.jwt\.token/);
  assert.match(cookies, /__Host-quickducks_staff_refresh=new\.refresh\.token/);
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

test("requires same-origin protection for cookie-authenticated provisioning", async () => {
  const cookieActor = {
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Inventory Staff",
    isSystemAdmin: false, roles: ["DUCK_MANAGER"], authentication: "cookie",
  };
  const response = await createWorker(async () => cookieActor).fetch(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "user-agent": iPhoneUserAgent,
      },
      body: JSON.stringify({ commandId: crypto.randomUUID(), eventId: "event_test" }),
    }),
    env,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Same-origin staff request required." });

  const takeover = await createWorker(async () => ({
    ...cookieActor, roles: ["RACE_DIRECTOR"],
  })).fetch(
    new Request("https://quickducks.com/api/v1/staff/inventory/provisioning/takeover", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: "event_test",
        duckId: "duck_test",
        provisioningCommandId: crypto.randomUUID(),
      }),
    }),
    env,
  );
  assert.equal(takeover.status, 403);
  assert.deepEqual(await takeover.json(), { error: "Same-origin staff request required." });
});

const refreshedActor = {
  id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Refreshed Staff",
  isSystemAdmin: false, roles: [], authentication: "bearer",
};

const refreshWorker = (tokenResponse = {
  access_token: "new.jwt.token",
  refresh_token: "new.refresh.token",
  expires_in: 1800,
}) => createWorker(
  async (request) => request.headers.get("cookie") === "__Host-quickducks_staff=new.jwt.token"
    ? refreshedActor
    : null,
  async () => Response.json(tokenResponse),
);

const expiredSessionCookie = "__Host-quickducks_staff=expired.jwt.token; __Host-quickducks_staff_refresh=old.refresh.token";

test("appends rotated session cookies to API responses and keeps the actor cookie-authenticated", async () => {
  const response = await refreshWorker().fetch(
    new Request("https://quickducks.com/api/v1/staff/unknown", {
      method: "POST",
      headers: { cookie: expiredSessionCookie, origin: env.APP_ORIGIN },
      body: "request-body-is-not-consumed-by-refresh",
    }),
    env,
  );
  const cookies = response.headers.get("set-cookie");

  assert.equal(response.status, 404);
  assert.match(cookies, /__Host-quickducks_staff=new\.jwt\.token/);
  assert.match(cookies, /__Host-quickducks_staff_refresh=new\.refresh\.token/);
});

test("appends rotated session cookies to staff page responses", async () => {
  const response = await refreshWorker().fetch(
    new Request("https://quickducks.com/staff", { headers: { cookie: expiredSessionCookie } }),
    env,
  );
  const cookies = response.headers.get("set-cookie");

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Refreshed Staff/);
  assert.match(cookies, /__Host-quickducks_staff=new\.jwt\.token/);
  assert.match(cookies, /__Host-quickducks_staff_refresh=new\.refresh\.token/);
});

test("clears both staff cookies when refresh rotation is invalid", async () => {
  const response = await refreshWorker({ access_token: "new.jwt.token" }).fetch(
    new Request("https://quickducks.com/api/v1/staff/unknown", {
      headers: { cookie: expiredSessionCookie },
    }),
    env,
  );
  const cookies = response.headers.get("set-cookie");

  assert.equal(response.status, 401);
  assert.match(cookies, /__Host-quickducks_staff=;/);
  assert.match(cookies, /__Host-quickducks_staff_refresh=;/);
});

test("preserves the refresh cookie when Cognito refresh is temporarily unavailable", async () => {
  const response = await createWorker(
    async () => null,
    async () => new Response("provider details", { status: 503 }),
  ).fetch(
    new Request("https://quickducks.com/api/v1/staff/unknown", {
      headers: { cookie: expiredSessionCookie },
    }),
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.deepEqual(await response.json(), { error: "Staff authentication required." });
});

test("does not refresh Bearer API requests", async () => {
  let refreshCalled = false;
  const bearerWorker = createWorker(
    async () => null,
    async () => {
      refreshCalled = true;
      throw new Error("must not refresh");
    },
  );
  const response = await bearerWorker.fetch(
    new Request("https://quickducks.com/api/v1/staff/unknown", {
      headers: {
        authorization: "Bearer expired.jwt.token",
        cookie: "__Host-quickducks_staff_refresh=old.refresh.token",
      },
    }),
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(refreshCalled, false);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("Cognito template keeps 15-minute tokens and seven-day refresh rotation", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = await readFile(new URL("../infra/aws/quickducks.yaml", import.meta.url), "utf8");

  assert.match(template, /AccessTokenValidity: 15/);
  assert.match(template, /IdTokenValidity: 15/);
  assert.match(template, /RefreshTokenValidity: 7/);
  assert.match(template, /AccessToken: minutes/);
  assert.match(template, /IdToken: minutes/);
  assert.match(template, /RefreshToken: days/);
  assert.match(template, /RefreshTokenRotation:\s+Feature: ENABLED/);
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
  assert.doesNotMatch(registrationBody, /duck_keep_preference|plan to keep|plan to return|not sure yet/i);
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
  assert.match(
    staff.headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/quickducks-staff\.example\.com; frame-ancestors/,
  );
  assert.equal(staff.headers.get("referrer-policy"), "same-origin");
  assert.equal(protectedDuck.status, 303);
  assert.match(protectedDuck.headers.get("location") ?? "", /^\/staff\?returnTo=/);
});

test("routes authenticated tag scans to protected code and contact pairing search", async () => {
  const token = "a".repeat(32);
  const authenticated = createWorker(async () => ({
    id: "staff_test",
    cognitoSub: "staff-sub",
    email: "staff@example.com",
    displayName: "Registration Staff",
    isSystemAdmin: false,
    roles: ["REGISTRATION"],
    authentication: "cookie",
  }));
  const scan = await authenticated.fetch(new Request(`https://quickducks.com/t/${token}`), env);
  const page = await authenticated.fetch(new Request(`https://quickducks.com/staff/ducks/${token}`), env);
  const body = await page.text();

  assert.equal(scan.status, 303);
  assert.equal(scan.headers.get("location"), `/staff/ducks/${token}`);
  assert.equal(page.status, 200);
  assert.match(body, /Participant code, name, phone, or email/);
  assert.match(body, /data-registration-search/);
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

test("rejects cross-site and non-POST logout without side effects", async () => {
  let revokeCalls = 0;
  const logoutWorker = createWorker(
    async () => null,
    async () => {
      revokeCalls += 1;
      return new Response(null, { status: 200 });
    },
  );
  const requests = [
    new Request("https://quickducks.com/staff/logout", {
      headers: { cookie: expiredSessionCookie, referer: "https://attacker.example/logout" },
    }),
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { cookie: expiredSessionCookie, origin: "https://attacker.example" },
    }),
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { cookie: expiredSessionCookie },
    }),
  ];

  for (const [index, request] of requests.entries()) {
    const response = await logoutWorker.fetch(request, env);
    assert.equal(response.status, index === 0 ? 405 : 403);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  }
  assert.equal(revokeCalls, 0);
});

test("accepts same-origin POST logout and clears cookies despite failed revocation", async () => {
  let revokeRequest;
  const response = await createWorker(
    async () => null,
    async (url, options) => {
      revokeRequest = { url: url.toString(), options };
      return Response.json({ error: "provider details must stay private" }, { status: 500 });
    },
  ).fetch(
    new Request("https://quickducks.com/staff/logout", {
      method: "POST",
      headers: { cookie: expiredSessionCookie, origin: env.APP_ORIGIN },
    }),
    env,
  );

  assert.equal(response.status, 303);
  assert.equal(revokeRequest.url, "https://quickducks-staff.example.com/oauth2/revoke");
  assert.match(response.headers.get("set-cookie"), /__Host-quickducks_staff=;/);
  assert.match(response.headers.get("set-cookie"), /__Host-quickducks_staff_refresh=;/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), null);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(response.headers.get("location"), /^https:\/\/quickducks-staff\.example\.com\/logout/);
  assert.equal(await response.text(), "");
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
  assert.doesNotMatch(body, /data-registration-search|Confirm duck pairing/);
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
              duck_keep_preference: "KEEP",
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
  assert.doesNotMatch(body, /duckKeepPreference|duck_keep_preference|plan to keep/i);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("renders protected staff pairing preview with code and contact lookup", async () => {
  const response = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/ducks/128/pair"),
    env,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Participant code, name, phone, or email/);
  assert.match(body, /Find participant/);
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
  // Staff access is its own page now; the console links to it and renders no
  // account-management markup.
  assert.doesNotMatch(staffHomeBody, /data-staff-access-form|data-create-role-set|id="access"/);
  assert.match(staffHomeBody, /<a href="\/staff\/access">Access<\/a>/);
  assert.match(staffHomeBody, /id="events"/);
  assert.match(staffHomeBody, /id="participants"/);
  assert.match(staffHomeBody, /id="inventory"/);
  assert.match(staffHomeBody, /id="heats"/);
  assert.match(staffHomeBody, /id="returns"/);
  assert.match(staffHomeBody, /id="support"/);
  assert.match(staffHomeBody, /data-final-purge-form/);
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
  assert.match(regularStaffHome, /<a href="#returns" data-event-scoped hidden>Returns<\/a>/);
  assert.doesNotMatch(regularStaffHome, /<a href="#participants"/);
  assert.match(regularStaffHome, /id="participants"[^>]* hidden/);
  assert.match(regularStaffHome, /id="returns"/);

  const announcerHome = renderStaffHome("Announcer", false, ["ANNOUNCER"]);
  assert.match(announcerHome, /<a href="#heats" data-event-scoped hidden>Heats<\/a>/);
  assert.match(announcerHome, /id="inventory"[^>]* hidden/);
  assert.match(announcerHome, /data-roles="ANNOUNCER"/);

  const heatRunnerHome = renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"]);
  assert.match(heatRunnerHome, /href="\/staff\/start-line"/);
  assert.doesNotMatch(heatRunnerHome, /href="\/staff\/finish-line"/);
  const resultTakerHome = renderStaffHome("Result Taker", false, ["RESULT_TAKER"]);
  assert.match(resultTakerHome, /href="\/staff\/finish-line"/);
  assert.doesNotMatch(resultTakerHome, /href="\/staff\/start-line"/);

  const duckManagerHome = renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]);
  assert.match(duckManagerHome, /href="\/staff\/inventory-intake"/);
  assert.match(duckManagerHome, /Blank NFC provisioning station/);
  assert.doesNotMatch(announcerHome, /href="\/staff\/inventory-intake"/);

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

const duckStatusRow = {
  event_id: "event_test",
  event_slug: "test-race",
  event_name: "Summer Duck Race",
  event_date: "2026-08-30",
  event_status: "FINAL",
  public_name_policy: "FIRST_NAME_LAST_INITIAL",
  first_name: "Jamie",
  last_name: "Rivera",
  registration_status: "ACTIVE",
  race_entry_id: "entry_test",
  visible_number: 128,
  round_one_heat_number: 7,
  round_one_heat_status: "FINALIZED",
  round_one_place: 2,
  final_heat_number: 1,
  final_heat_status: "FINALIZED",
  final_place: 1,
  email: "jamie@example.com",
  phone: "555-0100",
  lookup_code: "DUCK8234",
};

const duckPageEnv = (row = duckStatusRow) => ({
  ...env,
  DB: {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM race_entries")) return row;
          if (sql.includes("FROM heats")) return { round: "FINAL", heat_number: 1, status: "RUNNING" };
          if (sql.includes("FROM events")) {
            return {
              id: "event_test",
              name: "Summer Duck Race",
              event_date: "2026-08-30",
              status: "FINAL",
              public_name_policy: "FIRST_NAME_LAST_INITIAL",
            };
          }
          return null;
        },
      };
      return statement;
    },
  },
});

test("renders a public duck detail view addressed by the visible duck number", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/duck/128"), duckPageEnv());
  const body = await response.text();
  const panel = body.match(/<section class="page-panel">[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(body, /<h1 class="page-title">Duck #128<\/h1>/);
  assert.match(body, /<title>Duck #128 · QuickDucks<\/title>/);
  assert.match(body, /Follow this duck through Summer Duck Race\./);

  // Every fact the view promises, under the event's public-name policy.
  assert.match(body, /<dt>Participant<\/dt><dd>Jamie R\.<\/dd>/);
  assert.match(body, /<dt>Duck<\/dt><dd>Duck #128<\/dd>/);
  assert.match(body, /<dt>Round one heat<\/dt><dd>Heat 7 · Result official<\/dd>/);
  assert.match(body, /<dt>Final heat<\/dt><dd>Heat 1 · Result official<\/dd>/);
  assert.match(body, /<dt>Currently running<\/dt><dd>Final · Heat 1 · Racing now<\/dd>/);
  assert.match(body, /<dt>Race status<\/dt><dd>First place<\/dd>/);
  assert.match(body, /<dt>Official result<\/dt><dd>1st place · Official podium<\/dd>/);

  // It updates through the shared live hub like the other public pages.
  assert.match(body, /<div data-live-personal="number">/);
  assert.match(body, /data-live-board/);
  assert.match(body, /src="\/assets\/live\.js"/);
  assert.match(body, /src="\/assets\/live-ui\.js"/);

  // Public means public: no contact details, codes, tokens, or tag links.
  assert.doesNotMatch(body, /jamie@example\.com|555-0100|DUCK8234|Rivera/);
  assert.doesNotMatch(body, /href="\/t\//);
  assert.doesNotMatch(panel, /lookup code|private status|inventory|staff note/i);
});

test("an unknown or unpaired duck number renders a friendly not-found state", async () => {
  const missing = await worker.fetch(new Request("https://quickducks.com/duck/9999"), duckPageEnv(null));
  const body = await missing.text();
  const panel = body.match(/<section class="page-panel">[\s\S]*?<\/section>/)?.[0];

  assert.ok(panel);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(body, /Duck #9999 isn’t racing\./);
  assert.match(body, /No duck with this number is paired with a participant in the current race\./);
  assert.match(body, /href="\/"/);
  // A missing duck exposes no live surface and no enumeration detail: the copy
  // never distinguishes an unknown number from an unpaired inventory duck.
  assert.doesNotMatch(body, /data-live-personal/);
  assert.doesNotMatch(panel, /inventory|available|reserved|unpaired|does not exist|unknown/i);
});

test("non-canonical duck numbers fall through to the ordinary not-found page", async () => {
  for (const path of ["/duck/012", "/duck/0", "/duck/1234567890", "/duck/abc", "/duck/", "/duck/1/2"]) {
    const response = await worker.fetch(new Request(`https://quickducks.com${path}`), duckPageEnv());
    const body = await response.text();

    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", path);
    assert.doesNotMatch(body, /data-live-personal/, path);
  }
});

test("the duck detail route is read-only and leaves the tag scan flow untouched", async () => {
  const post = await worker.fetch(
    new Request("https://quickducks.com/duck/128", { method: "POST" }),
    duckPageEnv(),
  );
  assert.equal(post.status, 404);

  // An anonymous unpaired tag scan still redirects home rather than rendering.
  const scan = await worker.fetch(
    new Request(`https://quickducks.com/t/${"c".repeat(32)}`),
    duckPageEnv(null),
  );
  assert.equal(scan.status, 303);
  assert.equal(scan.headers.get("location"), "/");
});
