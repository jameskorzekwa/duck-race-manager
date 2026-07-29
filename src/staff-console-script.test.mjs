import assert from "node:assert/strict";
import test from "node:test";

import {
  eventLifecycleHelpersScript,
  inventoryDetailHelpersScript,
  liveUiScript,
  staffHomeScript,
} from "./client-scripts.ts";
import {
  renderFinishLine,
  renderStaffInventory,
  renderStaffDuck,
  renderStaffHome,
  renderStaffRegistration,
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
  // The shared confirmation dialog now ships once in `live-ui.js`, which every
  // page loads first, so the console uses `appConfirm` without redeclaring it.
  assert.doesNotMatch(staffHomeScript, /appConfirmationQueue/);
  assert.match(liveUiScript, /appConfirmationQueue/);
  assert.match(staffHomeScript, /await appConfirm\(/);
  assert.match(renderStaffHome("Administrator", true, []), /<script src="\/assets\/live-ui\.js" defer><\/script>/);
  assert.doesNotMatch(staffHomeScript, /\b(?:window\.)?confirm\s*\(/);
  // Staff account and role management left the console for /staff/access.
  assert.doesNotMatch(staffHomeScript, /staffRoleLabels|roleSetControl|loadStaffProfiles/);
  assert.doesNotMatch(staffHomeScript, /data-staff-access/);

  for (const endpoint of [
    "/api/v1/staff/events",
    "/api/v1/staff/registrations/",
    "/results/",
    "/api/v1/staff/support/events/",
    "/force-delete",
  ]) {
    assert.ok(staffHomeScript.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  // Returns and the staged purge ceremony are gone; delete event is the only
  // cleanup call the console can make.
  // The retired post-close balanced planner has no console surface left.
  assert.doesNotMatch(staffHomeScript, /plan-preview|plan-commit|balanced|pendingHeatPlan/i);
  // The announcer roster refetch button was a visible no-op and is gone, while
  // the endpoint itself stays for the dedicated announcer surface.
  assert.doesNotMatch(staffHomeScript, /announcer-roster|Load announcer roster/);
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
    /<article class="operation-card danger-zone" data-force-delete-card hidden>[\s\S]*<button class="button danger" type="button" data-open-force-delete>Delete event<\/button>/,
  );
  assert.match(adminMarkup, /<dialog class="app-confirmation event-delete-dialog" data-force-delete-dialog/);
  assert.match(adminMarkup, /data-force-delete-form/);
  assert.match(adminMarkup, /Type <strong data-force-delete-event-name><\/strong> to confirm<input name="confirmName"[^>]*required/);
  assert.match(adminMarkup, /This cannot be undone\./);
  assert.match(adminMarkup, /data-cancel-force-delete>Cancel<\/button><button class="button danger" type="submit" disabled>Delete event<\/button>/);
  assert.doesNotMatch(adminMarkup, /<details[^>]*data-force-delete-card/);
  assert.doesNotMatch(directorMarkup, /data-(?:open-)?force-delete|data-cancel-force-delete/);

  assert.ok(staffHomeScript.includes("forceDeleteDialog.showModal();"));
  assert.ok(staffHomeScript.includes('input.value !== currentEvent.name;'));
  assert.ok(staffHomeScript.includes('input.setCustomValidity("Type the exact event name to continue.");'));
  assert.ok(staffHomeScript.includes("if (forceDeleteBusy) event.preventDefault();"));
  assert.ok(staffHomeScript.includes("forceDeleteCancel.disabled = true;"));
  assert.ok(staffHomeScript.includes("globalThis.quickDucksLive.markClean(forceDeleteForm);"));
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

test("participant deletion is a confirmed danger action that clears the detail pane", () => {
  // The action ships with the participant detail, which is already gated to the
  // registration and race-director roles server side and in the console markup.
  assert.ok(staffHomeScript.includes(
    'addParticipantAction("Delete registration", "button danger small", (event) => deleteParticipant(event.currentTarget));',
  ));
  assert.ok(staffHomeScript.includes(
    'if (!await appConfirm("Permanently delete the registration for " + registration.firstName + " " + registration.lastName + "? This removes the participant and their race entry. This cannot be undone.", { danger: true })) return;',
  ));
  assert.ok(staffHomeScript.includes(
    'commandOptions("DELETE", { commandId: crypto.randomUUID(), expectedRevision: registration.revision })',
  ));
  const submitPath = staffHomeScript.indexOf('commandOptions("DELETE", { commandId: crypto.randomUUID(), expectedRevision: registration.revision })');
  assert.ok(submitPath >= 0);
  // The removed participant is cleared from the console before the list reloads,
  // so no stale detail can be acted on again.
  assert.ok(staffHomeScript.indexOf("clearParticipantDetail();", submitPath) > submitPath);
  assert.ok(staffHomeScript.indexOf("await loadParticipants();", submitPath) > submitPath);
  assert.ok(staffHomeScript.includes("selectedRegistration = null;\n  participantDetail.hidden = true;"));
  // The console is not the authority on the unassign-first rule; it surfaces the
  // server's actionable refusal through the shared message line.
  assert.doesNotMatch(staffHomeScript, /Unassign the duck from inventory first/);
});

// The projection carries two booleans that answer two different questions, and
// the shipped script has to ask each one where it belongs. Reading `assignment`
// for the Delete control was a real defect: a participant whose duck had been
// unassigned is not currently paired, is still not deletable, and was offered a
// button whose command the server refuses with 409.
test("the Delete control is gated on deletable and the bag wording on currentlyPaired", () => {
  // `deletable` is taken exactly as sent, and an absent field is not deletable.
  assert.ok(staffHomeScript.includes(
    "const participantIsDeletable = (registration) => registration.deletable === true;",
  ));
  // The pairing question prefers the explicit boolean and falls back only to
  // the assignment object it is defined to equal.
  assert.match(
    staffHomeScript,
    /const participantIsCurrentlyPaired = \(registration\) => registration\.currentlyPaired === true\s*\|\| \(registration\.currentlyPaired === undefined/,
  );

  // The deletable predicate is read once, and the two halves it decides are
  // written as one boolean and its negation, so no future edit can leave Delete
  // and the explanation both showing, or both missing.
  assert.ok(staffHomeScript.includes("const deletable = participantIsDeletable(registration);"));
  assert.ok(staffHomeScript.includes(
    'if (deletable) {\n    addParticipantAction("Delete registration", "button danger small", (event) => deleteParticipant(event.currentTarget));',
  ));
  assert.ok(staffHomeScript.includes(
    'if (!deletable) {\n    const note = text("p", participantUndeletableReason(registration), "muted participant-action-note");',
  ));

  // Withdrawal is not inside either half. It is a question about being in the
  // race, and the server accepts it for a never-paired no-show too, so hiding
  // it behind undeletability left Delete as the only way to record one.
  const render = staffHomeScript.match(/const renderParticipantDetail = \(registration\) => \{[\s\S]*?\n\};/);
  assert.ok(render, "the console defines renderParticipantDetail");
  const withdrawIndex = render[0].indexOf('addParticipantAction("Withdraw"');
  const deleteHalfIndex = render[0].indexOf("if (deletable) {");
  const noteHalfIndex = render[0].indexOf("if (!deletable) {");
  assert.ok(withdrawIndex > 0, "the console offers Withdraw");
  assert.ok(
    withdrawIndex > noteHalfIndex && withdrawIndex < deleteHalfIndex,
    "Withdraw sits between the two deletable halves rather than inside either one",
  );
  assert.match(
    render[0].slice(withdrawIndex - 200, withdrawIndex),
    /if \(\["SUBMITTED", "ACTIVE"\]\.includes\(registration\.status\)\) \{\n\s*$/,
    "Withdraw is gated only on the statuses the endpoint accepts",
  );

  // The renderer itself no longer touches `assignment`: every read of it is
  // inside the two small helpers that exist to guard it, so a projection with
  // an assignment shape this console does not expect cannot throw part-way
  // through the render and silently drop every control below it.
  assert.doesNotMatch(render[0], /registration\.assignment/);

  // The sealed-bag sentence is reachable only when this participant holds a
  // duck AND a heat is holding it, so it can never claim a bag that does not
  // exist. The race-status branch comes first and says nothing about ducks at
  // all, and the history branch names no bag of its own.
  const reason = staffHomeScript.match(/const participantUndeletableReason = \(registration\) => \{[\s\S]*?\n\};/);
  assert.ok(reason, "the console defines participantUndeletableReason");
  const sealedIndex = reason[0].indexOf("is already sealed in a heat bag");
  const pendingIndex = reason[0].indexOf("has no heat yet");
  const eventIndex = reason[0].indexOf("participantEventBlocksDeletion()");
  assert.ok(eventIndex > 0 && eventIndex < pendingIndex && pendingIndex < sealedIndex,
    "the race-status branch is tested first, then the no-heat case, then the sealed bag");
  assert.match(
    reason[0].slice(0, sealedIndex),
    /if \(participantIsCurrentlyPaired\(registration\)\) \{\s*return duckLabel \+ " $/,
    "the sealed-bag sentence is guarded by the pairing question",
  );
  assert.match(
    reason[0].slice(0, pendingIndex),
    /if \(participantIsCurrentlyPaired\(registration\) && registration\.heatAssignmentPending === true\) \{\s*return duckLabel \+ " is paired with this participant but $/,
    "the no-bag sentence is guarded by the projection's own heat answer",
  );
  const [, historyBranch] = reason[0].split('return "This participant has already been in the race');
  assert.ok(historyBranch !== undefined, "the history reason exists");
  assert.doesNotMatch(historyBranch, /sealed in a heat bag/);
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
  const markup = renderStaffInventory("Duck Manager", "https://quickducks.com", false, ["DUCK_MANAGER"]);

  assert.match(markup, /<div class="inventory-layout"><div class="data-list inventory-card-grid" data-inventory-list><\/div>\s*<aside class="operation-card inventory-detail-panel"[^>]+role="region"[^>]+aria-labelledby="inventory-detail-title"[^>]+data-inventory-detail hidden>/);
  assert.match(markup, /id="inventory-detail-title" data-inventory-name>Duck detail<\/h3><button[^>]+data-close-inventory-detail>Close<\/button>/);
  assert.match(markup, /\.inventory-layout \{ display:grid; gap:1rem; align-items:start; \}/);
  assert.match(markup, /\.inventory-card-grid \{[^}]*grid-auto-rows:minmax\(3\.75rem,1fr\);[^}]*align-content:start; align-items:stretch;/);
  assert.match(markup, /\.inventory-card-grid \.result-button \{ height:100%; min-height:3\.75rem; \}/);
  assert.match(markup, /@media \(min-width:44rem\)[^{]*\{[^}]*\.cards[^]*\.inventory-layout \{ grid-template-columns:minmax\(0,1\.15fr\) minmax\(20rem,\.85fr\); \}[^]*\.inventory-detail-panel \{ position:sticky;/);
  assert.doesNotMatch(inventoryDetailHelpersScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

const eventSection = (markup) => {
  const match = markup.match(/<section class="console-section" id="event"[^]*?<\/section>/);
  assert.ok(match, "the staff console renders an Event Details view");
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
    '<h2 id="event-title">Event Details</h2>',
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

  // The create card stays a collapsed administrator-only <details> outside the
  // selected-event region, and it ships hidden: one event dataset exists at a
  // time, so it is revealed only while there is no event at all.
  assert.match(
    adminSection,
    /<details class="operation-card event-create-card" data-event-create-card hidden><summary>Create event<\/summary>/,
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
  const [summary, config, readiness, forceDelete] = orderedIndexes(region, [
    "data-event-summary",
    "data-event-config-card",
    "data-event-readiness",
    "data-force-delete-card",
  ]);
  assert.ok(summary < config, "the summary facts open the detail region");
  assert.ok(config < readiness, "configure draft precedes readiness and lifecycle");
  assert.ok(readiness < forceDelete, "the delete-event card closes the detail region");
  assert.doesNotMatch(region, /data-delete-draft|Delete empty draft/);
  assert.ok(!region.includes("data-event-create-card"), "create event stays outside the selected-event region");
  assert.ok(!region.includes("data-event-select"), "the picker stays above the selected-event region");
  assert.ok(region.includes('<div class="console-grid">'), "the detail cards keep the console grid");

  // The non-administrator region keeps only readiness, with its unchanged canRaceRead wording.
  const directorRegion = directorSection.slice(directorSection.indexOf('<div class="event-detail"'));
  assert.match(directorRegion, /<h3>Readiness and lifecycle<\/h3><p class="muted">Every transition is checked again by the server\./);
  const registrationRegion = eventSection(renderStaffHome("Registration Staff", false, ["REGISTRATION"]));
  assert.match(registrationRegion, /Use your assigned station section for operational work\./);
  assert.ok(!directorRegion.includes("data-event-config-card"));
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
  const openCreateCard = staffHomeScript.indexOf("      eventCreateCard.open = true;");
  assert.ok(noEventsBranch > 0 && noEventsMessage > noEventsBranch);
  for (const index of [hideRegion, showEmptyState, openCreateCard]) {
    assert.ok(index > noEventsBranch && index < noEventsMessage, "no-event cleanup stays in the no-events branch");
  }
  // The existing empty-state message and the other no-event resets are unchanged.
  assert.ok(staffHomeScript.includes('eventSummary.replaceChildren(empty("Create a draft event to begin."));'));
  assert.ok(staffHomeScript.includes('readinessList.replaceChildren(empty("No lifecycle is available."));'));
  assert.ok(staffHomeScript.includes("forceDeleteCard.hidden = true;"));
  assert.ok(staffHomeScript.includes('eventConfigCard.hidden = currentEvent.status !== "DRAFT";'));
  // Creating an event collapses and removes the primary action again, and the
  // handler refuses a submission once an event exists so the card can never be
  // hidden but still submittable.
  assert.ok(staffHomeScript.includes("      eventCreateCard.open = false;\n      eventCreateCard.hidden = true;"));
  assert.ok(staffHomeScript.includes('    setMessage("An event already exists. Delete it before creating another.", true);'));
});

// One event dataset exists at a time, so a second create is refused anyway. The
// card is therefore absent from the page whenever an event exists, and comes
// back — without a reload — the moment the event is deleted.
test("the create-event card is revealed only while no event exists", () => {
  const markup = renderStaffHome("Administrator", true, []);
  assert.match(markup, /data-event-create-card hidden>/);

  const sliceBetween = (start, end) => {
    const from = staffHomeScript.indexOf(start);
    const to = staffHomeScript.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `cannot slice generated script between ${start} and ${end}`);
    return staffHomeScript.slice(from, to);
  };

  // renderEvent removes it, exactly like the no-race and empty-state markers.
  const shown = { hidden: false, open: true };
  new Function(
    "eventCreateCard",
    "eventDetailRegion",
    "eventEmptyState",
    "showEventScopedSections",
    sliceBetween("  if (eventCreateCard) {", "return true;"),
  )(shown, { hidden: true }, { hidden: false }, () => undefined);
  assert.equal(shown.hidden, true, "an existing event removes the create card");
  assert.equal(shown.open, false, "and closes it so nothing inside stays reachable");

  // The no-events branch — which delete-event also reaches — brings it back.
  const removed = { hidden: true, open: false };
  new Function(
    "eventCreateCard",
    "eventDetailRegion",
    "eventEmptyState",
    "clearBagMoves",
    "showEventScopedSections",
    sliceBetween(
      "if (eventDetailRegion) eventDetailRegion.hidden = true;",
      'setMessage("No event dataset exists. An administrator can create one.");',
    ),
  )(removed, { hidden: false }, { hidden: true }, () => undefined, () => undefined);
  assert.equal(removed.hidden, false, "deleting the event brings the create card back");
  assert.equal(removed.open, true);
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
  const createCard = { open: false, hidden: false };
  const scoped = [];
  const cleared = [];
  const showEventScopedSections = (exists) => scoped.push(exists);

  // renderEvent's tail reveals the server-hidden region and retires the no-event guidance.
  new Function(
    "eventDetailRegion",
    "eventEmptyState",
    "showEventScopedSections",
    sliceBetween("  if (eventEmptyState) eventEmptyState.hidden = true;", "return true;"),
  )(region, emptyState, showEventScopedSections);
  assert.equal(region.hidden, false);
  assert.equal(emptyState.hidden, true);
  assert.deepEqual(scoped, [true], "loading an event reveals the event-scoped sections");

  // The no-events branch hides it again, restores the guidance, and opens the create card.
  new Function(
    "eventDetailRegion",
    "eventEmptyState",
    "eventCreateCard",
    "clearBagMoves",
    "showEventScopedSections",
    sliceBetween(
      "if (eventDetailRegion) eventDetailRegion.hidden = true;",
      'setMessage("No event dataset exists. An administrator can create one.");',
    ),
  )(region, emptyState, createCard, () => cleared.push(true), showEventScopedSections);
  assert.equal(region.hidden, true);
  assert.equal(emptyState.hidden, false);
  assert.equal(createCard.open, true);
  assert.deepEqual(scoped, [true, false], "the no-events branch hides them again");
  // Deleting the event removes every heat, so any queued heat-bag move it named
  // is meaningless and the queue goes with it.
  assert.deepEqual(cleared, [true], "the no-events branch clears queued bag moves");
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

// A stale `form.elements.X` write throws, and a throw silently kills every
// section after it. The console client now runs on two pages, so every named
// control it addresses has to exist on each page that actually renders that
// form — and each form the client only conditionally binds must be genuinely
// optional, so its absence cannot reach an `.elements` read at all.
test("every form field the console client writes exists on every page that loads it", () => {
  const pages = {
    "/staff": renderStaffHome("Administrator", true, []),
    "/staff/registration": renderStaffRegistration("Registration Staff", false, ["REGISTRATION"]),
  };
  // Each console variable, the markup hook its form is found by, and whether
  // the client guards the form's absence before reading `.elements` from it.
  const forms = [
    ["eventConfigForm", "data-event-config-form", true],
    ["eventCreateForm", "data-event-create-form", true],
    ["forceDeleteForm", "data-force-delete-form", true],
    ["participantEditForm", "data-participant-edit-form", false],
    ["participantDuckNameForm", "data-participant-duck-name-form", true],
  ];

  for (const [variable, hook, optional] of forms) {
    const referenced = [...staffHomeScript.matchAll(new RegExp(`${variable}\\.elements\\.([A-Za-z_$][\\w$]*)`, "g"))]
      .map((match) => match[1]);
    assert.ok(referenced.length > 0, `${variable} is never read, so this list is stale`);
    assert.ok(
      staffHomeScript.includes(`const ${variable} = document.querySelector("[${hook}]");`),
      `${variable} must be resolved from [${hook}]`,
    );
    if (optional) {
      assert.ok(
        staffHomeScript.includes(`if (${variable}) `) || staffHomeScript.includes(`if (!${variable})`),
        `${variable} is not on every page, so the client must guard its absence`,
      );
    }

    for (const [path, markup] of Object.entries(pages)) {
      const form = markup.match(new RegExp(`<form ${hook}[^>]*>[^]*?</form>`))?.[0];
      if (form === undefined) {
        assert.ok(optional, `${path} must render ${hook}, which the client reads unguarded`);
        continue;
      }
      const namedControls = new Set([...form.matchAll(/name="([^"]+)"/g)].map((match) => match[1]));
      for (const name of referenced) {
        assert.ok(
          namedControls.has(name),
          `${path}: ${variable}.elements.${name} has no matching named control and would throw`,
        );
      }
    }
  }

  // The two pages both carry the whole participants surface, so its hooks are
  // never partially present.
  for (const [path, markup] of Object.entries(pages)) {
    for (const hook of [
      "data-operations-root",
      "data-event-select",
      "data-console-message",
      "data-participant-filter-form",
      "data-walkup-form",
      "data-walkup-result",
      "data-participant-list",
      "data-participant-detail",
      "data-participant-name",
      "data-participant-facts",
      "data-participant-actions",
      "data-no-race",
    ]) {
      assert.ok(markup.includes(hook), `${path} must render ${hook}`);
    }
  }

  // Every element query the client makes without an optional-chain guard has to
  // be a heading it writes into inside a surface it has already proved is
  // present — an optional chain cannot carry an assignment, so these two are
  // reached only from code paths that checked their own surface first.
  const unguarded = [...new Set(
    [...staffHomeScript.matchAll(/document\.querySelector\("\[(data-[a-z-]+)\]"\)\.(?!\s)/g)]
      .map((match) => match[1]),
  )].sort();
  assert.deepEqual(
    unguarded,
    ["data-heat-name", "data-participant-name"],
    "every other direct query must be optional-chained",
  );
  for (const [surface, heading] of [["participantsPresent", "data-participant-name"], ["heatList", "data-heat-name"]]) {
    const write = staffHomeScript.indexOf(`document.querySelector("[${heading}]").textContent`);
    assert.ok(write > 0, heading);
    assert.ok(staffHomeScript.includes(`!${surface}`) || staffHomeScript.includes(`|| !${surface}`), surface);
  }
});

test("event creation requires a hinted ducks-per-heat field wired into the create command", () => {
  const adminMarkup = renderStaffHome("Administrator", true, []);
  const directorMarkup = renderStaffHome("Race Director", false, ["RACE_DIRECTOR"]);

  assert.match(
    adminMarkup,
    /Ducks per heat<input name="roundOneHeatCapacity" type="number" min="3" max="10000" step="1" required/,
  );
  assert.match(adminMarkup, /How many ducks race together in each round-one heat, at least 3\./);
  assert.match(adminMarkup, /this can change only while the event is still a draft/);
  const createForm = adminMarkup.match(/<form data-event-create-form>[^]*?<\/form>/)?.[0];
  assert.ok(createForm);
  assert.match(createForm, /name="roundOneHeatCapacity"/);
  assert.doesNotMatch(directorMarkup, /data-event-create-form/);

  // The config form keeps the draft-only editable value with the same field name.
  const configForm = adminMarkup.match(/<form data-event-config-form>[^]*?<\/form>/)?.[0];
  assert.ok(configForm);
  assert.match(configForm, /Ducks per heat<input name="roundOneHeatCapacity" type="number" min="3"/);
  // Heat assignment has one mode now, so the console offers no mode selector.
  assert.doesNotMatch(configForm, /heatAssignmentMode/);

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
    renderStaffInventory("Staff Member", "https://quickducks.com"),
    renderStaffDuck("tag-token", "Staff Member"),
  ];

  for (const markup of pages) {
    assert.match(markup, /<form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Log out<\/button><\/form>/);
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

// The live hub admits a bounded number of connections and fans every signal out
// to every subscriber that names a matching domain, so a page that subscribes to
// a domain it cannot repaint spends a refresh — and, per registration device, a
// held Durable Object connection — on nothing. This one client runs on two very
// different pages, so the domains have to be decided from what is on the page.
test("the console subscribes only to the live domains the page it is on renders", () => {
  const source = staffHomeScript.match(
    /const staffLiveDomains = \["event", "staff"\];[\s\S]*?staffLiveDomains\.push\("support"\);\n/,
  );
  assert.ok(source, "the console script decides its live domains from the page");
  const domainsFor = (context) => new Function(
    ...Object.keys(context),
    `${source[0]}\nreturn staffLiveDomains;`,
  )(...Object.values(context));

  // The Admin console renders every surface, so it keeps every domain.
  assert.deepEqual(
    domainsFor({
      canRegistration: true,
      participantList: {},
      canRaceRead: true,
      heatList: {},
      finalistCard: {},
      isSystemAdmin: true,
      supportSummary: {},
      notificationList: {},
      auditList: {},
    }),
    ["event", "staff", "participants", "ducks", "heats", "support"],
  );

  // The registration desk renders participants and nothing else.
  assert.deepEqual(
    domainsFor({
      canRegistration: true,
      participantList: {},
      canRaceRead: false,
      heatList: null,
      finalistCard: null,
      isSystemAdmin: false,
      supportSummary: null,
      notificationList: null,
      auditList: null,
    }),
    ["event", "staff", "participants", "ducks"],
  );

  // A race director's console has the heats but not the administrator support
  // surfaces, and the subscription follows that exactly.
  assert.deepEqual(
    domainsFor({
      canRegistration: true,
      participantList: {},
      canRaceRead: true,
      heatList: {},
      finalistCard: {},
      isSystemAdmin: false,
      supportSummary: null,
      notificationList: null,
      auditList: null,
    }),
    ["event", "staff", "participants", "ducks", "heats"],
  );

  // The fourth shape: race-read without the registration desk. It is
  // unreachable today — canOpenAdminConsole admits only administrators and
  // RACE_DIRECTOR, and canRegistration already includes RACE_DIRECTOR — but it
  // is one role grant away, and such a console still renders the readiness
  // panel, which reports duck facts that only the "ducks" domain wakes. It
  // therefore keeps "ducks" and drops "participants", which it cannot repaint.
  assert.deepEqual(
    domainsFor({
      canRegistration: false,
      participantList: null,
      canRaceRead: true,
      heatList: {},
      finalistCard: {},
      isSystemAdmin: false,
      supportSummary: null,
      notificationList: null,
      auditList: null,
    }),
    ["event", "staff", "ducks", "heats"],
  );

  // The gating is real, not theoretical: these are the hooks each page actually
  // renders, so the registration desk genuinely has no heat or support surface a
  // signal on those domains could repaint.
  const desk = renderStaffRegistration("Registration Staff", false, ["REGISTRATION"]);
  const console_ = renderStaffHome("Administrator", true, []);
  assert.ok(desk.includes("data-participant-list"));
  for (const hook of [
    "data-heat-list",
    "data-finalist-card",
    "data-support-summary",
    "data-notification-list",
    "data-audit-list",
  ]) {
    assert.ok(!desk.includes(hook), `the registration desk must not render ${hook}`);
    assert.ok(console_.includes(hook), `the Admin console must render ${hook}`);
  }

  // And the subscription itself reads the computed list rather than a literal.
  assert.match(
    staffHomeScript,
    /staffLiveSubscription = globalThis\.quickDucksLive\.subscribe\(\{\s*domains: staffLiveDomains,\s*root: operationsRoot,/,
  );
});
