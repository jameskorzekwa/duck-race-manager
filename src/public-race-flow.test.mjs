import assert from "node:assert/strict";
import test from "node:test";

import { liveScript, liveUiScript, participantScript, sitePhaseNavScript } from "./client-scripts.ts";
import worker from "./index.ts";
import {
  fallbackPublicPhase,
  getPublicPhase,
  homePhaseCta,
  phaseAllowsRaceStatus,
  phaseAllowsRegistration,
  phaseShowsMyDucks,
  phaseShowsRaceStatusNav,
  phaseShowsRegisterNav,
  publicPhaseForRender,
  publicPhaseForStatus,
  registrationClosedMessage,
  registrationPreparingMessage,
} from "./public-phase.ts";
import {
  renderHome,
  renderMyDucks,
  renderNotFound,
  renderRace,
  renderRegistration,
  renderStaffAuthError,
  renderStaffLogin,
} from "./site.ts";

const baseEnv = {
  APP_ORIGIN: "https://quickducks.com",
  AWS_REGION: "us-east-1",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
};

// `status: undefined` is the "no public event" row-less case the real query
// produces for no event at all and for a DRAFT-only dataset.
// `queries` records every statement the request prepared, so a test can prove a
// route runs the one phase query, or none at all.
const phaseEnv = (status) => {
  const queries = [];
  return {
    ...baseEnv,
    queries,
    DB: {
      prepare: (sql) => {
        queries.push(sql);
        return {
          // The current-event selections are the only unbound reads on these
          // paths; anything that binds values resolves to no row.
          async first() {
            return status === undefined ? null : { status };
          },
          bind: () => ({ async first() { return null; } }),
        };
      },
    },
  };
};

const page = async (path, status) => {
  const env = phaseEnv(status);
  const response = await worker.fetch(new Request(`https://quickducks.com${path}`), env);
  return { queries: env.queries, response, body: await response.text() };
};

// Every phase, the lifecycle status that produces it, and the status used to
// drive the worker-level assertions for that phase.
const phaseMatrix = [
  { phase: "PREPARING", statuses: [undefined, "DRAFT"] },
  { phase: "REGISTRATION", statuses: ["REGISTRATION_OPEN"] },
  { phase: "LOCKED_IN", statuses: ["REGISTRATION_CLOSED"] },
  { phase: "RACING", statuses: ["ROUND_ONE", "FINAL"] },
  { phase: "RESULTS", statuses: ["COMPLETED"] },
];

const expectedNav = {
  PREPARING: ["Home", "Staff"],
  REGISTRATION: ["Home", "Register", "My Ducks", "Staff"],
  LOCKED_IN: ["Home", "Race Status", "My Ducks", "Staff"],
  RACING: ["Home", "Race Status", "My Ducks", "Staff"],
  RESULTS: ["Home", "Race Status", "My Ducks", "Staff"],
};

const expectedHomeCta = {
  PREPARING: null,
  REGISTRATION: { href: "/register", label: "Register" },
  LOCKED_IN: { href: "/race", label: "View race status" },
  RACING: { href: "/race", label: "View live race" },
  RESULTS: { href: "/race", label: "View results" },
};

const navMarkup = (body) => {
  const match = body.match(/<nav class="nav"[\s\S]*?<\/nav>/);
  assert.ok(match, "every page must render the primary navigation");
  return match[0];
};

const navEntries = (body) =>
  [...navMarkup(body).matchAll(/<a href="([^"]+)"([^>]*)>([^<]*)<\/a>/g)].map(([, href, attributes, label]) => ({
    href,
    label,
    hidden: /\shidden(?=[\s>])/.test(`${attributes}>`),
  }));

const visibleNav = (body) => navEntries(body).filter((entry) => !entry.hidden).map((entry) => entry.label);

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\!]/g, "\\$&");

const homeCta = (body) => {
  const match = body.match(/<a class="button" href="([^"]+)" data-home-cta>([^<]+)<\/a>/);
  return match === null ? null : { href: match[1], label: match[2] };
};

// --- phase resolver ---------------------------------------------------------

test("the phase resolver maps every lifecycle status and defaults to Preparing", () => {
  assert.equal(publicPhaseForStatus("REGISTRATION_OPEN"), "REGISTRATION");
  assert.equal(publicPhaseForStatus("REGISTRATION_CLOSED"), "LOCKED_IN");
  assert.equal(publicPhaseForStatus("ROUND_ONE"), "RACING");
  assert.equal(publicPhaseForStatus("FINAL"), "RACING");
  assert.equal(publicPhaseForStatus("COMPLETED"), "RESULTS");
  // No event, a DRAFT event, and anything unrecognised all mean "being prepared".
  assert.equal(publicPhaseForStatus(null), "PREPARING");
  assert.equal(publicPhaseForStatus(undefined), "PREPARING");
  assert.equal(publicPhaseForStatus("DRAFT"), "PREPARING");
  assert.equal(publicPhaseForStatus("NOT_A_STATUS"), "PREPARING");
  // Prototype keys must never resolve to a phase.
  assert.equal(publicPhaseForStatus("toString"), "PREPARING");
  assert.equal(publicPhaseForStatus("constructor"), "PREPARING");
});

test("Register and Race Status strictly swap across every phase", () => {
  for (const { phase } of phaseMatrix) {
    assert.equal(
      phaseShowsRegisterNav(phase) && phaseShowsRaceStatusNav(phase),
      false,
      `${phase} must never offer both Register and Race Status`,
    );
  }
  assert.deepEqual(
    phaseMatrix.filter(({ phase }) => phaseShowsRegisterNav(phase)).map(({ phase }) => phase),
    ["REGISTRATION"],
  );
  assert.deepEqual(
    phaseMatrix.filter(({ phase }) => phaseShowsRaceStatusNav(phase)).map(({ phase }) => phase),
    ["LOCKED_IN", "RACING", "RESULTS"],
  );
  // Page availability is wider than the nav: /register is open only during
  // Registration, while /race serves all five post-DRAFT statuses.
  assert.deepEqual(
    phaseMatrix.filter(({ phase }) => phaseAllowsRegistration(phase)).map(({ phase }) => phase),
    ["REGISTRATION"],
  );
  assert.deepEqual(
    phaseMatrix.filter(({ phase }) => phaseAllowsRaceStatus(phase)).map(({ phase }) => phase),
    ["REGISTRATION", "LOCKED_IN", "RACING", "RESULTS"],
  );
  assert.deepEqual(
    phaseMatrix.filter(({ phase }) => phaseShowsMyDucks(phase)).map(({ phase }) => phase),
    ["REGISTRATION", "LOCKED_IN", "RACING", "RESULTS"],
  );
  assert.deepEqual(homePhaseCta, expectedHomeCta);
});

test("the phase query is one lightweight status read that excludes DRAFT", async () => {
  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        queries.push(sql);
        return { async first() { return { status: "FINAL" }; } };
      },
    },
  };

  assert.equal(await getPublicPhase(env), "RACING");
  assert.equal(queries.length, 1);
  const [sql] = queries;
  assert.match(sql, /SELECT status\s+FROM events/);
  assert.match(sql, /LIMIT 1/);
  // Only the five public statuses are selectable, so DRAFT can never be current.
  for (const status of ["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]) {
    assert.ok(sql.includes(`'${status}'`), status);
  }
  assert.equal(sql.includes("'DRAFT'"), false);
  // The projection reads no participant, contact, or token column.
  assert.doesNotMatch(sql, /first_name|last_name|email|phone|lookup_code|private_token|tag_token/i);
});

