import assert from "node:assert/strict";
import test from "node:test";

import worker, { createWorker } from "./index.ts";
import { renderStaffHome } from "./site.ts";
import { handleStaffApi } from "./staff-api.ts";

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

// The public phase comes from one lightweight current-event status query, so a
// page test only has to say which lifecycle status the single event is in. The
// base `env` above returns no status at all, which is the "no public event"
// Preparing case. `ok: 1` keeps `/health` working through the same stub.
const phaseEnv = (status) => ({
  ...env,
  DB: {
    prepare: () => ({
      async first() {
        return { ok: 1, status };
      },
    }),
  },
});

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
  const response = await worker.fetch(new Request("https://quickducks.com/"), phaseEnv("REGISTRATION_OPEN"));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(body, /Find your duck\. Follow the race\./);
  assert.match(body, /<a href="\/my-ducks" data-my-ducks-nav data-phase-visible="true">My Ducks<\/a>/);
  assert.doesNotMatch(body, /Saved on this device|data-my-ducks-list/);
  // The name search moved to My Ducks and the full board moved to /race.
  assert.doesNotMatch(body, /Find race status by name/);
  assert.doesNotMatch(body, /src="\/assets\/search\.js"/);
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

test("HTML pages allow exactly the Cloudflare analytics beacon origins", async () => {
  // Cloudflare injects the beacon at the edge after this Worker responds, so the
  // policy must admit the script origin and the origin it reports to. Each is a
  // single exact origin: no wildcards, no scheme-only sources, no inline scripts.
  const pages = ["https://quickducks.com/", "https://quickducks.com/race", "https://quickducks.com/my-ducks"];
  for (const url of pages) {
    const policy = (await worker.fetch(new Request(url), env)).headers.get("content-security-policy") ?? "";
    const scriptSrc = policy.match(/script-src ([^;]+)/)?.[1] ?? "";
    const connectSrc = policy.match(/connect-src ([^;]+)/)?.[1] ?? "";

    assert.equal(
      scriptSrc.trim(),
      "'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
      `script-src drifted on ${url}`,
    );
    assert.equal(
      connectSrc.trim(),
      "'self' https://challenges.cloudflare.com https://cloudflareinsights.com",
      `connect-src drifted on ${url}`,
    );
    assert.doesNotMatch(policy, /'unsafe-inline'[^;]*;\s*(?:[^;]*\s)?script-src|script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(policy, /script-src[^;]*\*/);
    assert.doesNotMatch(policy, /connect-src[^;]*\*/);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
  }
});

test("serves the name-search client that ships with My Ducks", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/assets/search.js"), env);
  const legacy = await worker.fetch(new Request("https://quickducks.com/assets/home.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(body, /\/api\/v1\/race-status\/search/);
  assert.match(body, /\/api\/v1\/registrations\/mine\/follow/);
  assert.equal(legacy.status, 404);
});

test("the public home page explains the race without linking out of its cards", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/"), phaseEnv("REGISTRATION_OPEN"));
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
  const announcer = await worker.fetch(new Request("https://quickducks.com/assets/announcer.js"), env);
  const finishLine = await worker.fetch(new Request("https://quickducks.com/assets/finish-line.js"), env);
  const staffInventory = await worker.fetch(new Request("https://quickducks.com/assets/staff-inventory.js"), env);
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
  assert.match(await staffHome.text(), /\/api\/v1\/staff\/events/);
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
  assert.match(await announcer.text(), /announcer-roster/);
  assert.equal(announcer.headers.get("cache-control"), "no-store");
  assert.match(await finishLine.text(), /NDEFReader/);
  assert.equal(finishLine.headers.get("cache-control"), "no-store");
  const staffInventoryBody = await staffInventory.text();
  assert.match(staffInventoryBody, /intakeCreateProvisioningMachine/);
  assert.match(staffInventoryBody, /\/api\/v1\/staff\/inventory\/ducks/);
  assert.equal(staffInventory.headers.get("cache-control"), "no-store");
});

test("renders the private My Ducks page with two accessible horizontal sections", async () => {
  const response = await worker.fetch(
    new Request("https://quickducks.com/my-ducks"),
    phaseEnv("REGISTRATION_OPEN"),
  );
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

// Inventory is a normal staff page. It is gated on the inventory roles like any
// other, but never on the device: NFC scanning is the only device-dependent
// part and the page turns that part off in the browser. The old station page
// answered a laptop with a 400 compatibility page that also dropped the staff
// navigation, which left no way back.
test("the inventory page is role gated and renders on every device", async () => {
  const actor = (roles, isSystemAdmin = false) => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Inventory Staff",
    isSystemAdmin, roles, authentication: "bearer",
  });
  const page = (currentActor, userAgent) => createWorker(async () => currentActor).fetch(
    new Request("https://quickducks.com/staff/inventory", {
      headers: userAgent === undefined ? {} : { "user-agent": userAgent },
    }), env,
  );

  const anonymous = await page(null, iPhoneUserAgent);
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/staff?returnTo=%2Fstaff%2Finventory");

  const denied = await page(actor(["REGISTRATION"]), desktopChromeUserAgent);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await denied.text(), /permission to use duck inventory/);

  for (const currentActor of [actor(["DUCK_MANAGER"]), actor(["RACE_DIRECTOR"]), actor([], true)]) {
    for (const userAgent of [androidChromeUserAgent, iPhoneUserAgent, desktopChromeUserAgent, undefined]) {
      const allowed = await page(currentActor, userAgent);
      const body = await allowed.text();
      const where = `${currentActor.roles.join(",") || "admin"} @ ${userAgent ?? "no user agent"}`;
      assert.equal(allowed.status, 200, where);
      assert.equal(allowed.headers.get("x-robots-tag"), "noindex, nofollow", where);
      // The staff navigation is on the page whatever the device is.
      assert.match(body, /<nav class="staff-nav" aria-label="Staff pages">/, where);
      assert.match(body, /<a href="\/staff\/inventory" aria-current="page">Inventory<\/a>/, where);
      // The inventory work itself is unconditional.
      assert.match(body, /data-inventory-list/, where);
      assert.match(body, /data-inventory-detail hidden/, where);
      assert.match(body, /data-duck-delete-form/, where);
      assert.match(body, /src="\/assets\/staff-inventory\.js"/, where);
      // The scanning station ships shut and explains itself in the browser.
      assert.match(body, /data-intake-controls hidden/, where);
      assert.match(body, /Checking this device/, where);
      assert.match(body, /Start NFC provisioning/, where);
      assert.match(body, /data-end-intake-nfc hidden disabled/, where);
      assert.match(body, /data-intake-takeover hidden/, where);
      assert.match(body, /data-app-origin="https:\/\/quickducks\.com"/, where);
      // Retired inventory controls are gone from the markup entirely.
      assert.doesNotMatch(body, /data-inventory-edit-form|data-tag-replace-form|data-tag-retire-form/, where);
      assert.doesNotMatch(body, /name="condition"/, where);
    }
  }
});

