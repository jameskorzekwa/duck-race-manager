import assert from "node:assert/strict";
import test from "node:test";

import { liveUiScript, staffAccessScript, staffHomeScript } from "./client-scripts.ts";
import {
  renderAnnouncer,
  renderFinishLine,
  renderStaffInventory,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
  renderStaffNoAccess,
  renderStaffRegistration,
  renderStartLine,
} from "./site.ts";

// Inventory left the console for /staff/inventory, so it is no longer one of
// the sections the console reveals when an event exists.
const eventScopedIds = ["participants", "heats", "support"];

const sectionTag = (markup, id) => {
  const match = markup.match(new RegExp(`<section class="console-section" id="${id}"[^>]*>`));
  return match === null ? null : match[0];
};

const consoleNav = (markup) => {
  const match = markup.match(/<nav class="console-nav"[^]*?<\/nav>/);
  assert.ok(match, "the console renders its operations nav");
  return match[0];
};

const staffNav = (markup) => {
  const match = markup.match(/<nav class="staff-nav"[^]*?<\/nav>/);
  return match === null ? null : match[0];
};

const navHrefs = (nav) => [...nav.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);

// The console's own gating function, lifted out of the generated script so the
// shipped browser behaviour is exercised rather than a copy of it.
const eventScopedToggle = () => {
  const source = staffHomeScript.match(/const showEventScopedSections = \(eventExists\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(source, "the console script defines showEventScopedSections");
  // The view switcher is the other half of the same gating pass, so it is
  // injected here and its calls are recorded rather than reimplemented.
  return (elements, noRaceState, appliedViews = []) => new Function(
    "eventScopedElements",
    "noRaceState",
    "applyConsoleView",
    "requestedConsoleView",
    "appliedViews",
    `${source} return showEventScopedSections;`,
  )(elements, noRaceState, (view) => appliedViews.push(view), () => null, appliedViews);
};

const scopedElement = (roleAllowed) => ({ hidden: true, dataset: roleAllowed === undefined ? {} : { roleAllowed } });

// Three race-control surfaces were removed outright. The balanced planner is a
// retired assignment model, and the lock-roster and announcer-roster buttons
// are respectively obsolete (rounds lock themselves) and a visible no-op.
test("the heats console drops the balanced planner, lock-roster, and announcer-roster controls", () => {
  const consoles = [
    ["administrator", renderStaffHome("Administrator", true, [])],
    ["race director", renderStaffHome("Race Director", false, ["RACE_DIRECTOR"])],
    ["announcer", renderStaffHome("Announcer", false, ["ANNOUNCER"])],
    ["heat runner", renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"])],
  ];
  for (const [label, markup] of consoles) {
    const heats = markup.match(/<section class="console-section" id="heats"[^]*?<\/section>/)?.[0];
    assert.ok(heats, `${label} renders the heats section`);
    assert.doesNotMatch(heats, /Balanced round-one plan|data-plan-preview|data-plan-commit|data-plan-result/, label);
    assert.doesNotMatch(heats, /Lock roster|Load announcer roster/, label);
    // The surviving race-control surfaces are untouched.
    assert.match(heats, /data-heat-list/, label);
    assert.match(heats, /data-finalist-list/, label);
  }

  // The draft configuration form no longer offers a heat assignment mode.
  const adminMarkup = renderStaffHome("Administrator", true, []);
  assert.doesNotMatch(adminMarkup, /heatAssignmentMode|POST_CLOSE_BALANCED|Balanced plan after close/);

  // The start-line station lost its lock action and says so.
  const startLine = renderStartLine("Heat Runner", true, false, ["HEAT_RUNNER"]);
  assert.doesNotMatch(startLine, /Lock roster|lock, ready, call/);
  assert.match(startLine, /This station can only ready, call, or start a heat\./);
});

test("every event-scoped console section ships hidden so no section flashes before an event loads", () => {
  const consoles = [
    ["administrator", renderStaffHome("Administrator", true, [])],
    ["race director", renderStaffHome("Race Director", false, ["RACE_DIRECTOR"])],
    ["registration", renderStaffHome("Registration Staff", false, ["REGISTRATION"])],
    ["announcer", renderStaffHome("Announcer", false, ["ANNOUNCER"])],
    ["result taker", renderStaffHome("Result Taker", false, ["RESULT_TAKER"])],
  ];

  for (const [label, markup] of consoles) {
    for (const id of eventScopedIds) {
      const tag = sectionTag(markup, id);
      if (tag === null) {
        // Only the administrator-only support section may be absent entirely.
        assert.equal(id, "support", `${label} must still render the ${id} section`);
        continue;
      }
      assert.match(tag, / data-event-scoped /, `${label}: ${id} must be event-scoped`);
      assert.match(tag, / data-role-allowed="(?:true|false)"/, `${label}: ${id} must declare role gating`);
      assert.match(tag, / hidden>$/, `${label}: ${id} must ship hidden`);
    }
    // The Event Details view is never event-scoped: it is the view that creates one.
    const events = sectionTag(markup, "event");
    assert.ok(events);
    assert.doesNotMatch(events, /data-event-scoped/, `${label}: the event view is always available`);
    assert.doesNotMatch(events, /hidden/, `${label}: the event view is not hidden`);
    // Every section is also an Admin view, so exactly one can be displayed.
    assert.match(events, / data-console-view="event"/, label);
  }

  // An account with no roles at all has no console to ship: it gets the real
  // "No operational roles assigned" page instead of an empty console shell, so
  // there is no section, no menu bar, and no console script to load.
  const noRoles = renderStaffHome("No Role", false, []);
  assert.match(noRoles, /No operational roles assigned/);
  assert.equal(sectionTag(noRoles, "event"), null);
  assert.doesNotMatch(noRoles, /src="\/assets\/staff-home\.js"/);
  assert.doesNotMatch(noRoles, /class="console-nav"|data-console-view|data-console-message/);
});

// The Admin console is a menu bar over separate views. Only one is displayed at
// a time, and the switcher is driven by the URL hash so a view is linkable and
// moves with browser back and forward.
test("the Admin menu bar lists six items in order and every view is a separate section", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const menu = consoleNav(markup);

  assert.match(menu, /aria-label="Admin views"/);
  assert.deepEqual(navHrefs(menu), [
    "#event",
    "#heats",
    "#participants",
    "/staff/inventory",
    "#support",
    "/staff/access",
  ]);
  assert.deepEqual(
    [...menu.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((match) => match[1]),
    ["Event Details", "Heats", "Participants", "Inventory", "Support", "Access"],
  );

  // Event Details is the default view and is marked current in the served markup.
  assert.match(menu, /<a href="#event" data-console-view-link="event" aria-current="page">Event Details<\/a>/);
  assert.equal((menu.match(/aria-current="page"/g) ?? []).length, 1);

  // Each in-page item names the view it switches to; the two page links do not.
  for (const view of ["event", "heats", "participants", "support"]) {
    assert.match(menu, new RegExp(`<a href="#${view}" data-console-view-link="${view}"`), view);
    assert.match(markup, new RegExp(`<section class="console-section" id="${view}"[^>]* data-console-view="${view}"`), view);
  }
  assert.doesNotMatch(menu, /\/staff\/(?:inventory|access)" data-console-view-link/);

  // Exactly one view is visible in the served markup: Event Details. The other
  // three keep their existing event scope and ship hidden.
  const viewTags = [...markup.matchAll(/<section class="console-section" id="[a-z]+"[^>]*>/g)].map((match) => match[0]);
  assert.equal(viewTags.length, 4);
  assert.equal(viewTags.filter((tag) => / hidden>$/.test(tag)).length, 3);
});

test("the Admin menu bar also renders on the two pages it links out to", () => {
  const inventory = renderStaffInventory("Administrator", "https://quickducks.com", true, []);
  const access = renderStaffAccess("Administrator", true, []);

  // Off the console the hash items are absolute links back into /staff, they
  // carry no console hooks, and none of them ships hidden — nothing on those
  // pages would ever reveal them.
  for (const [label, markup, current] of [
    ["inventory", inventory, "/staff/inventory"],
    ["access", access, "/staff/access"],
  ]) {
    const menu = consoleNav(markup);
    assert.deepEqual(navHrefs(menu), [
      "/staff#event",
      "/staff#heats",
      "/staff#participants",
      "/staff/inventory",
      "/staff#support",
      "/staff/access",
    ], label);
    assert.doesNotMatch(menu, /data-console-view-link|data-event-scoped|hidden/, label);
    assert.match(menu, new RegExp(`<a href="${current}" aria-current="page">`), label);
    assert.equal((menu.match(/aria-current="page"/g) ?? []).length, 1, label);
  }

  // A non-administrator duck manager has no Admin console, so no menu bar; the
  // top-level staff nav carries their Inventory link instead.
  const duckManager = renderStaffInventory("Duck Manager", "https://quickducks.com", false, ["DUCK_MANAGER"]);
  assert.doesNotMatch(duckManager, /class="console-nav"/);
  assert.match(staffNav(duckManager), /<a href="\/staff\/inventory" aria-current="page">Inventory<\/a>/);
});

test("role gating is recorded on each event-scoped section and survives event existence", () => {
  const registration = renderStaffHome("Registration Staff", false, ["REGISTRATION"]);
  const announcer = renderStaffHome("Announcer", false, ["ANNOUNCER"]);

  assert.match(sectionTag(registration, "participants"), /data-role-allowed="true"/);
  assert.match(sectionTag(registration, "heats"), /data-role-allowed="false"/);

  assert.match(sectionTag(announcer, "heats"), /data-role-allowed="true"/);
  assert.match(sectionTag(announcer, "participants"), /data-role-allowed="false"/);

  // The Returns section is gone from every console, for every role, and
  // Inventory is a page of its own rather than a section here.
  for (const markup of [registration, announcer]) {
    assert.equal(sectionTag(markup, "returns"), null);
    assert.equal(sectionTag(markup, "inventory"), null);
  }

  // A race director may use every event-scoped section except administrator support.
  const director = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);
  for (const id of ["participants", "heats"]) {
    assert.match(sectionTag(director, id), /data-role-allowed="true"/, id);
  }
  assert.equal(sectionTag(director, "inventory"), null);
  assert.equal(sectionTag(director, "support"), null);
});

test("Admin menu-bar items are event-scoped, ship hidden, and stay role filtered", () => {
  const admin = consoleNav(renderStaffHome("Administrator", true, []));
  for (const anchor of admin.matchAll(/<a href="#([a-z]+)" data-console-view-link="[a-z]+"([^>]*)>/g)) {
    if (anchor[1] === "event") {
      assert.equal(anchor[2], ' aria-current="page"', "the event item is always visible and starts current");
      continue;
    }
    assert.equal(anchor[2], " data-event-scoped hidden", `#${anchor[1]} must ship hidden and event-scoped`);
  }

  // Role filtering removes items entirely for roles that cannot use them, and
  // the item's gating always matches the gating of the surface it opens.
  assert.deepEqual(
    navHrefs(consoleNav(renderStaffHome("Announcer", false, ["ANNOUNCER"]))),
    ["#event", "#heats"],
  );
  // An account with no operational roles gets no console, and therefore no
  // menu bar to be filtered at all.
  assert.doesNotMatch(renderStaffHome("Roleless Staff", false, []), /class="console-nav"/);
  assert.deepEqual(
    navHrefs(consoleNav(renderStaffHome("Registration Staff", false, ["REGISTRATION"]))),
    ["#event", "#participants"],
  );
  // A duck manager reaches Inventory from the menu bar's page link.
  assert.deepEqual(
    navHrefs(consoleNav(renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]))),
    ["#event", "/staff/inventory"],
  );
  // Support and Access stay administrator-only.
  for (const role of ["RACE_DIRECTOR", "REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    assert.doesNotMatch(consoleNav(renderStaffHome("Staff", false, [role])), /#support|\/staff\/access/, role);
  }
});

test("the console renders a hidden No race yet state that the no-events branch reveals", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const eventsSection = markup.match(/<section class="console-section" id="event"[^]*?<\/section>/)?.[0];

  assert.ok(eventsSection);
  assert.match(eventsSection, /<div class="notice" data-no-race hidden><strong>No race yet\.<\/strong>/);
  assert.match(eventsSection, /Create the race event to open participants, inventory, heats, and support\./);
  // It is inside the always-available Event section, above the create card.
  assert.ok(eventsSection.indexOf("data-no-race") < eventsSection.indexOf("data-event-create-card"));
});

test("the generated gating function reveals only role-allowed sections and follows event existence", () => {
  const build = eventScopedToggle();
  const allowedSection = scopedElement("true");
  const deniedSection = scopedElement("false");
  const navAnchor = scopedElement();
  const noRaceState = { hidden: true };
  const appliedViews = [];
  const showEventScopedSections = build([allowedSection, deniedSection, navAnchor], noRaceState, appliedViews);

  // An event exists: role-allowed sections and their anchors appear, denied ones do not.
  showEventScopedSections(true);
  assert.equal(allowedSection.hidden, false);
  assert.equal(deniedSection.hidden, true, "role gating still applies on top of event existence");
  assert.equal(navAnchor.hidden, false);
  assert.equal(noRaceState.hidden, true);

  // No event: everything event-scoped hides again and the no-race state appears.
  showEventScopedSections(false);
  assert.equal(allowedSection.hidden, true);
  assert.equal(deniedSection.hidden, true);
  assert.equal(navAnchor.hidden, true);
  assert.equal(noRaceState.hidden, false);

  // Re-revealing is idempotent, so repeated refreshes never strand a section.
  showEventScopedSections(true);
  showEventScopedSections(true);
  assert.equal(allowedSection.hidden, false);
  assert.equal(deniedSection.hidden, true);
  assert.equal(noRaceState.hidden, true);

  // Every pass hands the final say over section visibility to the view switcher.
  assert.equal(appliedViews.length, 4);
});

// The switcher itself, lifted out of the generated script so the shipped
// browser code is exercised rather than a copy of it.
const consoleViewSwitcher = (sections, links, eventExists) => {
  const source = staffHomeScript.match(
    /const consoleViewAvailable = [\s\S]*?\nconst applyConsoleView = \(requested\) => \{[\s\S]*?\n\};/,
  )?.[0];
  assert.ok(source, "the console script defines the Admin view switcher");
  return new Function(
    "consoleViewSections",
    "consoleViewLinks",
    "consoleEventExists",
    `${source} return applyConsoleView;`,
  )(sections, links, eventExists);
};

const viewSection = (view, { eventScoped = false, roleAllowed } = {}) => ({
  hidden: true,
  dataset: roleAllowed === undefined ? { consoleView: view } : { consoleView: view, roleAllowed },
  hasAttribute: (name) => name === "data-event-scoped" && eventScoped,
});

const viewLink = (view) => ({
  dataset: { consoleViewLink: view },
  current: null,
  setAttribute(name, value) {
    if (name === "aria-current") this.current = value;
  },
  removeAttribute(name) {
    if (name === "aria-current") this.current = null;
  },
});

test("the view switcher shows exactly one permitted view and falls back when one is unavailable", () => {
  const event = viewSection("event");
  const heats = viewSection("heats", { eventScoped: true, roleAllowed: "true" });
  const participants = viewSection("participants", { eventScoped: true, roleAllowed: "false" });
  const links = ["event", "heats", "participants"].map(viewLink);

  // No event yet: only the always-available Event Details view can show, so a
  // hash pointing at an event-scoped view falls back to it.
  const beforeEvent = consoleViewSwitcher([event, heats, participants], links, false);
  assert.equal(beforeEvent("heats"), "event");
  assert.deepEqual([event.hidden, heats.hidden, participants.hidden], [false, true, true]);
  assert.deepEqual(links.map((link) => link.current), ["page", null, null]);

  // Once the event loads the same hash resolves to the requested view.
  const afterEvent = consoleViewSwitcher([event, heats, participants], links, true);
  assert.equal(afterEvent("heats"), "heats");
  assert.deepEqual([event.hidden, heats.hidden, participants.hidden], [true, false, true]);
  assert.deepEqual(links.map((link) => link.current), [null, "page", null]);

  // A role-denied view can never be reached, however it is requested.
  assert.equal(afterEvent("participants"), "event");
  assert.equal(participants.hidden, true, "the switcher never reveals a role-denied section");
  // An unknown or absent hash lands on the first permitted, available view.
  assert.equal(afterEvent(null), "event");
  assert.equal(afterEvent("nonsense"), "event");
  // Exactly one section is visible after every pass.
  assert.equal([event, heats, participants].filter((section) => !section.hidden).length, 1);
});

test("the console binds the view switcher to the hash, page load, and roster deep links", () => {
  assert.ok(staffHomeScript.includes('const consoleViewSections = [...document.querySelectorAll("[data-console-view]")];'));
  assert.ok(staffHomeScript.includes('const consoleViewLinks = [...document.querySelectorAll("[data-console-view-link]")];'));
  // Linkable, reload-safe, and back/forward aware.
  assert.ok(staffHomeScript.includes('const hash = location.hash.replace(/^#/, "");'));
  assert.ok(staffHomeScript.includes('globalThis.addEventListener("hashchange", () => applyConsoleView(requestedConsoleView()));'));
  assert.ok(staffHomeScript.includes("\napplyConsoleView(requestedConsoleView());"));
  // A heat-roster participant link switches views through the same hash path.
  assert.ok(staffHomeScript.includes('revealConsoleSection("participants");'));
  assert.ok(staffHomeScript.includes("else location.hash = view;"));
  // Loading data never depends on a view being displayed: hidden views stay
  // populated so switching to one is instant and refresh keeps working.
  assert.ok(staffHomeScript.includes("if (canRegistration) loads.push(loadParticipants(true));"));
  assert.ok(staffHomeScript.includes("if (canRaceRead) loads.push(loadHeats(), loadFinalists());"));
  assert.doesNotMatch(staffHomeScript, /if \([a-zA-Z]+\.hidden\) return;\s*\n\s*(?:await )?load/);
});

test("the console drives gating from the event load and the no-events branch", () => {
  assert.ok(staffHomeScript.includes('const eventScopedElements = document.querySelectorAll("[data-event-scoped]");'));
  assert.ok(staffHomeScript.includes('const noRaceState = document.querySelector("[data-no-race]");'));

  // renderEvent reveals sections only after the selected event is rendered.
  const renderEventStart = staffHomeScript.indexOf("const renderEvent = (detail, readiness) => {");
  const revealRegion = staffHomeScript.indexOf("if (eventDetailRegion) eventDetailRegion.hidden = false;", renderEventStart);
  const reveal = staffHomeScript.indexOf("showEventScopedSections(true);", renderEventStart);
  const renderEventReturn = staffHomeScript.indexOf("return true;", renderEventStart);
  assert.ok(renderEventStart >= 0 && revealRegion > renderEventStart);
  assert.ok(reveal > revealRegion && reveal < renderEventReturn, "sections are revealed as the event renders");

  // The no-events branch hides them again before the console reports the state.
  const noEventsBranch = staffHomeScript.indexOf('eventSelect.append(new Option("No event exists", ""));');
  const hide = staffHomeScript.indexOf("showEventScopedSections(false);", noEventsBranch);
  const noEventsMessage = staffHomeScript.indexOf('setMessage("No event dataset exists. An administrator can create one.");');
  assert.ok(noEventsBranch >= 0);
  assert.ok(hide > noEventsBranch && hide < noEventsMessage, "the no-events branch hides the event-scoped sections");

  // Gating is decided in exactly two places: an event loaded, or none exists.
  assert.equal((staffHomeScript.match(/showEventScopedSections\(/g) ?? []).length, 2);
  assert.equal((staffHomeScript.match(/showEventScopedSections\(true\)/g) ?? []).length, 1);
  assert.equal((staffHomeScript.match(/showEventScopedSections\(false\)/g) ?? []).length, 1);
});

test("the staff nav lists only the pages the actor may open", () => {
  const everyPage = [
    "/staff",
    "/staff/registration",
    "/staff/announcer",
    "/staff/start-line",
    "/staff/finish-line",
  ];
  // The nav is read from the page each actor actually lands on, so a role is
  // never asserted against a console it could not open. A station-only actor
  // never sees `renderStaffHome` at all.
  const stationPage = (roles) => roles.includes("HEAT_RUNNER")
    ? renderStartLine("Staff", true, false, roles)
    : roles.includes("RESULT_TAKER")
      ? renderFinishLine("Staff", true, false, roles)
      : roles.includes("ANNOUNCER")
        ? renderAnnouncer("Staff", true, false, roles)
        : roles.includes("REGISTRATION")
          ? renderStaffRegistration("Staff", false, roles)
          : renderStaffInventory("Staff", "https://quickducks.com", false, roles);

  const cases = [
    // An administrator reaches Inventory and Access from the Admin menu bar, so
    // the top-level nav does not repeat them.
    [renderStaffHome("Administrator", true, []), everyPage],
    // A race director opens the Admin view too, so Admin is offered and their
    // Inventory link moves into that menu bar exactly as an administrator's does.
    [renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]), everyPage],
    [stationPage(["HEAT_RUNNER"]), ["/staff/start-line"]],
    [stationPage(["RESULT_TAKER"]), ["/staff/finish-line"]],
    // A duck manager who is neither an administrator nor a race director has no
    // Admin menu bar, so Inventory is the only link to their own page.
    [stationPage(["DUCK_MANAGER"]), ["/staff/inventory"]],
    [stationPage(["ANNOUNCER"]), ["/staff/announcer"]],
    [stationPage(["REGISTRATION"]), ["/staff/registration"]],
    [renderStaffNoAccess("No Role"), null],
    [stationPage(["RESULT_TAKER", "DUCK_MANAGER"]), ["/staff/finish-line", "/staff/inventory"]],
    [stationPage(["ANNOUNCER", "HEAT_RUNNER"]), ["/staff/announcer", "/staff/start-line"]],
    [renderStaffAccess("Administrator"), everyPage],
    [renderStaffRegistration("Registration Staff", false, ["REGISTRATION"]), ["/staff/registration"]],
  ];

  for (const [markup, expected] of cases) {
    const nav = staffNav(markup);
    if (expected === null) {
      // The no-roles page offers no staff page at all, because there is none.
      assert.equal(nav, null, "the no-access page renders no staff nav");
      continue;
    }
    assert.ok(nav, "every staff page renders the staff nav");
    assert.deepEqual(navHrefs(nav), expected);
    assert.match(nav, /aria-label="Staff pages"/);
  }

  // Admin is offered to administrators and race directors and to nobody else.
  for (const role of ["REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    assert.doesNotMatch(staffNav(stationPage([role])), /href="\/staff"/, role);
    // Access left the top-level nav entirely; it is an Admin menu-bar item.
    assert.doesNotMatch(staffNav(stationPage([role])), /\/staff\/access/, role);
  }
  assert.match(staffNav(renderStaffHome("Race Director", false, ["RACE_DIRECTOR"])), /href="\/staff"/);

  // Registration is gated exactly like the registration APIs it fronts.
  for (const role of ["DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    assert.doesNotMatch(staffNav(stationPage([role])), /\/staff\/registration/, role);
  }

  // Announcer is a race-day station gated exactly like the two it reports on:
  // its own role, the race director, and an administrator implicitly.
  for (const role of ["REGISTRATION", "DUCK_MANAGER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    assert.doesNotMatch(staffNav(stationPage([role])), /\/staff\/announcer/, role);
  }
});

// The staff nav reads Admin, Registration, Announcer, Start line, Finish line,
// and finally the Inventory fallback for a duck manager with no Admin menu bar.
// Order is asserted as adjacency and as ends of the list, not as fixed indexes,
// so the requirement survives any later page being added or removed.
test("the staff nav reads Admin, Registration, Announcer, Start line, Finish line", () => {
  const navs = [
    ["administrator", staffNav(renderStaffHome("Administrator", true, []))],
    ["race director", staffNav(renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]))],
    ["announcer and heat runner", staffNav(renderAnnouncer("Mixed", true, false, ["ANNOUNCER", "HEAT_RUNNER"]))],
  ];

  for (const [label, nav] of navs) {
    const hrefs = navHrefs(nav);
    assert.equal(
      hrefs.indexOf("/staff/start-line"),
      hrefs.indexOf("/staff/announcer") + 1,
      `start line must follow announcer for ${label}`,
    );
    assert.match(nav, /<a href="\/staff\/announcer"[^>]*>Announcer<\/a><a href="\/staff\/start-line"[^>]*>Start line<\/a>/, label);
  }

  // Admin is the left-most entry when it appears, and it appears for both of
  // the actors who can open it: an administrator and a race director. Neither
  // repeats Inventory, because the Admin menu bar already carries it.
  const everyAdminPage = [
    "/staff",
    "/staff/registration",
    "/staff/announcer",
    "/staff/start-line",
    "/staff/finish-line",
  ];
  const admin = navHrefs(staffNav(renderStaffHome("Administrator", true, [])));
  assert.equal(admin[0], "/staff");
  assert.deepEqual(admin, everyAdminPage);

  const director = navHrefs(staffNav(renderStaffHome("Race Director", false, ["RACE_DIRECTOR"])));
  assert.equal(director[0], "/staff");
  assert.deepEqual(director, everyAdminPage);

  // The Inventory fallback belongs to a duck manager with no Admin menu bar,
  // and it is the last item.
  const duckManager = navHrefs(staffNav(
    renderStaffInventory("Duck Manager", "https://quickducks.com", false, ["DUCK_MANAGER"]),
  ));
  assert.deepEqual(duckManager, ["/staff/inventory"]);
  assert.equal(duckManager.at(-1), "/staff/inventory");

  // An announcer without the start-line role still gets exactly their own link.
  assert.deepEqual(navHrefs(staffNav(renderAnnouncer("Announcer", true, false, ["ANNOUNCER"]))), ["/staff/announcer"]);
});

test("the staff nav is on every operational staff page and marks the current one", () => {
  const pages = [
    [renderStaffHome("Administrator", true, []), "/staff"],
    [renderStaffRegistration("Registration Staff", false, ["REGISTRATION"]), "/staff/registration"],
    [renderStartLine("Heat Runner", true, false, ["HEAT_RUNNER"]), "/staff/start-line"],
    [renderAnnouncer("Announcer", true, false, ["ANNOUNCER"]), "/staff/announcer"],
    [renderFinishLine("Result Taker", true, false, ["RESULT_TAKER"]), "/staff/finish-line"],
    [renderStaffInventory("Duck Manager", "https://quickducks.com", false, ["DUCK_MANAGER"]), "/staff/inventory"],
  ];

  for (const [markup, current] of pages) {
    const nav = staffNav(markup);
    assert.ok(nav, `missing staff nav for ${current}`);
    assert.equal((nav.match(/aria-current="page"/g) ?? []).length, 1, current);
    assert.match(nav, new RegExp(`<a href="${current}" aria-current="page">`), current);
  }

  // The scan page is reachable from any station, so it highlights nothing.
  const scan = staffNav(renderStaffDuck("a".repeat(32), "Registration Staff", false, ["REGISTRATION"]));
  assert.ok(scan);
  assert.doesNotMatch(scan, /aria-current/);
});

test("the staff nav wraps instead of scrolling so 320px viewports never overflow", () => {
  const css = renderStaffHome("Administrator", true, []).match(/<style>([\s\S]+)<\/style>/)?.[1];

  assert.ok(css);
  // Wrapping, not horizontal scrolling: the links reflow instead of overflowing,
  // and each link can break a long label rather than force the nav wider.
  assert.match(css, /\.staff-nav \{[^}]*flex-wrap:wrap;[^}]*max-width:100%;/);
  assert.doesNotMatch(css, /\.staff-nav \{[^}]*overflow-x:auto/);
  assert.match(css, /\.staff-nav a \{[^}]*min-width:0; max-width:100%; min-height:2\.75rem;[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.staff-nav a:hover,\.staff-nav a:focus-visible \{ background:var\(--yellow\); outline:2px solid var\(--ink\); \}/);
  assert.match(css, /\.staff-nav a\[aria-current="page"\] \{ background:var\(--yellow\);/);
  // It follows the console-nav visual language: ink border, cream, chunky shadow.
  assert.match(css, /\.staff-nav \{[^}]*border:2px solid var\(--ink\); border-radius:\.9rem; background:var\(--cream\); box-shadow:3px 3px 0 var\(--ink\);/);
});

test("the access page keeps every hook, field name, and control the access client binds", () => {
  const markup = renderStaffAccess("Administrator");

  // Page shell follows the staff page conventions, including the authorization
  // projection the live hub revalidates against.
  assert.match(markup, /<section class="page-panel operations-panel staff-panel" data-staff-access data-live-staff data-system-admin="true" data-roles="">/);
  assert.match(
    renderStaffAccess("Promoted Admin", true, ["RACE_DIRECTOR"]),
    /data-live-staff data-system-admin="true" data-roles="RACE_DIRECTOR">/,
  );
  assert.match(markup, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(markup, /<form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Log out<\/button><\/form>/);
  assert.match(markup, /<h1 class="page-title operations-title">Staff access<\/h1>/);

  // Exact hooks the client queries.
  for (const hook of [
    "data-staff-access",
    "data-staff-access-form",
    "data-staff-access-message",
    "data-staff-access-list",
    "data-create-role-set",
  ]) {
    assert.ok(markup.includes(hook), `missing access hook ${hook}`);
  }
  assert.match(markup, /<p class="message-line muted" data-staff-access-message aria-live="polite">Loading authorized staff…<\/p>/);
  assert.match(markup, /<div class="staff-access-list" data-staff-access-list><\/div>/);

  // Exact form field names the create command reads.
  assert.match(markup, /<label>Email address<input name="email" type="email" autocomplete="off" maxlength="254" required><\/label>/);
  assert.match(markup, /<label>Display name<input name="displayName" autocomplete="off" maxlength="100" required><\/label>/);
  assert.match(markup, /<select name="role" required><option value="STAFF">Regular staff<\/option><option value="ADMIN">System administrator<\/option><\/select>/);
  for (const role of ["REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR"]) {
    assert.ok(markup.includes(`<input type="checkbox" name="roles" value="${role}">`), `missing role checkbox ${role}`);
  }
  // The retired role is not offerable, and there are exactly six checkboxes.
  assert.equal((markup.match(/<input type="checkbox" name="roles"/g) ?? []).length, 6);
  assert.doesNotMatch(markup, /RETURN_STEWARD|Return steward/);

  // Existing visual language: operations panel, details card, privacy note.
  assert.match(markup, /<details class="operation-card" data-staff-access-create-card><summary>Add staff access<\/summary>/);
  assert.match(markup, /<div class="privacy"><strong>Roles are composable\.<\/strong>/);

  // Composed helper scripts: app-select and the access client, no console client.
  assert.match(markup, /<script src="\/assets\/app-select\.js" defer><\/script>/);
  assert.match(markup, /<script src="\/assets\/staff-access\.js" defer><\/script>/);
  assert.doesNotMatch(markup, /staff-home\.js/);

  // It is event-independent: no event picker, no console sections, and no
  // console client. The Admin menu bar is the one console surface it carries,
  // so an administrator can navigate back out of it.
  const panel = markup.match(/<main class="shell">[\s\S]*<\/main>/)?.[0];
  assert.ok(panel);
  assert.doesNotMatch(panel, /data-event-select|data-operations-root|console-section|data-event-scoped/);
  assert.match(panel, /<nav class="console-nav" aria-label="Admin views">/);
});

test("the access client is standalone, DOM-safe, and subscribes to the staff domain", () => {
  assert.doesNotThrow(() => new Function(staffAccessScript));
  assert.doesNotMatch(staffAccessScript, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(staffAccessScript, /\b(?:window\.)?confirm\s*\(/);
  assert.match(staffAccessScript, /replaceChildren/);
  assert.match(staffAccessScript, /textContent/);

  // The confirmation dialog ships once in `live-ui.js`, which this page loads
  // first, so the access client uses it without redeclaring it.
  assert.doesNotMatch(staffAccessScript, /appConfirmationQueue/);
  assert.match(liveUiScript, /appConfirmationQueue/);
  assert.match(renderStaffAccess("Administrator"), /<script src="\/assets\/live-ui\.js" defer><\/script>/);
  assert.ok(staffAccessScript.includes(
    'if (!await appConfirm("Really " + description + "?", { danger: action === "deactivate" })) return;',
  ));

  // Every profile request the console used to make is preserved unchanged.
  assert.ok(staffAccessScript.includes('await api("/api/v1/staff/profiles");'));
  assert.ok(staffAccessScript.includes('await api("/api/v1/staff/profiles/" + encodeURIComponent(profile.id) + "/" + action, commandOptions("POST", payload));'));
  assert.ok(staffAccessScript.includes('const result = await api("/api/v1/staff/profiles", commandOptions("POST", {'));
  assert.match(staffAccessScript, /Select at least one operational role for regular staff\./);

  // It signs the browser out on 401 like the other protected clients.
  assert.ok(staffAccessScript.includes('if (response.status === 401) {'));
  assert.ok(staffAccessScript.includes('location.assign("/staff");'));

  // Live hub: staff domain only, rooted on the access panel, blocked while busy.
  assert.match(
    staffAccessScript,
    /staffLiveSubscription = globalThis\.quickDucksLive\.subscribe\(\{\s*domains: \["staff"\],\s*root: staffAccess,\s*refresh: \(\) => loadStaffProfiles\(\),\s*isBlocked: \(\) => staffCommandCount > 0,\s*\}\);/,
  );

  // It knows nothing about events, heats, participants, inventory, or purge.
  assert.doesNotMatch(staffAccessScript, /\/api\/v1\/staff\/(?:events|inventory|registrations|support)/);
  assert.doesNotMatch(staffAccessScript, /currentEvent|eventSelect|loadEvents/);
});
