import assert from "node:assert/strict";
import test from "node:test";

import { announcerHelpersScript, announcerScript } from "./client-scripts.ts";
import worker, { createWorker } from "./index.ts";
import { renderAnnouncer } from "./site.ts";

const env = {
  APP_ORIGIN: "https://quickducks.com",
  AWS_REGION: "us-east-1",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_USER_POOL_CLIENT_ID: "client-example",
  COGNITO_DOMAIN: "https://quickducks-staff.example.com",
  DB: { prepare: () => ({ async first() { return { ok: 1 }; } }) },
};

const actor = (roles, isSystemAdmin = false) => ({
  id: "staff",
  cognitoSub: "sub",
  email: "announcer@example.com",
  displayName: "Announcer Staff",
  isSystemAdmin,
  roles,
  authentication: "bearer",
});

const announcerPage = (currentActor, path = "/staff/announcer") =>
  createWorker(async () => currentActor).fetch(new Request(`https://quickducks.com${path}`), env);

// ---------------------------------------------------------------------------
// Route: authentication, role gating, and staff HTML treatment
// ---------------------------------------------------------------------------

test("the announcer page sends anonymous visitors to sign-in with a returnTo", async () => {
  const response = await announcerPage(null);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/staff?returnTo=%2Fstaff%2Fannouncer");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("the announcer page opens for the announcer, the race director, and an administrator", async () => {
  for (const currentActor of [
    actor(["ANNOUNCER"]),
    actor(["RACE_DIRECTOR"]),
    actor(["ANNOUNCER", "RACE_DIRECTOR"]),
    actor([], true),
  ]) {
    const label = currentActor.isSystemAdmin ? "admin" : currentActor.roles.join(",");
    const response = await announcerPage(currentActor);

    assert.equal(response.status, 200, label);
    assert.match(await response.text(), /Read this out loud/, label);
  }
});

test("the announcer page refuses every other operational role with 403", async () => {
  for (const role of ["REGISTRATION", "DUCK_MANAGER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    const response = await announcerPage(actor([role]));
    const body = await response.text();

    assert.equal(response.status, 403, role);
    assert.match(body, /This account does not have permission to use the announcer station\./, role);
    assert.match(body, /<meta name="robots" content="noindex,nofollow">/, role);
  }

  // No operational role at all is refused the same way.
  assert.equal((await announcerPage(actor([]))).status, 403);
});

test("the announcer page keeps the staff HTML noindex, CSP, and referrer treatment", async () => {
  const response = await announcerPage(actor(["ANNOUNCER"]));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/quickducks-staff\.example\.com; frame-ancestors 'none'/,
  );
  assert.match(body, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(body, /<strong>Announcer Staff<\/strong>/);
});

test("only GET renders the announcer page", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await createWorker(async () => actor([], true)).fetch(
      new Request("https://quickducks.com/staff/announcer", { method }),
      env,
    );
    assert.equal(response.status, 404, method);
  }
});

test("the announcer page propagates rotated session cookies on both the allow and deny paths", async () => {
  // The refreshed identity is only recognised once the rotated cookie is in
  // play, exactly as the other staff pages are exercised.
  const rotating = (currentActor) => createWorker(
    async (request) => request.headers.get("cookie") === "__Host-quickducks_staff=new.jwt.token"
      ? currentActor
      : null,
    async () => Response.json({
      access_token: "new.jwt.token",
      refresh_token: "new.refresh.token",
      expires_in: 1800,
    }),
  );
  const expiredCookie = "__Host-quickducks_staff=expired.jwt.token; __Host-quickducks_staff_refresh=old.refresh.token";

  const allowed = await rotating(actor(["ANNOUNCER"])).fetch(
    new Request("https://quickducks.com/staff/announcer", { headers: { cookie: expiredCookie } }),
    env,
  );
  const denied = await rotating(actor(["REGISTRATION"])).fetch(
    new Request("https://quickducks.com/staff/announcer", { headers: { cookie: expiredCookie } }),
    env,
  );

  for (const [label, response, status] of [["allowed", allowed, 200], ["denied", denied, 403]]) {
    const cookies = response.headers.get("set-cookie") ?? "";
    assert.equal(response.status, status, label);
    assert.match(cookies, /__Host-quickducks_staff=new\.jwt\.token/, label);
    assert.match(cookies, /__Host-quickducks_staff_refresh=new\.refresh\.token/, label);
  }
});