// The old Android-only station path is gone rather than redirected, so a stale
// bookmark fails visibly instead of half working.
test("the retired inventory intake path is no longer routed", async () => {
  const response = await createWorker(async () => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Inventory Staff",
    isSystemAdmin: true, roles: [], authentication: "bearer",
  })).fetch(new Request("https://quickducks.com/staff/inventory-intake"), env);
  assert.equal(response.status, 404);
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
  for (const roles of [[], ["REGISTRATION"], ["RACE_DIRECTOR"], ["DUCK_MANAGER", "RESULT_TAKER"]]) {
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
  // Each station role opens exactly its own station.
  assert.equal((await page(actor(["HEAT_RUNNER"]), "/staff/announcer")).status, 403);

  const announcerStation = await page(actor(["ANNOUNCER"]), "/staff/announcer");
  assert.equal(announcerStation.status, 200);
  assert.match(await announcerStation.text(), /Read this out loud/);
  assert.equal((await page(actor(["ANNOUNCER"]), "/staff/start-line")).status, 403);
  assert.equal((await page(actor(["ANNOUNCER"]), "/staff/finish-line")).status, 403);

  const anonymousAnnouncer = await page(null, "/staff/announcer");
  assert.equal(anonymousAnnouncer.status, 303);
  assert.match(anonymousAnnouncer.headers.get("location") ?? "", /returnTo=%2Fstaff%2Fannouncer/);

  const resultStart = await page(actor(["RESULT_TAKER"]), "/staff/start-line");
  const resultFinish = await page(actor(["RESULT_TAKER"]), "/staff/finish-line");
  assert.equal(resultStart.status, 403);
  assert.equal(resultFinish.status, 200);
  const finishBody = await resultFinish.text();
  assert.match(finishBody, /Record one official result/);
  assert.match(finishBody, /Tag URL or duck number/);
  assert.doesNotMatch(finishBody, /participant email|participant phone/i);

  assert.equal((await page(actor(["RESULT_TAKER"]), "/staff/announcer")).status, 403);

  // The race director and an administrator open every station.
  for (const path of ["/staff/start-line", "/staff/announcer", "/staff/finish-line"]) {
    assert.equal((await page(actor(["RACE_DIRECTOR"]), path)).status, 200, path);
    assert.equal((await page(actor([], true), path)).status, 200, path);
  }
});

