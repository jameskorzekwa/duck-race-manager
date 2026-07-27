import assert from "node:assert/strict";
import test from "node:test";

import { eventLifecycleHelpersScript, inventoryDetailHelpersScript, staffHomeScript } from "./client-scripts.ts";
import {
  renderFinishLine,
  renderInventoryIntake,
  renderStaffDuck,
  renderStaffHome,
  renderStartLine,
} from "./site.ts";

test("staff operations console script is valid, DOM-safe, and covers every operation module", () => {
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.doesNotMatch(staffHomeScript, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(staffHomeScript, /textContent/);
  assert.match(staffHomeScript, /replaceChildren/);
  assert.match(staffHomeScript, /assignedRoles/);
  assert.match(staffHomeScript, /canRunHeat/);
  assert.match(staffHomeScript, /canTakeResults/);
  assert.match(staffHomeScript, /appConfirmationQueue/);
  assert.doesNotMatch(staffHomeScript, /\b(?:window\.)?confirm\s*\(/);
  // Staff account and role management left the console for /staff/access.
  assert.doesNotMatch(staffHomeScript, /staffRoleLabels|roleSetControl|loadStaffProfiles/);
  assert.doesNotMatch(staffHomeScript, /data-staff-access/);

  for (const endpoint of [
    "/api/v1/staff/events",
    "/api/v1/staff/registrations/",
    "/api/v1/staff/inventory/ducks",
    "/heats/round-one/plan-preview",
    "/results/",
    "/api/v1/staff/support/events/",
    "/force-delete",
  ]) {
    assert.ok(staffHomeScript.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  // Returns and the staged purge ceremony are gone; delete event is the only
  // cleanup call the console can make.
  for (const endpoint of [
    "/return-batches",
    "/purge-claim",
    "/purge-gate",
    "/purge-ready",
    "/dispositions",
    "return-review",
  ]) {
    assert.ok(!staffHomeScript.includes(endpoint), `retired endpoint still present: ${endpoint}`);
  }
  assert.doesNotMatch(staffHomeScript, /canReturns|loadReturnReview|loadPurgeGate|reviewEvent/);
  assert.ok(!staffHomeScript.includes("/api/v1/staff/profiles"), "staff profiles moved off the console");
});

test("delete event is an administrator-only danger control with a dialog and typed-name flow", () => {
  const adminMarkup = renderStaffHome("Administrator", true, []);
  const directorMarkup = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);

  assert.match(
    adminMarkup,
    /<details class="operation-card danger-zone" data-force-delete-card hidden><summary>Delete event<\/summary>/,
  );
  assert.match(adminMarkup, /data-force-delete-form/);
  assert.match(adminMarkup, /Type the exact event name to confirm<input name="confirmName"[^>]*required/);
  assert.match(adminMarkup, /in any state\. This cannot be undone\./);
  assert.doesNotMatch(directorMarkup, /data-force-delete-(?:card|form)/);

  assert.ok(staffHomeScript.includes(
    'if (!await appConfirm("Permanently delete this event and every record for it, in any state? This cannot be undone.", { danger: true })) return;',
  ));
  assert.ok(staffHomeScript.includes('const confirmName = String(new FormData(form).get("confirmName"));'));
  assert.ok(staffHomeScript.includes('"/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/force-delete"'));
  assert.ok(staffHomeScript.includes(
    'commandOptions("POST", { commandId: crypto.randomUUID(), revision: currentEvent.revision, confirmName })',
  ));
  const submitPath = staffHomeScript.indexOf('+ "/force-delete"');
  assert.ok(submitPath >= 0);
  assert.ok(staffHomeScript.indexOf('location.assign("/staff")', submitPath) > submitPath);
  assert.ok(staffHomeScript.includes('forceDeleteForm.elements.confirmName.placeholder = currentEvent.name;'));
  assert.ok(staffHomeScript.includes("forceDeleteCard.hidden = false;"));
  assert.doesNotMatch(staffHomeScript, /\b(?:window\.)?confirm\s*\(/);
});

const inventoryDetailController = () => new Function(
  `${inventoryDetailHelpersScript}; return createInventoryDetailController;`,
)();

const inventoryButton = (duckId, connected = true) => ({
  dataset: { duckId },
  isConnected: connected,
  attributes: new Map(),
  focusCount: 0,
  setAttribute(name, value) {
    this.attributes.set(name, value);
  },
  focus() {
    this.focusCount += 1;
  },
});

test("inventory detail controller updates selection, closes cleanly, and returns focus", () => {
  const first = inventoryButton("duck-one");
  const second = inventoryButton("duck-two");
  const list = { querySelectorAll: () => [first, second] };
  const detail = { hidden: true };
  const closeButton = inventoryButton("close");
  let closeHandler = null;
  closeButton.addEventListener = (type, handler) => {
    assert.equal(type, "click");
    closeHandler = handler;
  };
  let clearCount = 0;
  const controller = inventoryDetailController()({
    detail,
    list,
    closeButton,
    clear: () => { clearCount += 1; },
  });

  controller.open("duck-one", first);
  assert.equal(detail.hidden, false);
  assert.equal(first.attributes.get("aria-expanded"), "true");
  assert.equal(second.attributes.get("aria-expanded"), "false");
  assert.equal(closeButton.focusCount, 1);

  controller.open("duck-two", second);
  assert.equal(first.attributes.get("aria-expanded"), "false");
  assert.equal(second.attributes.get("aria-expanded"), "true");
  assert.equal(closeButton.focusCount, 2);

  closeHandler();
  assert.equal(detail.hidden, true);
  assert.equal(clearCount, 1);
  assert.equal(second.attributes.get("aria-expanded"), "false");
  assert.equal(second.focusCount, 1);
});

test("inventory detail controller returns focus to the refreshed card and invalidates closed requests", () => {
  const original = inventoryButton("duck-one", false);
  const replacement = inventoryButton("duck-one");
  let buttons = [original];
  const detail = { hidden: true };
  const closeButton = inventoryButton("close");
  closeButton.addEventListener = () => {};
  const controller = inventoryDetailController()({
    detail,
    list: { querySelectorAll: () => buttons },
    closeButton,
    clear: () => {},
  });

  controller.open("duck-one", original, false);
  const request = controller.beginRequest();
  assert.equal(controller.isCurrentRequest(request), true);
  buttons = [replacement];
  controller.syncButtons();
  controller.close();

  assert.equal(replacement.focusCount, 1);
  assert.equal(controller.isCurrentRequest(request), false);
});

test("inventory cards and detail panel have isolated responsive layout semantics", () => {
  const markup = renderStaffHome("Duck Manager", false, ["DUCK_MANAGER"]);

  assert.match(markup, /<div class="inventory-layout"><div class="data-list inventory-card-grid" data-inventory-list><\/div>\s*<aside class="operation-card inventory-detail-panel"[^>]+role="region"[^>]+aria-labelledby="inventory-detail-title"[^>]+data-inventory-detail hidden>/);
  assert.match(markup, /id="inventory-detail-title" data-inventory-name>Duck detail<\/h3><button[^>]+data-close-inventory-detail>Close<\/button>/);
  assert.match(markup, /\.inventory-layout \{ display:grid; gap:1rem; align-items:start; \}/);
  assert.match(markup, /\.inventory-card-grid \{[^}]*grid-auto-rows:minmax\(3\.75rem,1fr\);[^}]*align-content:start; align-items:stretch;/);
  assert.match(markup, /\.inventory-card-grid \.result-button \{ height:100%; min-height:3\.75rem; \}/);
  assert.match(markup, /@media \(min-width:44rem\)[^{]*\{[^}]*\.cards[^]*\.inventory-layout \{ grid-template-columns:minmax\(0,1\.15fr\) minmax\(20rem,\.85fr\); \}[^]*\.inventory-detail-panel \{ position:sticky;/);
  assert.doesNotMatch(inventoryDetailHelpersScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

const eventSection = (markup) => {
  const match = markup.match(/<section class="console-section" id="events"[^]*?<\/section>/);
  assert.ok(match, "the staff console renders an event section");
  return match[0];
};

const orderedIndexes = (markup, hooks) => hooks.map((hook) => {
  const index = markup.indexOf(hook);
  assert.ok(index >= 0, `missing markup hook ${hook}`);
  return index;
});

test("the event section leads with create event, then the picker, then the selected-event region", () => {
  const adminSection = eventSection(renderStaffHome("Administrator", true, []));
  const directorSection = eventSection(renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]));

  // 1. heading, 2. create event, 3. working-event picker, 4. selected-event detail region.
  const [heading, createCard, picker, refresh, emptyState, detailRegion] = orderedIndexes(adminSection, [
    '<h2 id="events-title">Event</h2>',
    "data-event-create-card",
    "data-event-select",
    "data-refresh-event",
    "data-event-empty",
    "data-event-detail",
  ]);
  assert.ok(heading < createCard, "create event sits directly under the section heading");
  assert.ok(createCard < picker, "the create card is rendered before the working-event select");
  assert.ok(picker < refresh && refresh < emptyState, "the picker and its refresh button follow the create card");
  assert.ok(emptyState < detailRegion, "the no-event guidance precedes the selected-event region");

  // The create card stays a collapsed administrator-only <details> outside the selected-event region.
  assert.match(
    adminSection,
    /<details class="operation-card event-create-card" data-event-create-card><summary>Create event<\/summary>/,
  );
  assert.doesNotMatch(adminSection, /data-event-create-card[^>]*\bopen\b/);
  assert.doesNotMatch(directorSection, /data-event-create-card|data-event-create-form/);

  // The detail region is a labelled region that is hidden until an event is selected.
  for (const section of [adminSection, directorSection]) {
    assert.match(
      section,
      /<div class="event-detail" role="region" aria-labelledby="event-detail-title" data-event-detail hidden>/,
    );
    assert.match(section, /<h3 class="event-detail-title" id="event-detail-title">Selected event details<\/h3>/);
    assert.match(section, /<p class="empty-state" data-event-empty hidden>Create a draft event to begin\.<\/p>/);
  }

  // 5. every selected-event card lives inside that region, in the required order, after the select.
  const region = adminSection.slice(adminSection.indexOf('<div class="event-detail"'));
  const [summary, config, readiness, deleteDraft, forceDelete] = orderedIndexes(region, [
    "data-event-summary",
    "data-event-config-card",
    "data-event-readiness",
    "data-delete-draft-card",
    "data-force-delete-card",
  ]);
  assert.ok(summary < config, "the summary facts open the detail region");
  assert.ok(config < readiness, "configure draft precedes readiness and lifecycle");
  assert.ok(readiness < deleteDraft && deleteDraft < forceDelete, "the danger cards close the detail region");
  assert.ok(!region.includes("data-event-create-card"), "create event stays outside the selected-event region");
  assert.ok(!region.includes("data-event-select"), "the picker stays above the selected-event region");
  assert.ok(region.includes('<div class="console-grid">'), "the detail cards keep the console grid");

  // The non-administrator region keeps only readiness, with its unchanged canRaceRead wording.
  const directorRegion = directorSection.slice(directorSection.indexOf('<div class="event-detail"'));
  assert.match(directorRegion, /<h3>Readiness and lifecycle<\/h3><p class="muted">Every transition is checked again by the server\./);
  const registrationRegion = eventSection(renderStaffHome("Registration Staff", false, ["REGISTRATION"]));
  assert.match(registrationRegion, /Use your assigned station section for operational work\./);
  assert.ok(!directorRegion.includes("data-event-config-card"));
  assert.ok(!directorRegion.includes("data-delete-draft-card"));
});

test("the console script reveals the selected-event region and restores the no-event guidance", () => {
  assert.ok(staffHomeScript.includes('const eventDetailRegion = document.querySelector("[data-event-detail]");'));
  assert.ok(staffHomeScript.includes('const eventEmptyState = document.querySelector("[data-event-empty]");'));
  assert.ok(staffHomeScript.includes('const eventCreateCard = document.querySelector("[data-event-create-card]");'));

  // renderEvent reveals the region alongside the still-working force-delete reveal.
  const populate = staffHomeScript.indexOf("eventConfigForm.elements.name.value");
  const revealForceDelete = staffHomeScript.indexOf("forceDeleteCard.hidden = false;");
  const revealRegion = staffHomeScript.indexOf("if (eventDetailRegion) eventDetailRegion.hidden = false;");
  const hideEmptyState = staffHomeScript.indexOf("if (eventEmptyState) eventEmptyState.hidden = true;");
  assert.ok(populate > 0 && revealForceDelete > populate);
  assert.ok(revealRegion > revealForceDelete, "the detail region is revealed with the delete-event card");
  assert.ok(hideEmptyState > revealForceDelete && hideEmptyState < revealRegion);
  assert.ok(staffHomeScript.indexOf("return true;", revealRegion) > revealRegion);

  // The no-events branch of loadEvents hides the region, shows the guidance, and opens the create card.
  const noEventsBranch = staffHomeScript.indexOf('eventSelect.append(new Option("No event exists", ""));');
  const noEventsMessage = staffHomeScript.indexOf('setMessage("No event dataset exists. An administrator can create one.");');
  const hideRegion = staffHomeScript.indexOf("if (eventDetailRegion) eventDetailRegion.hidden = true;");
  const showEmptyState = staffHomeScript.indexOf("if (eventEmptyState) eventEmptyState.hidden = false;");
  const openCreateCard = staffHomeScript.indexOf("if (eventCreateCard) eventCreateCard.open = true;");
  assert.ok(noEventsBranch > 0 && noEventsMessage > noEventsBranch);
  for (const index of [hideRegion, showEmptyState, openCreateCard]) {
    assert.ok(index > noEventsBranch && index < noEventsMessage, "no-event cleanup stays in the no-events branch");
  }
  // The existing empty-state message and the other no-event resets are unchanged.
  assert.ok(staffHomeScript.includes('eventSummary.replaceChildren(empty("Create a draft event to begin."));'));
  assert.ok(staffHomeScript.includes('readinessList.replaceChildren(empty("No lifecycle is available."));'));
  assert.ok(staffHomeScript.includes("forceDeleteCard.hidden = true;"));
  assert.ok(staffHomeScript.includes("deleteDraftCard.hidden = true;"));
  assert.ok(staffHomeScript.includes('eventConfigCard.hidden = currentEvent.status !== "DRAFT";'));
  assert.ok(staffHomeScript.includes('deleteDraftCard.hidden = currentEvent.status !== "DRAFT";'));
  // Creating an event collapses the primary action again.
  assert.ok(staffHomeScript.includes("if (eventCreateCard) eventCreateCard.open = false;"));
});

test("the selected-event region ships hidden and the generated script toggles it both ways", () => {
  // The server markup hides the region for every console user until an event is selected.
  for (const roles of [[true, []], [false, ["RACE_DIRECTOR"]], [false, ["REGISTRATION"]]]) {
    const section = eventSection(renderStaffHome("Console User", roles[0], roles[1]));
    assert.match(section, /data-event-detail hidden>/);
    assert.match(section, /data-event-empty hidden>/);
  }

  const sliceBetween = (start, end) => {
    const from = staffHomeScript.indexOf(start);
    const to = staffHomeScript.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `cannot slice generated script between ${start} and ${end}`);
    return staffHomeScript.slice(from, to);
  };
  const region = { hidden: true };
  const emptyState = { hidden: true };
  const createCard = { open: false };
  const scoped = [];
  const showEventScopedSections = (exists) => scoped.push(exists);

  // renderEvent's tail reveals the server-hidden region and retires the no-event guidance.
  new Function(
    "eventDetailRegion",
    "eventEmptyState",
    "showEventScopedSections",
    sliceBetween("if (eventEmptyState) eventEmptyState.hidden = true;", "return true;"),
  )(region, emptyState, showEventScopedSections);
  assert.equal(region.hidden, false);
  assert.equal(emptyState.hidden, true);
  assert.deepEqual(scoped, [true], "loading an event reveals the event-scoped sections");

  // The no-events branch hides it again, restores the guidance, and opens the create card.
  new Function(
    "eventDetailRegion",
    "eventEmptyState",
    "eventCreateCard",
    "showEventScopedSections",
    sliceBetween(
      "if (eventDetailRegion) eventDetailRegion.hidden = true;",
      'setMessage("No event dataset exists. An administrator can create one.");',
    ),
  )(region, emptyState, createCard, showEventScopedSections);
  assert.equal(region.hidden, true);
  assert.equal(emptyState.hidden, false);
  assert.equal(createCard.open, true);
  assert.deepEqual(scoped, [true, false], "the no-events branch hides them again");
});

test("the reworked event layout keeps the create card intentional and the detail cards responsive", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const css = markup.match(/<style>([\s\S]+)<\/style>/)?.[1];
  assert.ok(css);

  assert.match(css, /\.event-create-card \{ border-color:var\(--ink\); background:var\(--cream\); box-shadow:3px 3px 0 var\(--ink\); \}/);
  assert.match(css, /\.event-detail \{ min-width:0; max-width:100%; padding:clamp\(\.7rem,2\.5vw,1rem\);/);
  assert.match(css, /\.event-detail > \* \+ \* \{ margin-top:var\(--space-md\); \}/);
  assert.match(css, /\.event-detail > \.compact-facts \{ margin:0; \}/);
  assert.match(css, /\.event-detail-title \{ margin:0;[^}]*overflow-wrap:anywhere; \}/);
  assert.match(css, /\[hidden\] \{ display:none !important; \}/);
  // The selected-event cards keep the shared two-column console grid above 44rem.
  assert.match(css, /@media \(min-width:44rem\)[^{]*\{[^]*\.console-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
});

test("administrator event forms render automatic read-only slug previews", () => {
  const markup = renderStaffHome("Administrator", true, []);

  assert.match(markup, /data-event-create-slug-preview[^>]+readonly/);
  assert.match(markup, /data-event-config-slug-preview[^>]+readonly/);
  assert.match(markup, /Generated automatically when the event is saved/);
  assert.match(markup, /Changes automatically when the event name changes/);
  assert.doesNotMatch(markup, /name="slug"/);
});

test("event rendering only reads config fields that exist so the delete card still reveals", () => {
  const markup = renderStaffHome("Administrator", true, []);
  const configForm = markup.match(/<form data-event-config-form>[^]*?<\/form>/)?.[0];
  assert.ok(configForm, "config form markup is present");

  const fieldNames = new Set(
    [...configForm.matchAll(/(?:name|data-[a-z-]*)="([^"]+)"/g)].map((match) => match[1]),
  );
  // Named form controls the script may address through form.elements.
  const namedControls = new Set([...configForm.matchAll(/name="([^"]+)"/g)].map((match) => match[1]));

  const referenced = [...staffHomeScript.matchAll(/eventConfigForm\.elements\.([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  assert.ok(referenced.length > 0, "the script populates the config form");
  for (const name of referenced) {
    assert.ok(
      namedControls.has(name),
      `eventConfigForm.elements.${name} has no matching named control and would throw during renderEvent`,
    );
  }

  // The removed auto-slug input must not be read, and the read-only preview must remain.
  assert.doesNotMatch(staffHomeScript, /eventConfigForm\.elements\.slug\b/);
  assert.ok(fieldNames.has("roundOneHeatCapacity"));

  // renderEvent must still reveal the administrator force-delete card after populating the form.
  const populateIndex = staffHomeScript.indexOf("eventConfigForm.elements.name.value");
  const revealIndex = staffHomeScript.indexOf("forceDeleteCard.hidden = false");
  assert.ok(populateIndex > 0 && revealIndex > populateIndex,
    "the delete-event card is revealed after the config form is populated");
});

test("event creation requires a hinted ducks-per-heat field wired into the create command", () => {
  const adminMarkup = renderStaffHome("Administrator", true, []);
  const directorMarkup = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);

  assert.match(
    adminMarkup,
    /Ducks per heat<input name="roundOneHeatCapacity" type="number" min="1" max="10000" step="1" required/,
  );
  assert.match(adminMarkup, /How many ducks race together in each round-one heat\./);
  assert.match(adminMarkup, /this can change only while the event is still a draft/);
  const createForm = adminMarkup.match(/<form data-event-create-form>[^]*?<\/form>/)?.[0];
  assert.ok(createForm);
  assert.match(createForm, /name="roundOneHeatCapacity"/);
  assert.doesNotMatch(directorMarkup, /data-event-create-form/);

  // The config form keeps the draft-only editable value with the same field name.
  const configForm = adminMarkup.match(/<form data-event-config-form>[^]*?<\/form>/)?.[0];
  assert.ok(configForm);
  assert.match(configForm, /Ducks per heat<input name="roundOneHeatCapacity"/);

  // The create command now carries the detected timezone alongside the capacity.
  assert.match(
    staffHomeScript,
    /eventDate: String\(values\.get\("eventDate"\)\),\s*timezone: String\(values\.get\("timezone"\)\),\s*roundOneHeatCapacity: Number\(values\.get\("roundOneHeatCapacity"\)\),\s*\}\)\);/,
  );
  assert.ok(staffHomeScript.includes(
    "eventConfigForm.elements.roundOneHeatCapacity.value = currentEvent.roundOneHeatCapacity;",
  ));
});

test("lifecycle controls retain command IDs across response-loss retries and reject stale refreshes", () => {
  const { lifecycleCreateAttempt, lifecycleShouldRenderEvent } = new Function(
    `${eventLifecycleHelpersScript}; return { lifecycleCreateAttempt, lifecycleShouldRenderEvent };`,
  )();
  const commandId = "2c293c36-bca9-4bd0-bc12-a5c9d1ab8370";
  const attempt = lifecycleCreateAttempt(commandId);

  assert.equal(attempt.begin(), commandId);
  assert.equal(attempt.begin(), null);
  assert.equal(attempt.disabled(), true);
  attempt.fail();
  assert.equal(attempt.disabled(), false);
  assert.equal(attempt.begin(), commandId);
  attempt.complete();
  assert.equal(attempt.disabled(), true);
  assert.equal(attempt.begin(), null);

  const current = { id: "event_test", revision: 1 };
  assert.equal(lifecycleShouldRenderEvent("event_test", current, { id: "event_test", revision: 0 }), false);
  assert.equal(lifecycleShouldRenderEvent("event_test", current, { id: "event_test", revision: 1 }), true);
  assert.equal(lifecycleShouldRenderEvent("another_event", current, { id: "event_test", revision: 2 }), false);
  const currentAt = { ...current, updatedAt: "2026-07-26T21:34:28.000Z" };
  assert.equal(lifecycleShouldRenderEvent("event_test", currentAt, {
    id: "event_test", revision: 1, updatedAt: "2026-07-26T21:34:27.000Z",
  }), false);

  const immediateRender = staffHomeScript.indexOf("renderLifecycleResult(result.event);");
  const authoritativeRefresh = staffHomeScript.indexOf("await loadEvents(event.id);", immediateRender);
  assert.ok(immediateRender >= 0);
  assert.ok(authoritativeRefresh > immediateRender);
  assert.match(staffHomeScript, /commandOptions\("POST", \{ commandId \}\)/);
});

test("lifecycle readiness marks achieved transitions done and a moot reopen not needed", () => {
  const { lifecycleReadinessPresentation, lifecycleStatusOrder } = new Function(
    `${eventLifecycleHelpersScript}; return { lifecycleReadinessPresentation, lifecycleStatusOrder };`,
  )();

  // Exactly the six-status lifecycle, in order, with COMPLETED terminal.
  assert.deepEqual(lifecycleStatusOrder, [
    "DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE",
    "FINAL", "COMPLETED",
  ]);

  const transition = (fromStatus, toStatus, allowed) => ({
    fromStatus, toStatus, allowed, requiresAdmin: false, blockers: allowed ? [] : ["A blocker."],
  });
  const forward = {
    "open-registration": transition("DRAFT", "REGISTRATION_OPEN", false),
    "close-registration": transition("REGISTRATION_OPEN", "REGISTRATION_CLOSED", true),
    "start-round-one": transition("REGISTRATION_CLOSED", "ROUND_ONE", false),
    "start-final": transition("ROUND_ONE", "FINAL", false),
    complete: transition("FINAL", "COMPLETED", false),
  };
  const reopen = { ...transition("REGISTRATION_CLOSED", "REGISTRATION_OPEN", false), requiresAdmin: true };

  // REGISTRATION_OPEN: the already-achieved open reads as done, never blocked.
  assert.deepEqual(lifecycleReadinessPresentation(forward["open-registration"], "REGISTRATION_OPEN"), {
    kind: "done", chipText: "Done", chipClass: "status-chip done", upcoming: false,
  });
  // The next transition stays ready or blocked according to server readiness.
  assert.deepEqual(lifecycleReadinessPresentation(forward["close-registration"], "REGISTRATION_OPEN"), {
    kind: "ready", chipText: "Ready", chipClass: "status-chip ready", upcoming: true,
  });
  assert.deepEqual(
    lifecycleReadinessPresentation({ ...forward["close-registration"], allowed: false }, "REGISTRATION_OPEN"),
    { kind: "blocked", chipText: "Blocked", chipClass: "status-chip blocked", upcoming: true },
  );
  // Genuinely upcoming transitions keep the blocked treatment and their reasons.
  for (const action of ["start-round-one", "start-final", "complete"]) {
    assert.deepEqual(lifecycleReadinessPresentation(forward[action], "REGISTRATION_OPEN"), {
      kind: "blocked", chipText: "Blocked", chipClass: "status-chip blocked", upcoming: true,
    }, `${action} must stay blocked while upcoming`);
  }
  // The backward reopen is moot while registration is already open: neutral, not done, not blocked.
  assert.deepEqual(lifecycleReadinessPresentation(reopen, "REGISTRATION_OPEN"), {
    kind: "not-needed", chipText: "Not needed", chipClass: "status-chip", upcoming: false,
  });

  // COMPLETED is terminal: every forward transition has been passed and reads
  // as done, and nothing is left upcoming.
  for (const [action, state] of Object.entries(forward)) {
    assert.deepEqual(lifecycleReadinessPresentation(state, "COMPLETED"), {
      kind: "done", chipText: "Done", chipClass: "status-chip done", upcoming: false,
    }, `${action} must read as done on a completed event`);
  }
  // Reopen keeps genuine blocked semantics when it is unavailable rather than moot.
  assert.equal(lifecycleReadinessPresentation(reopen, "COMPLETED").kind, "blocked");
  assert.equal(lifecycleReadinessPresentation(reopen, "ROUND_ONE").kind, "blocked");
  assert.equal(lifecycleReadinessPresentation({ ...reopen, allowed: true }, "REGISTRATION_CLOSED").kind, "ready");
  assert.equal(lifecycleReadinessPresentation(reopen, "REGISTRATION_CLOSED").kind, "blocked");

  // The console renders the derived chip and hides blockers and action buttons
  // for done and not-needed transitions; upcoming ones keep the existing flow.
  assert.ok(staffHomeScript.includes("const presentation = lifecycleReadinessPresentation(state, event.status);"));
  assert.ok(staffHomeScript.includes('card.append(text("span", presentation.chipText, presentation.chipClass));'));
  assert.ok(staffHomeScript.includes(
    'if (presentation.upcoming && state.requiresAdmin) card.append(text("span", "Administrator", "status-chip"));',
  ));
  assert.ok(staffHomeScript.includes(
    'if (presentation.upcoming) for (const blocker of state.blockers) card.append(text("p", blocker, "muted"));',
  ));
  assert.ok(staffHomeScript.includes("if (presentation.upcoming && canDirectRace && (!state.requiresAdmin || isSystemAdmin)) {"));
  assert.doesNotMatch(staffHomeScript, /state\.allowed \? "Ready" : "Blocked"/);

  // The done chip shares the positive chip styling.
  const markup = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);
  assert.match(markup, /\.status-chip\.ready,\.status-chip\.done \{ background:#d9f5df; \}/);
});

test("every staff page signs out through an accessible POST form without JavaScript", () => {
  const pages = [
    renderStaffHome("Staff Member", false, ["REGISTRATION"]),
    renderStartLine("Staff Member"),
    renderFinishLine("Staff Member"),
    renderInventoryIntake("Staff Member", "https://quickducks.com"),
    renderStaffDuck("tag-token", "Staff Member"),
  ];

  for (const markup of pages) {
    assert.match(markup, /<form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Sign out<\/button><\/form>/);
    assert.doesNotMatch(markup, /<a[^>]+href="\/staff\/logout"/);
    assert.doesNotMatch(markup, /<form class="staff-logout"[^>]+(?:onsubmit|data-)/);
    assert.match(markup, /\.app-confirmation::backdrop/);
    assert.match(markup, /\.app-confirmation\.fallback/);
  }
});

test("registration desk has no advance duck disposition controls", () => {
  const markup = renderStaffHome("Registration Staff", false, ["REGISTRATION"]);
  assert.doesNotMatch(markup, /duckKeepPreference|Duck preference|Undecided/);
  assert.doesNotMatch(staffHomeScript, /duckKeepPreference|duck_keep_preference/);
});
