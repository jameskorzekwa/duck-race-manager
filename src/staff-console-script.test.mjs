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
  assert.match(staffHomeScript, /staffRoleLabels/);
  assert.match(staffHomeScript, /Select at least one operational role/);
  assert.match(staffHomeScript, /appConfirmationQueue/);
  assert.doesNotMatch(staffHomeScript, /\b(?:window\.)?confirm\s*\(/);

  for (const endpoint of [
    "/api/v1/staff/events",
    "/api/v1/staff/registrations/",
    "/api/v1/staff/inventory/ducks",
    "/heats/round-one/plan-preview",
    "/results/",
    "/api/v1/staff/profiles/",
    "/api/v1/staff/support/events/",
    "/return-batches",
    "/purge-claim",
    "/purge",
    "/force-delete",
  ]) {
    assert.ok(staffHomeScript.includes(endpoint), `missing endpoint ${endpoint}`);
  }
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

test("administrator event forms render automatic read-only slug previews", () => {
  const markup = renderStaffHome("Administrator", true, []);

  assert.match(markup, /data-event-create-slug-preview[^>]+readonly/);
  assert.match(markup, /data-event-config-slug-preview[^>]+readonly/);
  assert.match(markup, /Generated automatically when the event is saved/);
  assert.match(markup, /Changes automatically when the event name changes/);
  assert.doesNotMatch(markup, /name="slug"/);
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

  assert.deepEqual(lifecycleStatusOrder, [
    "DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE",
    "FINAL", "COMPLETED", "RETURN_PROCESSING", "ARCHIVED",
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
    "start-return-processing": transition("COMPLETED", "RETURN_PROCESSING", false),
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
  for (const action of ["start-round-one", "start-final", "complete", "start-return-processing"]) {
    assert.deepEqual(lifecycleReadinessPresentation(forward[action], "REGISTRATION_OPEN"), {
      kind: "blocked", chipText: "Blocked", chipClass: "status-chip blocked", upcoming: true,
    }, `${action} must stay blocked while upcoming`);
  }
  // The backward reopen is moot while registration is already open: neutral, not done, not blocked.
  assert.deepEqual(lifecycleReadinessPresentation(reopen, "REGISTRATION_OPEN"), {
    kind: "not-needed", chipText: "Not needed", chipClass: "status-chip", upcoming: false,
  });

  // ARCHIVED: every forward transition has been passed and reads as done.
  for (const [action, state] of Object.entries(forward)) {
    assert.deepEqual(lifecycleReadinessPresentation(state, "ARCHIVED"), {
      kind: "done", chipText: "Done", chipClass: "status-chip done", upcoming: false,
    }, `${action} must read as done on an archived event`);
  }
  // Reopen keeps genuine blocked semantics when it is unavailable rather than moot.
  assert.equal(lifecycleReadinessPresentation(reopen, "ARCHIVED").kind, "blocked");
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