// The staff duck page immediately fetches GET /api/v1/staff/ducks/:token, so a
// page allow-list wider than the API's only renders a console that instantly
// 403s. The API is the authority; this pins the two to the same role set.
test("the staff duck page opens for exactly the roles the staff duck API allows", async () => {
  const token = "a".repeat(32);
  const staffActor = (roles, isSystemAdmin = false) => ({
    id: "staff", cognitoSub: "sub", email: "staff@example.com", displayName: "Duck Staff",
    isSystemAdmin, roles, authentication: "bearer",
  });
  const page = (currentActor) => createWorker(async () => currentActor).fetch(
    new Request(`https://quickducks.com/staff/ducks/${token}`), env,
  );
  // No row matches, so an authorized caller gets 404 rather than 403.
  const apiEnv = {
    APP_ORIGIN: "https://quickducks.com",
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      }),
    },
  };
  const api = (currentActor) => handleStaffApi(
    new Request(`https://quickducks.com/api/v1/staff/ducks/${token}`), apiEnv, currentActor,
  );

  for (const currentActor of [
    staffActor(["REGISTRATION"]),
    staffActor(["DUCK_MANAGER"]),
    staffActor(["RESULT_TAKER"]),
    staffActor(["RACE_DIRECTOR"]),
    staffActor([], true),
  ]) {
    const label = currentActor.isSystemAdmin ? "admin" : currentActor.roles.join(",");
    const allowed = await page(currentActor);
    assert.equal(allowed.status, 200, label);
    assert.notEqual((await api(currentActor)).status, 403, label);
  }

  for (const roles of [["ANNOUNCER"], ["HEAT_RUNNER"], []]) {
    const currentActor = staffActor(roles);
    const label = roles.join(",");
    const denied = await page(currentActor);
    assert.equal(denied.status, 403, label);
    assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(await denied.text(), /permission to inspect staff duck records/);
    assert.equal((await api(currentActor)).status, 403, label);
  }
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
  const open = phaseEnv("REGISTRATION_OPEN");
  const registration = await worker.fetch(new Request("https://quickducks.com/register"), open);
  const confirmation = await worker.fetch(new Request("https://quickducks.com/r/mock"), open);
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
    ...phaseEnv("REGISTRATION_OPEN"),
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

test("the QR decoder is served same-origin so browsers without native detection can scan", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/assets/qr-decoder.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
  // Version-pinned content, so it can cache permanently on race-day devices.
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  // It must be the real decoder, exposed under the global the client expects.
  assert.match(body, /jsQR/);
  assert.ok(body.length > 10000, "decoder source must be complete");
  // Serving it must not relax the camera policy on an asset response.
  assert.match(response.headers.get("permissions-policy") ?? "", /(^|, )camera=\(\)/);
});