test("the announcer client asset is served no-store like the other protected station assets", async () => {
  const response = await worker.fetch(new Request("https://quickducks.com/assets/announcer.js"), env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(body, /announcer-roster/);
  assert.match(body, /quickDucksLive\.subscribe/);
});

// ---------------------------------------------------------------------------
// Page markup
// ---------------------------------------------------------------------------

test("the announcer page renders the reading-script shell the client binds", () => {
  const markup = renderAnnouncer("Announcer Staff", true, false, ["ANNOUNCER"]);

  assert.match(markup, /<section class="page-panel station-panel announcer-panel" data-announcer data-live-staff data-system-admin="false" data-roles="ANNOUNCER">/);
  for (const hook of [
    "data-station-event",
    "data-announcer-heat",
    "data-announcer-cue",
    "data-announcer-roster",
    "data-announcer-podium",
    "data-announcer-podium-list",
    "data-announcer-progress",
    "data-announcer-results",
    "data-announcer-results-empty",
    "data-station-message",
  ]) {
    assert.ok(markup.includes(hook), `missing announcer hook ${hook}`);
  }
  assert.match(markup, /<script src="\/assets\/announcer\.js" defer><\/script>/);
  assert.match(markup, /<script src="\/assets\/live-ui\.js" defer><\/script>/);
  // The podium block only exists once the final has been recorded.
  assert.match(markup, /data-announcer-podium hidden/);
  // Non-interactive previews ship no client and hold no live connection.
  const preview = renderAnnouncer("Announcer Preview", false);
  assert.doesNotMatch(preview, /announcer\.js/);
  assert.doesNotMatch(preview, /data-live-staff/);
});

test("the announcer page is read-only: no form, no button, and no command hook", () => {
  const markup = renderAnnouncer("Announcer Staff", true, false, ["ANNOUNCER"]);
  const panel = markup.match(/<section class="page-panel station-panel announcer-panel"[\s\S]*<\/section>/)?.[0];

  assert.ok(panel);
  // Log out is the one form on the page and it belongs to the shared staff bar.
  assert.equal((panel.match(/<form/g) ?? []).length, 1);
  assert.match(panel, /<form class="staff-logout" method="post" action="\/staff\/logout">/);
  assert.equal((panel.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(panel, /<input|<select|<textarea/);
  assert.doesNotMatch(panel, /data-station-action|data-finish-action|data-submit-result|data-finish-scan-form/);
  assert.doesNotMatch(panel, /station-control/);
});

// The announcer needs names and duck numbers and nothing else, so the station
// body must never introduce a surface for contact, inventory, or audit data.
test("the announcer panel carries no participant contact detail or staff-only data", () => {
  const panel = renderAnnouncer("Announcer Staff", true, false, ["ANNOUNCER"])
    .match(/<section class="page-panel station-panel announcer-panel"[\s\S]*<\/section>/)?.[0];

  assert.ok(panel);
  assert.doesNotMatch(panel, /\b(?:email|phone|lookup|notes|audit|location|address)\b|tag token/i);
  // Slot, whole name, and duck number are the only participant fields the
  // announcer roster projection carries, and this page adds nothing to them.
  assert.doesNotMatch(panel, /registrationStatus|raceEntryId|privateStatus/);
});

test("announcer typography and layout stay large and contained at 320px", () => {
  const css = renderAnnouncer("Announcer Staff").match(/<style>([\s\S]+)<\/style>/)?.[1];

  assert.ok(css);
  // Names are the thing being read aloud, so they get the largest fluid ramp.
  assert.match(css, /\.announcer-name \{[^}]*font-size:clamp\(1\.5rem,6vw,2\.4rem\)/);
  assert.match(css, /\.announcer-panel h2 \{ font-size:clamp\(1\.8rem,7vw,3\.2rem\); overflow-wrap:anywhere; \}/);
  // Nothing may force a horizontal scrollbar on a narrow phone.
  assert.match(css, /\.announcer-roster li,\.announcer-results li \{[^}]*min-width:0;[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.announcer-name \{[^}]*min-width:0;[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.announcer-panel \.podium-place \{[^}]*min-width:0;[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.announcer-roster,\.announcer-results \{ display:grid;[^}]*list-style:none; \}/);
});

// ---------------------------------------------------------------------------
// Client behaviour
// ---------------------------------------------------------------------------

const helpers = () => new Function(`${announcerHelpersScript}; return {
  announcerPickEvent, announcerHeatLabel, announcerCue, announcerPlaceLabel,
  announcerDuckLine, announcerFullName,
};`)();

test("announcer helpers choose the racing event and speak plain race-day language", () => {
  const {
    announcerPickEvent,
    announcerHeatLabel,
    announcerCue,
    announcerPlaceLabel,
    announcerDuckLine,
    announcerFullName,
  } = helpers();

  // The racing event wins over a finished one; a finished race is still read out.
  assert.equal(announcerPickEvent([{ status: "COMPLETED" }, { status: "ROUND_ONE" }]).status, "ROUND_ONE");
  assert.equal(announcerPickEvent([{ status: "COMPLETED" }, { status: "FINAL" }]).status, "FINAL");
  assert.equal(announcerPickEvent([{ status: "COMPLETED" }]).status, "COMPLETED");
  assert.equal(announcerPickEvent([{ status: "REGISTRATION_OPEN" }, { status: "DRAFT" }]), null);
  assert.equal(announcerPickEvent([]), null);
  assert.equal(announcerPickEvent(undefined), null);

  assert.equal(announcerHeatLabel({ round: "ROUND_ONE", number: 4 }), "Round one · Heat 4");
  assert.equal(announcerHeatLabel({ round: "FINAL", number: 1 }), "The final");

  assert.match(announcerCue("READY"), /Read these racers out now/);
  assert.match(announcerCue("RUNNING"), /Racing now/);
  assert.match(announcerCue("AWAITING_RESULT"), /Hold for the official result/);
  // Unknown and prototype-shaped statuses degrade to a safe sentence.
  assert.equal(announcerCue("SOMETHING_NEW"), "Waiting for this heat to be confirmed.");
  assert.equal(announcerCue("constructor"), "Waiting for this heat to be confirmed.");

  assert.equal(announcerPlaceLabel(1), "First place");
  assert.equal(announcerPlaceLabel(2), "Second place");
  assert.equal(announcerPlaceLabel(3), "Third place");
  assert.equal(announcerPlaceLabel(4), "Place 4");

  assert.equal(announcerDuckLine(128), "Duck #128");
  assert.equal(announcerDuckLine(null), "Duck not assigned");
  assert.equal(announcerDuckLine(0), "Duck not assigned");

  // Announcers say the whole name.
  assert.equal(announcerFullName({ firstName: "Ada", lastName: "Lovelace" }), "Ada Lovelace");
  assert.equal(announcerFullName(null), "");
});

// A tiny attribute-selector DOM, enough to run the announcer client end to end.
const matchesSelector = (node, selector) => {
  const attribute = selector.match(/^\[data-([a-z0-9-]+)\]$/);
  if (attribute === null) return false;
  const key = attribute[1].replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
  return node.dataset[key] !== undefined;
};

class Node {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelector(selector) {
    return this.descendants().find((node) => matchesSelector(node, selector)) ?? null;
  }

  text() {
    return [this.textContent, ...this.children.map((child) => child.text())].join(" ").trim();
  }
}

class Document extends Node {
  createElement(tagName) {
    return new Node(tagName);
  }
}

const announcerHarness = (route) => {
  const document = new Document("#document");
  const root = document.createElement("section");
  root.dataset.announcer = "";
  const elements = {};
  for (const [name, key] of [
    ["eventLine", "stationEvent"],
    ["heatTitle", "announcerHeat"],
    ["cue", "announcerCue"],
    ["roster", "announcerRoster"],
    ["podium", "announcerPodium"],
    ["podiumList", "announcerPodiumList"],
    ["progress", "announcerProgress"],
    ["results", "announcerResults"],
    ["resultsEmpty", "announcerResultsEmpty"],
    ["message", "stationMessage"],
  ]) {
    const node = document.createElement("p");
    node.dataset[key] = "";
    elements[name] = node;
    root.append(node);
  }
  elements.podium.hidden = true;
  document.append(root);

  const requests = [];
  const fetchStub = async (url, options) => {
    requests.push({ url: String(url), options });
    return route(String(url));
  };
  const subscriptions = [];
  const assigned = [];

  new Function("document", "fetch", "location", "globalThis", announcerScript)(
    document,
    fetchStub,
    { pathname: "/staff/announcer", assign: (value) => assigned.push(value) },
    { quickDucksLive: { subscribe: (subscriber) => subscriptions.push(subscriber) } },
  );

  return {
    ...elements,
    assigned,
    document,
    refresh: () => subscriptions[0].refresh(),
    requests,
    root,
    subscriptions,
  };
};

const eventsBody = (status = "ROUND_ONE") => Response.json({
  events: [{ id: "event-1", name: "Duck Derby", status }],
});
const heat = (overrides) => ({
  id: "heat-1",
  round: "ROUND_ONE",
  number: 1,
  status: "FINALIZED",
  revision: 5,
  publishedResultCount: 1,
  ...overrides,
});
const roundOneRoster = Response.json({
  heat: { id: "heat-2", round: "ROUND_ONE", number: 2, status: "READY", revision: 2 },
  roster: [
    { slotNumber: 1, raceEntryId: "re-1", displayName: "Genevieve Abernathy-Blythe", duckNumber: 128 },
    { slotNumber: 2, raceEntryId: "re-2", displayName: "Bo Ng", duckNumber: 7 },
    { slotNumber: 3, raceEntryId: "re-3", displayName: "Unpaired Racer", duckNumber: null },
  ],
});

test("the announcer station reads out the upcoming heat with full names and duck numbers", async () => {
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events") return eventsBody();
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({
        event: { id: "event-1" },
        heats: [
          heat({ publishedResultCount: 0, status: "PLANNED" }),
          heat({ id: "heat-2", number: 2, status: "READY", revision: 2, publishedResultCount: 0 }),
        ],
      });
    }
    if (url === "/api/v1/staff/events/event-1/heats/heat-1/announcer-roster") return roundOneRoster;
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();

  assert.equal(harness.eventLine.textContent, "Duck Derby · Round one");
  assert.equal(harness.heatTitle.textContent, "Round one · Heat 2");
  assert.match(harness.cue.textContent, /Read these racers out now/);

  assert.equal(harness.roster.children.length, 3);
  const [first, second, third] = harness.roster.children;
  // Slot order, whole name, duck number: exactly what gets said.
  assert.deepEqual(first.children.map((child) => child.textContent), [
    "Slot 1",
    "Genevieve Abernathy-Blythe",
    "Duck #128",
  ]);
  assert.equal(first.children[1].className, "announcer-name");
  assert.deepEqual(second.children.map((child) => child.textContent), ["Slot 2", "Bo Ng", "Duck #7"]);
  assert.equal(third.children[2].textContent, "Duck not assigned");

  // Nothing decided yet.
  assert.equal(harness.results.children.length, 0);
  assert.equal(harness.resultsEmpty.hidden, false);
  assert.equal(harness.podium.hidden, true);
  assert.equal(harness.progress.textContent, "No heat has an official result yet.");
});

test("a recorded winner appears as soon as the finish line publishes it", async () => {
  let published = false;
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events") return eventsBody();
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({
        event: { id: "event-1" },
        heats: [
          heat({
            status: published ? "FINALIZED" : "AWAITING_RESULT",
            revision: published ? 6 : 5,
            publishedResultCount: published ? 1 : 0,
          }),
          heat({ id: "heat-2", number: 2, status: "PLANNED", revision: 1, publishedResultCount: 0 }),
        ],
      });
    }
    if (url === "/api/v1/staff/events/event-1/heats/heat-1/announcer-roster") return roundOneRoster;
    if (url === "/api/v1/staff/events/event-1/heats/heat-2/announcer-roster") return roundOneRoster;
    if (url === "/api/v1/staff/events/event-1/heats/heat-1") {
      return Response.json({
        heat: heat({}),
        roster: [],
        results: [{
          place: 1,
          raceEntryId: "re-1",
          participant: { firstName: "Ada", lastName: "Lovelace" },
          duck: { visibleNumber: 42 },
        }],
      });
    }
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();
  assert.equal(harness.results.children.length, 0);
  assert.equal(harness.resultsEmpty.hidden, false);

  // The finish line records the official result; the announcer never refreshes.
  published = true;
  await harness.refresh();

  assert.equal(harness.results.children.length, 1);
  assert.deepEqual(harness.results.children[0].children.map((child) => child.textContent), [
    "Round one · Heat 1",
    "Winner: Ada Lovelace",
    "Duck #42",
  ]);
  assert.equal(harness.resultsEmpty.hidden, true);
  assert.equal(harness.progress.textContent, "1 of 2 heats decided.");
  assert.equal(harness.podium.hidden, true);
});

test("the final publishes a full podium, not just its winner", async () => {
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events") return eventsBody("COMPLETED");
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({
        event: { id: "event-1" },
        heats: [
          heat({}),
          heat({ id: "final-1", round: "FINAL", number: 1, revision: 9, publishedResultCount: 3 }),
        ],
      });
    }
    if (url === "/api/v1/staff/events/event-1/heats/heat-1") {
      return Response.json({
        results: [{ place: 1, participant: { firstName: "Ada", lastName: "Lovelace" }, duck: { visibleNumber: 42 } }],
      });
    }
    if (url === "/api/v1/staff/events/event-1/heats/final-1") {
      return Response.json({
        results: [
          { place: 1, participant: { firstName: "Ada", lastName: "Lovelace" }, duck: { visibleNumber: 42 } },
          { place: 2, participant: { firstName: "Grace", lastName: "Hopper" }, duck: { visibleNumber: 8 } },
          { place: 3, participant: { firstName: "Katherine", lastName: "Johnson" }, duck: { visibleNumber: 15 } },
        ],
      });
    }
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();

  assert.equal(harness.podium.hidden, false);
  assert.equal(harness.podiumList.children.length, 3);
  assert.deepEqual(
    harness.podiumList.children.map((place) => place.children.map((child) => child.textContent)),
    [
      ["First place", "Ada Lovelace", "Duck #42"],
      ["Second place", "Grace Hopper", "Duck #8"],
      ["Third place", "Katherine Johnson", "Duck #15"],
    ],
  );
  for (const place of harness.podiumList.children) assert.equal(place.className, "podium-place");

  // The final also appears in the decided list, highlighted as the final.
  assert.equal(harness.results.children.length, 2);
  assert.equal(harness.results.children[1].className, "final-heat");
  assert.deepEqual(harness.results.children[1].children.map((child) => child.textContent), [
    "The final",
    "Winner: Ada Lovelace",
    "Duck #42",
  ]);

  // Every heat is done, so there is nothing left to call up.
  assert.equal(harness.heatTitle.textContent, "No heat is up right now");
  assert.match(harness.cue.textContent, /Every heat has been decided/);
  assert.equal(harness.progress.textContent, "2 of 2 heats decided.");
});

test("the announcer station issues only GET requests and never a command", async () => {
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events") return eventsBody();
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({ event: { id: "event-1" }, heats: [heat({})] });
    }
    if (url === "/api/v1/staff/events/event-1/heats/heat-1") return Response.json({ results: [] });
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();

  assert.ok(harness.requests.length > 0);
  for (const request of harness.requests) {
    assert.equal(request.options?.method, undefined, request.url);
    assert.equal(request.options?.body, undefined, request.url);
    assert.equal(request.options?.headers?.accept, "application/json");
    assert.equal(request.options?.cache, "no-store");
    assert.doesNotMatch(
      request.url,
      /\/(lock|ready|call|start|finish|roster|results\/(finalize|reopen|correct)|plan-commit)$/,
      request.url,
    );
  }
});

test("decided heats are read once per revision so a live signal cannot refetch the race", async () => {
  let revision = 5;
  const detailRequests = [];
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events") return eventsBody();
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({ event: { id: "event-1" }, heats: [heat({ revision })] });
    }
    if (url === "/api/v1/staff/events/event-1/heats/heat-1") {
      detailRequests.push(revision);
      return Response.json({
        results: [{ place: 1, participant: { firstName: "Ada", lastName: "Lovelace" }, duck: { visibleNumber: 42 } }],
      });
    }
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();
  await harness.refresh();
  await harness.refresh();
  assert.deepEqual(detailRequests, [5], "a settled heat is read exactly once");

  // A race-director correction bumps the revision, so it is re-read immediately.
  revision = 6;
  await harness.refresh();
  assert.deepEqual(detailRequests, [5, 6]);
});

