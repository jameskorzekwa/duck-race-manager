import assert from "node:assert/strict";
import test from "node:test";

import { staffAccessScript, staffHomeScript } from "./client-scripts.ts";
import {
  renderFinishLine,
  renderInventoryIntake,
  renderStaffAccess,
  renderStaffDuck,
  renderStaffHome,
  renderStartLine,
} from "./site.ts";

const eventScopedIds = ["participants", "inventory", "heats", "support"];

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
  return (elements, noRaceState) => new Function(
    "eventScopedElements",
    "noRaceState",
    `${source} return showEventScopedSections;`,
  )(elements, noRaceState);
};

const scopedElement = (roleAllowed) => ({ hidden: true, dataset: roleAllowed === undefined ? {} : { roleAllowed } });

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
    // The Event section is never event-scoped: it is the section that creates one.
    const events = sectionTag(markup, "events");
    assert.ok(events);
    assert.doesNotMatch(events, /data-event-scoped/, `${label}: the event section is always available`);
    assert.doesNotMatch(events, /hidden/, `${label}: the event section is not hidden`);
  }

  // A console user with no roles at all still gets no console script and a hidden event section.
  const noRoles = renderStaffHome("No Role", false, []);
  assert.match(sectionTag(noRoles, "events"), / hidden>$/);
  assert.doesNotMatch(noRoles, /src="\/assets\/staff-home\.js"/);
});

test("role gating is recorded on each event-scoped section and survives event existence", () => {
  const registration = renderStaffHome("Registration Staff", false, ["REGISTRATION"]);
  const announcer = renderStaffHome("Announcer", false, ["ANNOUNCER"]);

  assert.match(sectionTag(registration, "participants"), /data-role-allowed="true"/);
  assert.match(sectionTag(registration, "inventory"), /data-role-allowed="false"/);
  assert.match(sectionTag(registration, "heats"), /data-role-allowed="false"/);

  assert.match(sectionTag(announcer, "heats"), /data-role-allowed="true"/);
  assert.match(sectionTag(announcer, "participants"), /data-role-allowed="false"/);
  assert.match(sectionTag(announcer, "inventory"), /data-role-allowed="false"/);

  // The Returns section is gone from every console, for every role.
  for (const markup of [registration, announcer]) assert.equal(sectionTag(markup, "returns"), null);

  // A race director may use every event-scoped section except administrator support.
  const director = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);
  for (const id of ["participants", "inventory", "heats"]) {
    assert.match(sectionTag(director, id), /data-role-allowed="true"/, id);
  }
  assert.equal(sectionTag(director, "support"), null);
});

test("console-nav anchors are event-scoped, ship hidden, and stay role filtered", () => {
  const admin = consoleNav(renderStaffHome("Administrator", true, []));
  assert.deepEqual(navHrefs(admin), ["#events", "#participants", "#inventory", "#heats", "#support"]);
  // Access left the console nav for its own page.
  assert.doesNotMatch(admin, /#access/);
  for (const anchor of admin.matchAll(/<a href="#([a-z]+)"([^>]*)>/g)) {
    if (anchor[1] === "events") {
      assert.equal(anchor[2], "", "the event anchor is always visible");
      continue;
    }
    assert.equal(anchor[2], ' data-event-scoped hidden', `#${anchor[1]} must ship hidden and event-scoped`);
  }

  // Role filtering still removes anchors entirely for roles that cannot use them.
  assert.deepEqual(navHrefs(consoleNav(renderStaffHome("Announcer", false, ["ANNOUNCER"]))), ["#events", "#heats"]);
  // An account with no operational roles gets no console anchor at all.
  assert.deepEqual(navHrefs(consoleNav(renderStaffHome("Roleless Staff", false, []))), []);
  assert.deepEqual(
    navHrefs(consoleNav(renderStaffHome("Registration Staff", false, ["REGISTRATION"]))),
    ["#events", "#participants"],
  );
  assert.deepEqual(navHrefs(consoleNav(renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]))), ["#events", "#inventory"]);
});