test("camera access is granted only to the authenticated duck-pairing page", async () => {
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
  const pairing = await authenticated.fetch(new Request(`https://quickducks.com/staff/ducks/${token}`), env);
  const resultInspection = await createWorker(async () => ({
    id: "result_test", cognitoSub: "result-sub", email: "result@example.com",
    displayName: "Result Staff", isSystemAdmin: false, roles: ["RESULT_TAKER"], authentication: "cookie",
  })).fetch(new Request(`https://quickducks.com/staff/ducks/${token}`), env);

  assert.equal(pairing.headers.get("permissions-policy"), "camera=(self), geolocation=(), microphone=(), nfc=(self)");

  // Every other surface, signed in or not, keeps the camera denied.
  const others = await Promise.all([
    authenticated.fetch(new Request("https://quickducks.com/"), env),
    authenticated.fetch(new Request("https://quickducks.com/register"), env),
    authenticated.fetch(new Request("https://quickducks.com/staff"), env),
    authenticated.fetch(new Request("https://quickducks.com/staff/finish-line"), env),
    authenticated.fetch(new Request("https://quickducks.com/api/v1/events/current"), env),
    authenticated.fetch(new Request("https://quickducks.com/assets/staff-duck.js"), env),
    Promise.resolve(resultInspection),
  ]);
  for (const response of others) {
    assert.match(response.headers.get("permissions-policy") ?? "", /(^|, )camera=\(\)/);
  }
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
  // Returns are gone: the scan page is pairing and inspection only.
  assert.doesNotMatch(workingBody, /data-disposition-form|data-disposition-work/);
  assert.match(workingBody, /\/assets\/staff-duck\.js/);

  const staffHome = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/home"),
    env,
  );
  const staffHomeBody = await staffHome.text();
  assert.match(staffHomeBody, /data-system-admin="true"/);
  // Staff access is its own page now; the console links to it and renders no
  // account-management markup.
  assert.doesNotMatch(staffHomeBody, /data-staff-access-form|data-create-role-set|id="access"/);
  assert.match(staffHomeBody, /<a href="\/staff\/access">Access<\/a>/);
  assert.match(staffHomeBody, /id="events"/);
  assert.match(staffHomeBody, /id="participants"/);
  // Inventory left the console for its own page; the console links out to it.
  assert.doesNotMatch(staffHomeBody, /id="inventory"/);
  assert.match(staffHomeBody, /<a href="\/staff\/inventory">Inventory<\/a>/);
  assert.match(staffHomeBody, /id="heats"/);
  assert.match(staffHomeBody, /id="support"/);
  // The Returns section and the whole purge ceremony are removed; Delete event
  // in the Event section is the only cleanup path left.
  assert.doesNotMatch(staffHomeBody, /id="returns"|data-return-review|data-return-batch-item-form/);
  assert.doesNotMatch(staffHomeBody, /data-final-purge-form|data-purge-claim-form|data-purge-gate|data-purge-ready-form/);
  assert.match(staffHomeBody, /data-force-delete-form/);
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
  const announcerPreview = await worker.fetch(
    new Request("https://quickducks.com/mock/staff/announcer"),
    env,
  );
  assert.match(await startLine.text(), /data-start-line/);
  assert.match(await finishLine.text(), /data-finish-line/);
  assert.match(await announcerPreview.text(), /data-announcer/);

  const regularStaffHome = renderStaffHome("Regular Staff", false, ["DUCK_MANAGER"]);
  assert.doesNotMatch(regularStaffHome, /data-staff-access-form/);
  assert.doesNotMatch(regularStaffHome, /Administrators have deletion authority/);
  assert.doesNotMatch(regularStaffHome, /id="support"/);
  assert.doesNotMatch(regularStaffHome, /data-final-purge-form|data-force-delete-form/);
  assert.doesNotMatch(regularStaffHome, /id="returns"|Returns/);
  assert.doesNotMatch(regularStaffHome, /<a href="#participants"/);
  assert.match(regularStaffHome, /id="participants"[^>]* hidden/);
  // Inventory is a page of its own, so the console nav links out to it rather
  // than anchoring into a section that no longer exists here.
  assert.match(regularStaffHome, /<a href="\/staff\/inventory">Inventory<\/a>/);
  assert.doesNotMatch(regularStaffHome, /id="inventory"/);

  // The retired role is gone from the schema and the vocabulary, so no account
  // can carry it. An account with no operational roles gets the empty console,
  // and the returns surfaces it used to unlock exist nowhere.
  const rolelessHome = renderStaffHome("Roleless Staff", false, []);
  assert.match(rolelessHome, /No operational roles assigned/);
  assert.doesNotMatch(rolelessHome, /id="returns"|>Returns<|Return steward/);
  assert.doesNotMatch(rolelessHome, /data-return-review|data-numbered-disposition-form/);

  const announcerHome = renderStaffHome("Announcer", false, ["ANNOUNCER"]);
  assert.match(announcerHome, /<a href="#heats" data-event-scoped hidden>Heats<\/a>/);
  assert.doesNotMatch(announcerHome, /\/staff\/inventory/);
  assert.match(announcerHome, /data-roles="ANNOUNCER"/);
  assert.match(announcerHome, /href="\/staff\/announcer"/);
  assert.doesNotMatch(announcerHome, /href="\/staff\/start-line"|href="\/staff\/finish-line"/);

  const heatRunnerHome = renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"]);
  assert.match(heatRunnerHome, /href="\/staff\/start-line"/);
  assert.doesNotMatch(heatRunnerHome, /href="\/staff\/finish-line"/);
  assert.doesNotMatch(heatRunnerHome, /href="\/staff\/announcer"/);
  const resultTakerHome = renderStaffHome("Result Taker", false, ["RESULT_TAKER"]);
  assert.match(resultTakerHome, /href="\/staff\/finish-line"/);
  assert.doesNotMatch(resultTakerHome, /href="\/staff\/start-line"/);
  assert.doesNotMatch(resultTakerHome, /href="\/staff\/announcer"/);

  const duckManagerHome = renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]);
  assert.match(duckManagerHome, /href="\/staff\/inventory"/);
  assert.doesNotMatch(announcerHome, /href="\/staff\/inventory"/);

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