test("no current event resolves to Preparing without inventing a status", async () => {
  const env = { DB: { prepare: () => ({ async first() { return null; } }) } };

  assert.equal(await getPublicPhase(env), "PREPARING");
});

// --- degraded phase resolution ----------------------------------------------

// Before the site became phase-driven, public pages rendered without touching
// D1 at all. A page render must therefore never be turned into a 500 by the
// phase query alone: an unavailable, degraded, or transient D1 failure degrades
// to Preparing and the live hub repaints the nav once D1 recovers.
const d1Failure = () => new Error("D1_ERROR: no such table: events");

// Only the phase query fails; every other statement answers normally. This is
// the precise regression, and it also proves nothing else got caught with it.
const brokenPhaseEnv = () => {
  const queries = [];
  return {
    ...baseEnv,
    queries,
    DB: {
      prepare: (sql) => {
        queries.push(sql);
        const isPhaseQuery = /^SELECT status\s+FROM events/.test(sql);
        return {
          async first() {
            if (isPhaseQuery) throw d1Failure();
            return null;
          },
          bind: () => ({ async first() { return null; } }),
        };
      },
    },
  };
};

// A total outage: every statement rejects, which is what the API paths see.
const deadDatabaseEnv = () => ({
  ...baseEnv,
  DB: {
    prepare: () => ({
      bind() { return this; },
      async first() { throw d1Failure(); },
      async all() { throw d1Failure(); },
      async run() { throw d1Failure(); },
    }),
    batch: async () => { throw d1Failure(); },
  },
});

const failedPage = async (path, env = brokenPhaseEnv()) => {
  const response = await worker.fetch(new Request(`https://quickducks.com${path}`), env);
  return { queries: env.queries, response, body: await response.text() };
};

test("the phase query resolver still rejects so D1-dependent callers fail loudly", async () => {
  await assert.rejects(getPublicPhase(deadDatabaseEnv()), /D1_ERROR/);
});

test("the render-time resolver degrades a failed phase query to Preparing", async () => {
  // Preparing is the conservative fallback: it is the same phase "no public
  // event" produces, and it advertises neither Register nor Race Status, so a
  // database hiccup can never invite a visitor into a flow that is not open.
  assert.equal(fallbackPublicPhase, "PREPARING");
  assert.equal(await publicPhaseForRender(deadDatabaseEnv()), "PREPARING");
  assert.equal(await publicPhaseForRender(brokenPhaseEnv()), "PREPARING");
  // A working query is passed through untouched.
  assert.equal(await publicPhaseForRender(phaseEnv("FINAL")), "RACING");
  assert.equal(await publicPhaseForRender(phaseEnv("REGISTRATION_OPEN")), "REGISTRATION");
  assert.equal(await publicPhaseForRender(phaseEnv(undefined)), "PREPARING");
});

test("every public page still renders with the Preparing nav when the phase query fails", async () => {
  // `/my-ducks` and `/race` are deliberately absent: both are unreachable in the
  // Preparing phase, so a degraded paint sends the visitor home instead of
  // rendering.
  for (const path of ["/", "/register", "/r/mock", "/t/mock"]) {
    const { queries, response, body } = await failedPage(path);

    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000", path);
    // The query really was attempted; the page is not skipping the read.
    assert.ok(queries.some((sql) => /^SELECT status\s+FROM events/.test(sql)), path);
    assert.deepEqual(visibleNav(body), expectedNav.PREPARING, path);
    assert.match(navMarkup(body), /data-phase="PREPARING"/, path);
    // A degraded paint never advertises a flow that may not be open.
    assert.equal(
      navEntries(body).some((entry) => !entry.hidden && ["/register", "/race"].includes(entry.href)),
      false,
      path,
    );
    // Every public content page keeps the marker the live hub needs to repaint
    // the nav from `GET /api/v1/events/current` once D1 recovers.
    assert.match(navMarkup(body), /data-live-nav/, path);
    assert.match(body, /src="\/assets\/live-ui\.js"/, path);
  }
});

test("the home page degrades to the Preparing hero instead of a 500", async () => {
  const { response, body } = await failedPage("/");

  assert.equal(response.status, 200);
  assert.equal(homeCta(body), null);
  assert.match(body, /data-home-preparing>The next race is being prepared\./);
  assert.match(body, /<h1><span>Find your duck\.<\/span><br><span>Cheer it home\.<\/span><\/h1>/);
});

test("/register degrades to its own preparing wording and /race degrades to the redirect", async () => {
  const register = await failedPage("/register");
  assert.equal(register.response.status, 200);
  assert.ok(register.body.includes(registrationPreparingMessage));
  assert.match(register.body, /data-registration-preparing/);

  // A failed phase query resolves to Preparing, which is exactly the phase in
  // which `/race` has nothing to report, so it takes the same route home.
  const race = await failedPage("/race");
  assert.equal(race.response.status, 303);
  assert.equal(race.response.headers.get("location"), "/");
  assert.equal(race.body, "");
});

test("/my-ducks renders its saved-ducks surface once there is a race to have ducks in", async () => {
  const { response, body } = await page("/my-ducks", "REGISTRATION_OPEN");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(body, /data-my-ducks-page/);
  assert.match(body, /data-status-search-section/);
  assert.match(navMarkup(body), /data-my-ducks-nav data-phase-visible="true"/);
});