test("the console renders a hidden No race yet state that the no-events branch reveals", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const eventsSection = markup.match(/<section class="console-section" id="events"[^]*?<\/section>/)?.[0];

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
  const showEventScopedSections = build([allowedSection, deniedSection, navAnchor], noRaceState);

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
  const cases = [
    [renderStaffHome("Administrator", true, []), ["/staff", "/staff/access", "/staff/start-line", "/staff/finish-line", "/staff/inventory-intake"]],
    [renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]), ["/staff", "/staff/start-line", "/staff/finish-line", "/staff/inventory-intake"]],
    [renderStaffHome("Heat Runner", false, ["HEAT_RUNNER"]), ["/staff", "/staff/start-line"]],
    [renderStaffHome("Result Taker", false, ["RESULT_TAKER"]), ["/staff", "/staff/finish-line"]],
    [renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]), ["/staff", "/staff/inventory-intake"]],
    [renderStaffHome("Announcer", false, ["ANNOUNCER"]), ["/staff"]],
    [renderStaffHome("Registration Staff", false, ["REGISTRATION"]), ["/staff"]],
    [renderStaffHome("No Role", false, []), ["/staff"]],
    [renderStaffHome("Mixed Staff", false, ["RESULT_TAKER", "DUCK_MANAGER"]), ["/staff", "/staff/finish-line", "/staff/inventory-intake"]],
    [renderStaffAccess("Administrator"), ["/staff", "/staff/access", "/staff/start-line", "/staff/finish-line", "/staff/inventory-intake"]],
  ];

  for (const [markup, expected] of cases) {
    const nav = staffNav(markup);
    assert.ok(nav, "every staff page renders the staff nav");
    assert.deepEqual(navHrefs(nav), expected);
    assert.match(nav, /aria-label="Staff pages"/);
  }

  // Only an administrator ever sees the access link.
  for (const role of ["RACE_DIRECTOR", "REGISTRATION", "DUCK_MANAGER", "ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER"]) {
    assert.doesNotMatch(staffNav(renderStaffHome("Staff", false, [role])), /\/staff\/access/, role);
  }
});

test("the staff nav is on every operational staff page and marks the current one", () => {
  const pages = [
    [renderStaffHome("Administrator", true, []), "/staff"],
    [renderStaffAccess("Administrator"), "/staff/access"],
    [renderStartLine("Heat Runner", true, false, ["HEAT_RUNNER"]), "/staff/start-line"],
    [renderFinishLine("Result Taker", true, false, ["RESULT_TAKER"]), "/staff/finish-line"],
    [renderInventoryIntake("Duck Manager", "https://quickducks.com", false, ["DUCK_MANAGER"]), "/staff/inventory-intake"],
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
  assert.match(markup, /<section class="page-panel operations-panel" data-staff-access data-live-staff data-system-admin="true" data-roles="">/);
  assert.match(
    renderStaffAccess("Promoted Admin", true, ["RACE_DIRECTOR"]),
    /data-live-staff data-system-admin="true" data-roles="RACE_DIRECTOR">/,
  );
  assert.match(markup, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(markup, /<form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Sign out<\/button><\/form>/);
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

  // It is event-independent: no event picker, console sections, or console nav.
  const panel = markup.match(/<main class="shell">[\s\S]*<\/main>/)?.[0];
  assert.ok(panel);
  assert.doesNotMatch(panel, /data-event-select|data-operations-root|console-section|console-nav|data-event-scoped/);
});

test("the access client is standalone, DOM-safe, and subscribes to the staff domain", () => {
  assert.doesNotThrow(() => new Function(staffAccessScript));
  assert.doesNotMatch(staffAccessScript, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(staffAccessScript, /\b(?:window\.)?confirm\s*\(/);
  assert.match(staffAccessScript, /replaceChildren/);
  assert.match(staffAccessScript, /textContent/);

  // The confirmation dialog is composed in, like the other staff clients.
  assert.match(staffAccessScript, /appConfirmationQueue/);
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