test("the announcer client is DOM-safe, live-subscribed, and signs out on 401", () => {
  assert.doesNotThrow(() => new Function(announcerScript));
  assert.doesNotMatch(announcerScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(announcerScript, /\b(?:window\.)?confirm\s*\(/);
  assert.match(announcerScript, /replaceChildren/);
  assert.match(announcerScript, /textContent/);
  assert.match(announcerScript, /createElement/);

  // Read-only: no mutating verb, no command envelope, no lifecycle transition.
  assert.doesNotMatch(announcerScript, /method: "(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(announcerScript, /crypto\.randomUUID|commandId|beginBusy|markClean/);
  assert.doesNotMatch(announcerScript, /results\/(?:finalize|reopen|correct)|plan-commit|finish-scan/);

  // It reuses the existing announcer-roster projection rather than a new query.
  assert.match(announcerScript, /"\/announcer-roster"/);
  assert.ok(announcerScript.includes(
    'await announcerApi(eventPath + "/heats/" + encodeURIComponent(upcoming.id) + "/announcer-roster")',
  ));

  // The shared live hub is the only refresh mechanism: no private socket, no timer.
  assert.doesNotMatch(announcerScript, /new WebSocket\(|liveCreatePollScheduler\(|setInterval/);
  assert.ok(announcerScript.includes(`globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: announcerRoot,
    refresh: announcerLoadWork,
  });`));

  assert.ok(announcerScript.includes('location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));'));
  assert.match(announcerScript, /if \(error\.message !== "signed-out"\) announcerMessage\.textContent = error\.message;/);
});

test("the announcer client subscribes only when its page is the one rendered", () => {
  const harness = announcerHarness(() => Response.json({}));
  assert.equal(harness.subscriptions.length, 1);
  assert.deepEqual(harness.subscriptions[0].domains, ["event", "participants", "ducks", "heats"]);
  assert.equal(harness.subscriptions[0].root, harness.root);

  // Without the announcer root the client registers nothing, so a page that is
  // not this station never spends one of the bounded live connections.
  const document = new Document("#document");
  const subscriptions = [];
  new Function("document", "fetch", "location", "globalThis", announcerScript)(
    document,
    async () => Response.json({}),
    { pathname: "/staff", assign: () => {} },
    { quickDucksLive: { subscribe: (subscriber) => subscriptions.push(subscriber) } },
  );
  assert.equal(subscriptions.length, 0);
});

test("an operational failure lands on the station message line and clears on recovery", async () => {
  let broken = true;
  const harness = announcerHarness((url) => {
    if (url === "/api/v1/staff/events" && broken) {
      return Response.json({ error: "Permission required." }, { status: 403 });
    }
    if (url === "/api/v1/staff/events") return eventsBody();
    if (url === "/api/v1/staff/events/event-1/heats") {
      return Response.json({ event: { id: "event-1" }, heats: [] });
    }
    throw new Error(`unexpected request ${url}`);
  });

  await harness.refresh();
  assert.equal(harness.message.textContent, "Permission required.");

  broken = false;
  await harness.refresh();
  assert.equal(harness.message.textContent, "This station only reads. It never changes the race.");
});

test("a 401 clears the private page and returns to sign-in", async () => {
  const harness = announcerHarness(() => new Response("", { status: 401 }));

  await harness.refresh();

  assert.deepEqual(harness.assigned, ["/staff?returnTo=%2Fstaff%2Fannouncer"]);
});