test("/my-ducks redirects home before registration opens, degraded phase or not", async () => {
  // There are no ducks to show while the race is still being prepared, and the
  // nav does not offer the page, so a bookmark or an old link goes home rather
  // than to an empty page. A failed phase query degrades to exactly the same
  // Preparing phase, so it must take the same route and never 500.
  for (const status of [undefined, "DRAFT"]) {
    const { response } = await page("/my-ducks", status);
    assert.equal(response.status, 303, `status ${status ?? "no event"}`);
    assert.equal(response.headers.get("location"), "/", `status ${status ?? "no event"}`);
  }

  const degraded = await failedPage("/my-ducks");
  assert.equal(degraded.response.status, 303);
  assert.equal(degraded.response.headers.get("location"), "/");
  assert.equal(degraded.response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(degraded.body, "");

  const dead = await worker.fetch(new Request("https://quickducks.com/my-ducks"), deadDatabaseEnv());
  assert.equal(dead.status, 303);
  assert.equal(dead.headers.get("location"), "/");
});

test("/my-ducks stays reachable in every phase that has a public race", async () => {
  for (const { phase, statuses } of phaseMatrix) {
    if (phase === "PREPARING") continue;
    for (const status of statuses) {
      const { response } = await page("/my-ducks", status);
      assert.equal(response.status, 200, `${phase} (${status})`);
    }
  }
});

test("/race redirects home while the race is being prepared, degraded phase or not", async () => {
  // Preparing is "no event at all" and "a DRAFT event": there is no stage, no
  // heat, and no result to report, and the nav does not offer the page, so a
  // bookmark or an old link goes home instead of to an empty race-status page.
  for (const status of [undefined, "DRAFT"]) {
    const { response, body } = await page("/race", status);
    const where = `status ${status ?? "no event"}`;
    assert.equal(response.status, 303, where);
    assert.equal(response.headers.get("location"), "/", where);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000", where);
    assert.equal(body, "", where);
  }

  const dead = await worker.fetch(new Request("https://quickducks.com/race"), deadDatabaseEnv());
  assert.equal(dead.status, 303);
  assert.equal(dead.headers.get("location"), "/");
});

test("/race stays reachable in every phase that has a public race", async () => {
  for (const { phase, statuses } of phaseMatrix) {
    if (phase === "PREPARING") continue;
    for (const status of statuses) {
      const { response } = await page("/race", status);
      assert.equal(response.status, 200, `${phase} (${status})`);
    }
  }
});

test("a failed phase query cannot 500 the record-backed public pages either", async () => {
  // `/duck/<number>` resolves its record first and only then the phase, so the
  // failing phase read must not change its outcome. The mock resolves no duck,
  // which is the already-tested not-found page, not a server error.
  const duck = await failedPage("/duck/128");
  assert.equal(duck.response.status, 404);
  assert.equal(duck.response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.deepEqual(visibleNav(duck.body), expectedNav.PREPARING);

  // The private status preview and the tag preview render a full page.
  for (const path of ["/r/mock", "/t/mock"]) {
    const { response, body } = await failedPage(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(visibleNav(body), expectedNav.PREPARING, path);
  }
});

test("the not-found page still resolves no phase at all, failing database or not", async () => {
  const { queries, response, body } = await failedPage("/no-such-page");

  assert.equal(response.status, 404);
  assert.deepEqual(queries, [], "unmatched paths must never reach the database");
  assert.deepEqual(visibleNav(body), ["Home", "Staff"]);
});

test("a total database outage still paints the public pages", async () => {
  for (const path of ["/", "/register"]) {
    const response = await worker.fetch(new Request(`https://quickducks.com${path}`), deadDatabaseEnv());
    const body = await response.text();

    assert.equal(response.status, 200, path);
    assert.deepEqual(visibleNav(body), expectedNav.PREPARING, path);
  }
});

test("API routes that depend on D1 keep surfacing their failures", async () => {
  // The page fallback is deliberately not shared with the API layer: these
  // routes exist to report authoritative state, so a hidden failure would be a
  // wrong answer rather than a degraded one.
  for (const path of [
    "/api/v1/events/current",
    "/api/v1/race-board",
    `/api/v1/registrations/${"a".repeat(43)}`,
    "/api/v1/ducks/number/128",
  ]) {
    await assert.rejects(
      worker.fetch(new Request(`https://quickducks.com${path}`), deadDatabaseEnv()),
      /D1_ERROR/,
      path,
    );
  }
});

// --- navigation matrix ------------------------------------------------------

test("the primary nav is correct on first paint for every phase", async () => {
  for (const { phase, statuses } of phaseMatrix) {
    for (const status of statuses) {
      const { body } = await page("/", status);
      assert.deepEqual(visibleNav(body), expectedNav[phase], `${phase} (${status ?? "no event"}) nav`);
      assert.match(navMarkup(body), new RegExp(`data-phase="${phase}"`));
      // Staff stays in the top nav in every phase.
      assert.ok(navEntries(body).some((entry) => entry.href === "/staff" && !entry.hidden));
      // Exactly one of Register / Race Status is offered.
      const swap = navEntries(body).filter((entry) => !entry.hidden && ["/register", "/race"].includes(entry.href));
      assert.equal(swap.length, phase === "PREPARING" ? 0 : 1, `${phase} swap link count`);
    }
  }
});

test("the nav is identical on every public content page in the same phase", async () => {
  for (const path of ["/", "/register", "/race", "/my-ducks", "/duck/128"]) {
    const { body } = await page(path, "ROUND_ONE");
    assert.deepEqual(visibleNav(body), expectedNav.RACING, path);
  }
  // The not-found page is deliberately outside that set: it resolves no phase,
  // so it always shows the minimal navigation.
  const missing = await page("/no-such-page", "ROUND_ONE");
  assert.deepEqual(visibleNav(missing.body), ["Home", "Staff"]);
});

test("My Ducks stays in the document while Preparing for later phase repaint", async () => {
  const { body } = await page("/", undefined);
  const myDucks = navEntries(body).find((entry) => entry.href === "/my-ducks");

  assert.ok(myDucks, "the My Ducks anchor must exist so a later public phase can reveal it");
  assert.equal(myDucks.hidden, true);
  assert.match(navMarkup(body), /data-my-ducks-nav data-phase-visible="false" hidden/);

  const open = await page("/", "REGISTRATION_OPEN");
  assert.match(navMarkup(open.body), /data-my-ducks-nav data-phase-visible="true"/);
  assert.doesNotMatch(navMarkup(open.body), /data-my-ducks-nav[^>]*hidden/);
});

// --- home page --------------------------------------------------------------

test("the home CTA follows the phase table", async () => {
  for (const { phase, statuses } of phaseMatrix) {
    for (const status of statuses) {
      const { body } = await page("/", status);
      assert.deepEqual(homeCta(body), expectedHomeCta[phase], `${phase} (${status ?? "no event"}) CTA`);
    }
  }
});

test("Preparing says the next race is being prepared instead of offering a CTA", async () => {
  const { body } = await page("/", "DRAFT");

  assert.equal(homeCta(body), null);
  assert.match(body, /data-home-preparing>The next race is being prepared\./);
  // Nothing on the page can start a registration or a race-status visit.
  assert.doesNotMatch(body, /href="\/register"/);
  assert.doesNotMatch(body, /href="\/race"/);
  assert.doesNotMatch(body, /data-live-summary/);
});

test("the home page keeps the hero and the three link-free explainer cards", async () => {
  const { body } = await page("/", "FINAL");

  assert.match(body, /<section class="hero">/);
  assert.match(body, /<h1><span>Find your duck\.<\/span><br><span>Cheer it home\.<\/span><\/h1>/);
  const explainers = body.match(/<section id="how-it-works"[\s\S]*?<\/section>/)?.[0];
  assert.ok(explainers);
  for (const heading of ["Before the race", "At check-in", "On race day"]) {
    assert.ok(explainers.includes(`<strong>${heading}</strong>`), heading);
  }
  assert.equal((explainers.match(/<a\b/g) ?? []).length, 0);
});

test("the home page carries a compact happening-now summary instead of the full board", async () => {
  const { body } = await page("/", "ROUND_ONE");

  assert.match(body, /data-live-summary\b/);
  assert.match(body, /data-live-summary-stage/);
  assert.match(body, /data-live-summary-title/);
  assert.match(body, /data-live-summary-line/);
  assert.match(body, /<a class="button secondary" href="\/race">Open the full race board<\/a>/);
  assert.match(body, /src="\/assets\/live\.js"/);
  // The full board's heat/podium surface is gone from the home page.
  assert.doesNotMatch(body, /data-live-board\b/);
  assert.doesNotMatch(body, /data-live-board-content/);
  assert.doesNotMatch(body, /data-live-board-stage/);
});

test("the home call to action lives in the section titled with the race, not in the hero", async () => {
  for (const { phase, statuses } of phaseMatrix) {
    if (phase === "PREPARING") continue;
    for (const status of statuses) {
      const { body } = await page("/", status);
      const where = `${phase} (${status})`;
      const hero = body.match(/<section class="hero">[\s\S]*?<\/section>/)?.[0];
      const summary = body.match(/<section class="status-section" data-live-summary[\s\S]*?<\/section>/)?.[0];

      assert.ok(hero, where);
      assert.ok(summary, where);
      // The hero is copy and artwork only; it carries no action row at all.
      assert.doesNotMatch(hero, /class="actions"/, where);
      assert.doesNotMatch(hero, /<a\b/, where);
      assert.doesNotMatch(hero, /data-home-cta/, where);
      // The CTA is the primary action of the happening-now section, whose title
      // `live.js` replaces with the event's own name, and it comes before the
      // secondary board link.
      assert.deepEqual(homeCta(summary), expectedHomeCta[phase], where);
      assert.match(
        summary,
        /<div class="actions"><a class="button" href="[^"]+" data-home-cta>[^<]+<\/a><a class="button secondary" href="\/race">Open the full race board<\/a><\/div>/,
        where,
      );
      assert.ok(summary.indexOf("data-live-summary-title") < summary.indexOf("data-home-cta"), where);
      // Exactly one CTA on the page.
      assert.equal((body.match(/data-home-cta/g) ?? []).length, 1, where);
    }
  }
});

test("the home page no longer offers a How it works button", async () => {
  for (const { statuses } of phaseMatrix) {
    for (const status of statuses) {
      const { body } = await page("/", status);
      assert.doesNotMatch(body, /How it works/, String(status));
      assert.doesNotMatch(body, /href="#how-it-works"/, String(status));
      // The cards section it used to jump to stays exactly where it was.
      assert.match(body, /<section id="how-it-works" class="cards"/, String(status));
    }
  }
});

test("the home hero and ticker carry the approved race-day copy", async () => {
  const { body } = await page("/", "REGISTRATION_OPEN");

  assert.match(body, /<h1><span>Find your duck\.<\/span><br><span>Cheer it home\.<\/span><\/h1>/);
  assert.ok(body.includes(
    '<p class="lede">A friendly home for the small races that bring a whole town down to the water.'
    + " Built for the volunteers, families, and rubber ducks that make race day happen.</p>",
  ));
  assert.match(
    body,
    /<div class="ticker" aria-label="QuickDucks features"><span>Pick your duck<\/span><span>Find your heat<\/span><span>Cheer loudly<\/span><\/div>/,
  );
  assert.doesNotMatch(body, /Tap the tag|Follow the race\./);
});

test("the name search no longer appears anywhere on the home page", async () => {
  for (const { statuses } of phaseMatrix) {
    for (const status of statuses) {
      const { body } = await page("/", status);
      assert.doesNotMatch(body, /data-status-search/, String(status));
      assert.doesNotMatch(body, /Lost your saved list\?/, String(status));
      assert.doesNotMatch(body, /Find race status by name/, String(status));
      assert.doesNotMatch(body, /src="\/assets\/search\.js"/, String(status));
    }
  }
});

// --- /register --------------------------------------------------------------

const registrationExtras = [
  /data-registration-form/,
  /Register participant/,
  /class="privacy"/,
  /class="notice"/,
  /Registering more than one participant\?/,
  /data-public-name-policy/,
  /cf-turnstile|turnstile-mock/,
  /assets\/register\.js/,
];

test("Preparing shows only the approved registration message", async () => {
  const { response, body } = await page("/register", undefined);
  const panel = body.match(/<main class="shell">([\s\S]*?)<\/main>/)?.[1];

  assert.equal(response.status, 200);
  assert.ok(panel);
  assert.ok(
    panel.includes("The next race is being prepared. Registration is not open yet, please come back later to register!"),
    "the exact approved sentence must be present",
  );
  assert.equal(
    registrationPreparingMessage,
    "The next race is being prepared. Registration is not open yet, please come back later to register!",
  );
  for (const pattern of registrationExtras) {
    assert.doesNotMatch(panel, pattern, `Preparing /register must not render ${pattern}`);
  }
  assert.match(panel, /data-registration-preparing/);
  // A DRAFT event is the same Preparing case.
  const draft = await page("/register", "DRAFT");
  assert.match(draft.body, /data-registration-preparing/);
});

test("Registration renders the full unchanged registration form", async () => {
  const { body } = await page("/register", "REGISTRATION_OPEN");

  for (const pattern of registrationExtras) assert.match(body, pattern);
  assert.match(body, /data-protection-ready="false"/);
  assert.doesNotMatch(body, /data-registration-preparing|data-registration-closed/);
  assert.doesNotMatch(body, new RegExp(registrationClosedMessage));
});

test("Locked in, Racing, and Results close registration and point at race status", async () => {
  for (const status of ["REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]) {
    const { response, body } = await page("/register", status);
    const panel = body.match(/<main class="shell">([\s\S]*?)<\/main>/)?.[1];

    assert.equal(response.status, 200, status);
    assert.ok(panel, status);
    assert.match(panel, /data-registration-closed/, status);
    assert.ok(panel.includes("Registration is closed."), status);
    assert.match(panel, /<a class="button" href="\/race">View race status<\/a>/, status);
    for (const pattern of registrationExtras) {
      assert.doesNotMatch(panel, pattern, `${status} /register must not render ${pattern}`);
    }
    assert.doesNotMatch(panel, new RegExp(escapeForRegExp(registrationPreparingMessage)), status);
  }
});

test("/register is noindex and keeps the shared public security headers in every phase", async () => {
  for (const status of [undefined, "REGISTRATION_OPEN", "COMPLETED"]) {
    const { response, body } = await page("/register", status);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow", String(status));
    assert.equal(response.headers.get("cache-control"), "no-store", String(status));
    assert.match(body, /<meta name="robots" content="noindex,nofollow">/, String(status));
  }
});

// --- /race ------------------------------------------------------------------

test("/race renders the full live board for the five post-DRAFT statuses", async () => {
  for (const status of ["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]) {
    const { response, body } = await page("/race", status);

    assert.equal(response.status, 200, status);
    assert.match(body, /data-live-board\b/, status);
    assert.match(body, /data-live-board-stage/, status);
    assert.match(body, /data-live-board-title/, status);
    assert.match(body, /data-live-board-content/, status);
    assert.match(body, /<p class="message-line muted" data-live-board-error role="alert" hidden><\/p>/, status);
    assert.match(body, /src="\/assets\/live\.js"/, status);
    // The retired preparing panel cannot come back through this route.
    assert.doesNotMatch(body, /data-race-preparing/, status);
  }
});

test("/race carries no preparing panel and never the /register call to action", async () => {
  // The preparing branch is gone from the renderer as well as from the route,
  // so there is no way to paint it and no wording left to confuse with
  // `/register`'s own approved sentence.
  for (const status of ["REGISTRATION_OPEN", "ROUND_ONE", "COMPLETED"]) {
    const { body } = await page("/race", status);
    assert.doesNotMatch(body, /data-race-preparing/, status);
    assert.doesNotMatch(body, new RegExp(escapeForRegExp(registrationPreparingMessage)), status);
    assert.doesNotMatch(body, /come back later to register/, status);
    assert.doesNotMatch(body, /Live race status will appear here/, status);
  }

  // Only `/register` may tell a visitor to come back and register, and it still
  // owns that sentence unchanged.
  assert.match(registrationPreparingMessage, /come back later to register/);
  const registerPreparing = renderRegistration(undefined, "PREPARING");
  assert.ok(registerPreparing.includes(registrationPreparingMessage));
  assert.match(registerPreparing, /data-registration-preparing/);
  assert.equal(renderRace("ROUND_ONE").includes(registrationPreparingMessage), false);
});

test("/race is noindex and shares the public page security headers", async () => {
  const { response, body } = await page("/race", "ROUND_ONE");
  const home = await page("/", "ROUND_ONE");

  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(
    response.headers.get("content-security-policy"),
    home.response.headers.get("content-security-policy"),
  );
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
});

test("/race only answers GET", async () => {
  const response = await worker.fetch(
    new Request("https://quickducks.com/race", { method: "POST" }),
    phaseEnv("ROUND_ONE"),
  );

  assert.equal(response.status, 404);
});

// --- /my-ducks --------------------------------------------------------------

test("My Ducks hosts the name search and its follow action", async () => {
  const { body } = await page("/my-ducks", "REGISTRATION_OPEN");

  assert.match(body, /data-status-search-section/);
  assert.match(body, /Lost your saved list\?/);
  assert.match(body, /<h2 id="find-status-title">Find race status by name<\/h2>/);
  assert.match(body, /<form class="search-form" data-status-search>/);
  assert.match(body, /data-search-message/);
  assert.match(body, /data-search-results/);
  assert.match(body, /src="\/assets\/search\.js"/);
  // The saved-ducks surface is still there alongside it.
  assert.match(body, /data-participant-section="awaiting"/);
  assert.match(body, /data-participant-section="paired"/);
});

test("the search leads My Ducks only while nothing is saved on the device", () => {
  const markup = renderMyDucks("RACING");
  const flow = markup.match(/<div class="my-ducks-flow" data-my-ducks-flow>([\s\S]*)<\/div>\s*<\/section>/)?.[1];

  assert.ok(flow, "the ordering container must wrap the saved ducks and the search");
  // Saved ducks are first in document order; CSS promotes the search above them
  // only once the collection is confirmed empty.
  assert.ok(flow.indexOf("data-my-ducks-empty") < flow.indexOf("data-status-search-section"));
  assert.match(markup, /\.my-ducks-flow\[data-my-ducks-flow="empty"\] > \.my-ducks-search \{ order:-1; \}/);
  assert.match(markup, /class="status-section my-ducks-search" data-status-search-section/);
  assert.match(markup, /data-search-lead hidden>Nothing is saved on this device yet\. Search for a participant below to follow their race status here\./);
});

test("My Ducks offers Register again only while registration is open", () => {
  assert.match(
    renderMyDucks("REGISTRATION"),
    /<a class="button small" href="\/register" data-register-another>Register another participant<\/a>/,
  );
  for (const phase of ["PREPARING", "LOCKED_IN", "RACING", "RESULTS"]) {
    assert.doesNotMatch(renderMyDucks(phase), /href="\/register"/, phase);
  }
});

test("Register again sits on the Awaiting Participants header row and wraps on a narrow screen", () => {
  const markup = renderMyDucks("REGISTRATION");
  const head = markup.match(
    /<div class="participant-section-head">\s*<h2 id="awaiting-participants-title">Awaiting Participants<\/h2>([\s\S]*?)<\/div>\s*<p class="muted">Participants you registered on this device, waiting/,
  )?.[1];

  assert.ok(head, "the awaiting heading row must still be one participant-section-head block");
  assert.match(head, /data-register-another/);
  // The carousel controls stay in the same row, after the register action.
  assert.ok(head.indexOf("data-register-another") < head.indexOf("data-carousel-controls"));
  // Nothing is left behind in a trailing actions block.
  assert.doesNotMatch(markup, /<div class="actions"><a class="button" href="\/register">/);

  // The row is a wrapping flex row and every part of it can shrink, so 320px
  // wraps instead of overflowing.
  assert.match(markup, /\.participant-section-head \{[^}]*flex-wrap:wrap;/);
  assert.match(markup, /\.participant-section-head-actions \{[^}]*flex-wrap:wrap;[^}]*min-width:0;/);
  assert.match(markup, /@media \(max-width:43\.99rem\)[^@]*\.participant-section-head-actions \{ flex-basis:100%; justify-content:flex-start; \}/);
});

// --- private data ------------------------------------------------------------

test("no phase of the public flow leaks contact details, codes, or tokens", async () => {
  const paths = ["/", "/register", "/race", "/my-ducks", "/no-such-page"];
  for (const { statuses } of phaseMatrix) {
    for (const status of statuses) {
      for (const path of paths) {
        const { body } = await page(path, status);
        const main = body.match(/<main class="shell">([\s\S]*?)<\/main>/)?.[1] ?? "";
        const where = `${path} @ ${status ?? "no event"}`;
        // No private field name, rendered value, or private/tag link anywhere.
        assert.doesNotMatch(main, /lookupCode|privateToken|privateStatusPath|tagToken|lookup_code|private_token/, where);
        assert.doesNotMatch(main, /href="\/r\/|href="\/t\/|href="\/staff\/ducks/, where);
        // Form placeholders are static hints, never rendered participant data.
        assert.doesNotMatch(main.replaceAll(/ placeholder="[^"]*"/g, ""), /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, where);
        assert.doesNotMatch(main, /<span class="code">/, where);
        assert.doesNotMatch(main, /data-live-personal/, where);
        assert.doesNotMatch(main, /inventory|audit trail|staff note/i, where);
        // The `/register` form is the only public surface that collects contact
        // details, and only while registration is open.
        assert.equal(
          /name="email"|name="phone"/.test(main),
          path === "/register" && status === "REGISTRATION_OPEN",
          where,
        );
      }
    }
  }
});

test("the search section promises a status-only projection", () => {
  const markup = renderMyDucks("RACING");

  assert.match(
    markup,
    /Results show race status only, never email, phone, private links, lookup codes, or staff data\./,
  );
});

test("My Ducks explains participant-specific contact access on the originating browser", () => {
  const markup = renderMyDucks("RACING");
  assert.match(markup, /participant-specific private proof lets this browser show and edit email, phone, and contact opt-ins/);
  assert.match(markup, /Anyone with access to this browser profile may see or change those saved details/);
  assert.match(markup, /Followed participants remain status-only/);
});

// --- a very small DOM for the two browser clients ---------------------------

const quickMatches = (node, selector) => {
  const attribute = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/);
  if (attribute === null) return false;
  const key = attribute[1].replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
  const value = node.dataset[key];
  if (value === undefined) return false;
  return attribute[2] === undefined || value === attribute[2];
};

class QuickNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.clientWidth = 0;
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.href = "";
    this.listeners = new Map();
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.tabIndex = 0;
    this.textContent = "";
  }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute() {}
  focus() {}
  scrollIntoView() {}
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) { return this.descendants().filter((node) => quickMatches(node, selector)); }
}

class QuickDocument extends QuickNode {
  createElement(tagName) { return new QuickNode(tagName); }
}

const anchor = (document, marker, href, label) => {
  const link = document.createElement("a");
  link.dataset[marker] = "";
  link.href = href;
  link.textContent = label;
  return link;
};

// Mirrors the server-rendered nav for a phase, then runs the nav client against
// it. `liveNav` mirrors the server-rendered `data-live-nav` admission marker,
// which only public content pages carry.
const navHarness = (phase, { hasRegistrations = null, eventStatus, liveNav = true } = {}) => {
  const document = new QuickDocument("#document");
  const nav = document.createElement("nav");
  nav.dataset.siteNav = "";
  if (liveNav) nav.dataset.liveNav = "";
  nav.dataset.phase = phase;
  const myDucks = anchor(document, "myDucksNav", "/my-ducks", "My Ducks");
  myDucks.dataset.phaseVisible = phase === "PREPARING" ? "false" : "true";
  myDucks.hidden = phase === "PREPARING";
  if (hasRegistrations !== null) {
    myDucks.dataset.hasRegistrations = hasRegistrations ? "true" : "false";
    if (hasRegistrations) myDucks.hidden = false;
  }
  const children = [anchor(document, "navHome", "/", "Home")];
  if (phase === "REGISTRATION") children.push(anchor(document, "navRegister", "/register", "Register"));
  else if (phase !== "PREPARING") children.push(anchor(document, "navRace", "/race", "Race Status"));
  children.push(myDucks, anchor(document, "navStaff", "/staff", "Staff"));
  nav.append(...children);
  document.append(nav);

  const requests = [];
  const subscriptions = [];
  const fetchStub = async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({ event: eventStatus === undefined ? null : { id: "event-1", status: eventStatus } });
  };

  new Function("document", "fetch", "globalThis", sitePhaseNavScript)(
    document,
    fetchStub,
    { quickDucksLive: { subscribe(subscriber) { subscriptions.push(subscriber); } } },
  );

  return { document, myDucks, nav, requests, subscriptions };
};

const navLabels = (harness) => harness.nav.children.filter((child) => !child.hidden).map((child) => child.textContent);

test("the nav client subscribes to the event domain and reads the authoritative projection", async () => {
  const harness = navHarness("REGISTRATION", { eventStatus: "REGISTRATION_OPEN" });

  assert.equal(harness.subscriptions.length, 1);
  assert.deepEqual(harness.subscriptions[0].domains, ["event"]);
  assert.equal(harness.subscriptions[0].root, harness.nav);

  await harness.subscriptions[0].refresh();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url, "/api/v1/events/current");
  assert.equal(harness.requests[0].options.cache, "no-store");
});

test("a live event signal re-renders the nav into the new phase without a refresh", async () => {
  const advances = [
    ["REGISTRATION_OPEN", ["Home", "Register", "My Ducks", "Staff"]],
    ["REGISTRATION_CLOSED", ["Home", "Race Status", "My Ducks", "Staff"]],
    ["ROUND_ONE", ["Home", "Race Status", "My Ducks", "Staff"]],
    ["FINAL", ["Home", "Race Status", "My Ducks", "Staff"]],
    ["COMPLETED", ["Home", "Race Status", "My Ducks", "Staff"]],
  ];

  // A page painted while registration was open follows the race all the way to
  // results without ever reloading.
  for (const [status, expected] of advances) {
    const harness = navHarness("REGISTRATION", { eventStatus: status });
    await harness.subscriptions[0].refresh();
    assert.deepEqual(navLabels(harness), expected, status);
    assert.equal(harness.nav.dataset.phase, publicPhaseForStatus(status), status);
  }
});

test("the nav client swaps Register out for Race Status and never keeps both", async () => {
  const closed = navHarness("REGISTRATION", { eventStatus: "REGISTRATION_CLOSED" });
  await closed.subscriptions[0].refresh();
  assert.equal(closed.nav.children.some((child) => child.href === "/register"), false);
  assert.equal(closed.nav.children.filter((child) => child.href === "/race").length, 1);

  const reopened = navHarness("RACING", { eventStatus: "REGISTRATION_OPEN" });
  await reopened.subscriptions[0].refresh();
  assert.equal(reopened.nav.children.some((child) => child.href === "/race"), false);
  assert.equal(reopened.nav.children.filter((child) => child.href === "/register").length, 1);
});

test("a race that disappears returns the nav to the Preparing set", async () => {
  const harness = navHarness("RACING", { eventStatus: undefined });
  await harness.subscriptions[0].refresh();

  assert.deepEqual(navLabels(harness), ["Home", "Staff"]);
  assert.equal(harness.myDucks.hidden, true);
  assert.equal(harness.myDucks.dataset.phaseVisible, "false");
  // Staff is never removed.
  assert.ok(harness.nav.children.some((child) => child.href === "/staff"));
});

test("My Ducks stays hidden during Preparing even when this device has saved registrations", async () => {
  const saved = navHarness("RACING", { eventStatus: undefined, hasRegistrations: true });
  await saved.subscriptions[0].refresh();

  assert.equal(saved.myDucks.hidden, true, "the unavailable route must not be advertised");
  assert.deepEqual(navLabels(saved), ["Home", "Staff"]);

  const empty = navHarness("RACING", { eventStatus: undefined, hasRegistrations: false });
  await empty.subscriptions[0].refresh();
  assert.equal(empty.myDucks.hidden, true);
});

test("a phase that grants My Ducks keeps it visible even with no saved registrations", async () => {
  const harness = navHarness("PREPARING", { eventStatus: "ROUND_ONE", hasRegistrations: false });
  await harness.subscriptions[0].refresh();

  assert.equal(harness.myDucks.hidden, false);
  assert.equal(harness.myDucks.dataset.phaseVisible, "true");
});

test("the nav client builds links with safe DOM APIs and no unsafe sinks", () => {
  assert.match(sitePhaseNavScript, /document\.createElement\("a"\)/);
  assert.match(sitePhaseNavScript, /link\.textContent = label/);
  assert.doesNotMatch(sitePhaseNavScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  // The nav reads only the public event projection.
  assert.doesNotMatch(sitePhaseNavScript, /lookupCode|privateToken|tagToken|email|phone/i);
});

// --- live-hub admission: only public content pages may cost a socket ---------

const publicContentPaths = [
  ["/", "REGISTRATION_OPEN"],
  ["/race", "ROUND_ONE"],
  ["/my-ducks", "ROUND_ONE"],
  ["/register", "REGISTRATION_OPEN"],
  ["/register", undefined],
  ["/duck/128", "ROUND_ONE"],
  ["/r/mock", "ROUND_ONE"],
  ["/t/mock", "ROUND_ONE"],
];

test("every public content page keeps the live navigation subscriber", async () => {
  for (const [path, status] of publicContentPaths) {
    const { body } = await page(path, status);
    const where = `${path} @ ${status ?? "no event"}`;
    assert.match(navMarkup(body), /<nav class="nav" aria-label="Primary" data-site-nav data-live-nav /, where);
    // Every page loads the runtime that carries the navigation subscriber.
    assert.match(body, /src="\/assets\/live-ui\.js"/, where);
  }
});

// Informational pages have no other live surface, so a navigation subscriber
// would be the only reason they hold one of the Durable Object's capped
// connections. They must not carry the marker.
const socketFreePages = {
  "staff sign in": renderStaffLogin(),
  "not found": renderNotFound(),
  "staff auth error": renderStaffAuthError("Your sign-in link expired."),
};

test("pages with no live need carry no navigation marker and no live surface", () => {
  for (const [name, markup] of Object.entries(socketFreePages)) {
    assert.match(navMarkup(markup), /data-site-nav data-phase=/, name);
    assert.doesNotMatch(markup, /data-live-nav/, name);
    // No board, no summary, and no personal or staff live region either, so the
    // hub keeps zero subscribers and opens no socket and schedules no polls.
    assert.doesNotMatch(markup, /data-live-board|data-live-summary|data-live-personal|data-live-staff/, name);
    // The only clients these pages load are the always-present runtime and the
    // saved-registration probe, and neither subscribes without its own root.
    const scripts = [...markup.matchAll(/<script src="([^"]+)"/g)].map(([, src]) => src);
    assert.deepEqual(scripts, ["/assets/live-ui.js", "/assets/participant.js"], name);
    assert.doesNotMatch(markup, /data-my-ducks-page/, name);
  }
  assert.match(participantScript, /if \(participantRoot\) \{/);
});

test("the nav client registers no subscriber on a page without the marker", async () => {
  const bare = navHarness("PREPARING", { eventStatus: "ROUND_ONE", liveNav: false });

  assert.equal(bare.subscriptions.length, 0, "an unmarked page must never subscribe");
  assert.equal(bare.requests.length, 0, "an unmarked page must never refetch the projection");
  // The server-rendered nav is left exactly as painted.
  assert.deepEqual(navLabels(bare), ["Home", "Staff"]);

  // The same markup with the marker does subscribe, so the marker is the only
  // thing separating the two.
  const marked = navHarness("PREPARING", { eventStatus: "ROUND_ONE", liveNav: true });
  assert.equal(marked.subscriptions.length, 1);
});

test("the served staff sign-in and not-found pages leave the live hub with no subscriber", () => {
  for (const [name, markup] of Object.entries(socketFreePages)) {
    const document = new QuickDocument("#document");
    const nav = document.createElement("nav");
    nav.dataset.siteNav = "";
    // The rendered page carries no `data-live-nav`, so the harness does not set it.
    assert.doesNotMatch(markup, /data-live-nav/, name);
    document.append(nav);

    const subscriptions = [];
    new Function("document", "fetch", "globalThis", sitePhaseNavScript)(
      document,
      async () => { throw new Error("no request may be made"); },
      { quickDucksLive: { subscribe(subscriber) { subscriptions.push(subscriber); } } },
    );

    assert.equal(subscriptions.length, 0, name);
  }
});

test("the navigation subscriber is the only reason live-ui.js would open a socket", () => {
  // The hub stays lazy: it activates only once a subscriber exists.
  assert.match(liveUiScript, /if \(active \|\| !startRequested \|\| subscribers\.size === 0\) return;/);
  // The navigation subscriber inside live-ui.js is gated on the server marker.
  assert.match(liveUiScript, /navRoot !== null && navRoot\.dataset\.liveNav !== undefined/);
  assert.match(liveUiScript, /if \(navIsLive\) \{\n\s*globalThis\.quickDucksLive\.subscribe\(/);
  // Nothing else in the runtime subscribes unconditionally.
  assert.equal((liveUiScript.match(/quickDucksLive\.subscribe\(/g) ?? []).length, 1);
});

test("the catch-all not-found path runs no phase query", async () => {
  for (const path of ["/no-such-page", "/wp-admin", "/.env", "/staff/../secret"]) {
    const { response, queries } = await page(path, "ROUND_ONE");

    assert.equal(response.status, 404, path);
    assert.deepEqual(queries, [], `${path} must not read the database`);
  }
  // An unknown private token costs its one lookup and nothing more.
  const unknownToken = await page(`/r/${"z".repeat(43)}`, "ROUND_ONE");
  assert.equal(unknownToken.response.status, 404);
  assert.equal(unknownToken.queries.length, 1);
  assert.doesNotMatch(unknownToken.queries[0], /FROM events/);

  // The comparison: a public content page does run exactly one phase query.
  const race = await page("/race", "ROUND_ONE");
  assert.equal(race.queries.length, 1);
  assert.match(race.queries[0], /SELECT status\s+FROM events/);
});

test("the not-found page renders the minimal Home and Staff navigation in every phase", async () => {
  for (const { statuses } of phaseMatrix) {
    for (const status of statuses) {
      const { response, body } = await page("/no-such-page", status);
      const where = String(status);

      assert.equal(response.status, 404, where);
      assert.deepEqual(visibleNav(body), ["Home", "Staff"], where);
      assert.doesNotMatch(navMarkup(body), /data-nav-register|data-nav-race/, where);
      assert.match(body, /Nothing is swimming here\./, where);
    }
  }
});

test("a nav fetch failure leaves the server-rendered nav untouched", async () => {
  const document = new QuickDocument("#document");
  const nav = document.createElement("nav");
  nav.dataset.siteNav = "";
  nav.dataset.liveNav = "";
  nav.dataset.phase = "RACING";
  nav.append(
    anchor(document, "navHome", "/", "Home"),
    anchor(document, "navRace", "/race", "Race Status"),
    anchor(document, "navStaff", "/staff", "Staff"),
  );
  document.append(nav);
  const subscriptions = [];
  new Function("document", "fetch", "globalThis", sitePhaseNavScript)(
    document,
    async () => { throw new Error("offline"); },
    { quickDucksLive: { subscribe(subscriber) { subscriptions.push(subscriber); } } },
  );

  await subscriptions[0].refresh();
  assert.deepEqual(nav.children.map((child) => child.textContent), ["Home", "Race Status", "Staff"]);
  assert.equal(nav.dataset.phase, "RACING");
});

// --- the compact home summary client ----------------------------------------

const summaryHarness = (board) => {
  const document = new QuickDocument("#document");
  const root = document.createElement("section");
  root.dataset.liveSummary = "";
  const stage = document.createElement("p");
  stage.dataset.liveSummaryStage = "";
  const title = document.createElement("h2");
  title.dataset.liveSummaryTitle = "";
  const line = document.createElement("p");
  line.dataset.liveSummaryLine = "";
  const error = document.createElement("p");
  error.dataset.liveSummaryError = "";
  error.hidden = true;
  root.append(stage, title, line, error);
  document.append(root);

  const requests = [];
  const subscriptions = [];
  new Function("document", "location", "fetch", "globalThis", liveScript)(
    document,
    { pathname: "/", protocol: "https:", host: "quickducks.com" },
    async (url) => {
      requests.push(String(url));
      if (typeof board === "function") return board();
      return Response.json(board);
    },
    { quickDucksLive: { subscribe(subscriber) { subscriptions.push(subscriber); } } },
  );

  return { error, line, requests, root, stage, subscriptions, title };
};

const boardBody = (overrides = {}) => ({
  event: {
    name: "Summer Duck Race",
    eventDate: "2026-08-30",
    status: "ROUND_ONE",
    currentHeat: { round: "ROUND_ONE", number: 5, status: "RUNNING" },
    roundOneHeats: [],
    finalHeats: [],
    podium: [],
    ...overrides,
  },
});

test("the home summary renders the stage chip and one current-heat line", async () => {
  const harness = summaryHarness(boardBody());

  assert.equal(harness.subscriptions.length, 1);
  assert.equal(harness.subscriptions[0].root, harness.root);
  await harness.subscriptions[0].refresh();

  assert.deepEqual(harness.requests, ["/api/v1/race-board"]);
  assert.equal(harness.stage.textContent, "Round one under way");
  assert.equal(harness.title.textContent, "Summer Duck Race");
  assert.equal(harness.line.textContent, "Running now: Round one · Heat 5 · Racing now.");
  assert.equal(harness.error.hidden, true);
});

test("the home summary falls back to the stage sentence when no heat is running", async () => {
  const harness = summaryHarness(boardBody({ status: "COMPLETED", currentHeat: null }));
  await harness.subscriptions[0].refresh();

  assert.equal(harness.stage.textContent, "Results official");
  assert.equal(harness.line.textContent, "Every heat is finished and the results are final.");
});

test("the home summary reports a hard board failure on its own error line", async () => {
  const harness = summaryHarness(() => Response.json({ error: "nope" }, { status: 503 }));
  await harness.subscriptions[0].refresh();

  assert.equal(harness.error.hidden, false);
  assert.match(harness.error.textContent, /The race board could not be loaded\./);
});

test("the home summary states plainly when there is no public race", async () => {
  const harness = summaryHarness({ event: null });
  await harness.subscriptions[0].refresh();

  assert.equal(harness.stage.textContent, "No race scheduled");
  assert.equal(harness.title.textContent, "No race is live right now.");
});

// --- My Ducks client: presence rule and search placement --------------------

const participantSection = (document, kind) => {
  const section = document.createElement("section");
  section.dataset.participantSection = kind;
  section.hidden = true;
  const controls = document.createElement("div");
  controls.dataset.carouselControls = "";
  controls.hidden = true;
  const previous = document.createElement("button");
  previous.dataset.carouselPrevious = "";
  const next = document.createElement("button");
  next.dataset.carouselNext = "";
  controls.append(previous, next);
  const track = document.createElement("div");
  track.dataset.participantTrack = "";
  track.hidden = true;
  section.append(controls, track);
  return section;
};

const myDucksHarness = (registrations, { phaseVisible }) => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  navigation.dataset.phaseVisible = phaseVisible ? "true" : "false";
  navigation.hidden = !phaseVisible;
  const page = document.createElement("section");
  page.dataset.myDucksPage = "";
  const error = document.createElement("p");
  error.dataset.myDucksError = "";
  error.hidden = true;
  const success = document.createElement("div");
  success.dataset.registrationSuccess = "";
  success.hidden = true;
  const empty = document.createElement("p");
  empty.dataset.myDucksEmpty = "";
  empty.hidden = true;
  const flow = document.createElement("div");
  flow.dataset.myDucksFlow = "";
  const searchLead = document.createElement("p");
  searchLead.dataset.searchLead = "";
  searchLead.hidden = true;
  flow.append(empty, participantSection(document, "awaiting"), participantSection(document, "paired"), searchLead);
  page.append(error, success, flow);
  document.append(navigation, page);

  const subscriptions = [];
  new Function(
    "document", "location", "window", "globalThis", "requestAnimationFrame", "history", "fetch",
    participantScript,
  )(
    document,
    { search: "", pathname: "/my-ducks", hash: "", origin: "https://quickducks.com" },
    { addEventListener() {} },
    { quickDucksLive: { subscribe(subscriber) { subscriptions.push(subscriber); } } },
    (callback) => callback(),
    { replaceState() {}, state: null },
    async () => Response.json({ registrations }),
  );

  return { document, empty, flow, navigation, searchLead, subscriptions };
};

const collected = (registrationId) => ({
  registrationId,
  firstName: "Daisy",
  lastName: "Duck",
  displayName: "Daisy Duck",
  lookupCode: "DAISY123",
  followed: false,
  registrationStatus: "SUBMITTED",
  paired: false,
  raceStatus: null,
});

test("an empty collection promotes the search to the top of My Ducks", async () => {
  const harness = myDucksHarness([], { phaseVisible: true });
  await harness.subscriptions[0].refresh();

  assert.equal(harness.flow.dataset.myDucksFlow, "empty");
  assert.equal(harness.searchLead.hidden, false, "empty devices get search guidance");
  assert.equal(harness.empty.hidden, false);
});

test("a non-empty collection drops the search below the saved ducks", async () => {
  const harness = myDucksHarness([collected("11111111-1111-4111-8111-111111111111")], { phaseVisible: true });
  await harness.subscriptions[0].refresh();

  assert.equal(harness.flow.dataset.myDucksFlow, "saved");
  assert.equal(harness.searchLead.hidden, true);
  assert.equal(harness.empty.hidden, true);
});

test("the phase controls My Ducks visibility while presence controls saved layout", async () => {
  const granted = myDucksHarness([], { phaseVisible: true });
  await granted.subscriptions[0].refresh();
  assert.equal(granted.navigation.hidden, false, "the phase half of the rule must win");
  assert.equal(granted.navigation.dataset.hasRegistrations, "false");

  const preparing = myDucksHarness([], { phaseVisible: false });
  await preparing.subscriptions[0].refresh();
  assert.equal(preparing.navigation.hidden, true);

  const savedWhilePreparing = myDucksHarness(
    [collected("22222222-2222-4222-8222-222222222222")],
    { phaseVisible: false },
  );
  await savedWhilePreparing.subscriptions[0].refresh();
  assert.equal(savedWhilePreparing.navigation.hidden, true, "saved registrations cannot reveal an unavailable route");
  assert.equal(savedWhilePreparing.navigation.dataset.hasRegistrations, "true");
});

test("the rendered phase surfaces never disagree with the resolver", () => {
  for (const { phase } of phaseMatrix) {
    const home = renderHome(phase);
    const register = renderRegistration(undefined, phase);
    const race = renderRace(phase);

    assert.deepEqual(visibleNav(home), expectedNav[phase], phase);
    assert.deepEqual(visibleNav(register), expectedNav[phase], phase);
    assert.deepEqual(visibleNav(race), expectedNav[phase], phase);
    assert.deepEqual(visibleNav(renderMyDucks(phase)), expectedNav[phase], phase);
    assert.deepEqual(homeCta(home), expectedHomeCta[phase], phase);
    assert.equal(register.includes(registrationPreparingMessage), phase === "PREPARING", phase);
    assert.equal(race.includes(registrationPreparingMessage), false, phase);
    assert.doesNotMatch(race, /data-race-preparing/, phase);
    assert.equal(
      register.includes(`<h1 class="page-title message-title">${registrationClosedMessage}</h1>`),
      !phaseAllowsRegistration(phase) && phase !== "PREPARING",
      phase,
    );
  }
});
