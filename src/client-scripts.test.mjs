import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationDialogScript,
  duckDetailHelpersScript,
  eventSlugHelpersScript,
  finishLineScript,
  finishHandoffHelpersScript,
  finishNfcHelpersScript,
  finishScanSerializationScript,
  finishSelectionValidationScript,
  inventoryIntakeHelpersScript,
  inventoryIntakeScript,
  liveBoardStageScript,
  liveScript,
  liveRuntimeHelpersScript,
  liveUiScript,
  participantHandoffHelpersScript,
  participantScript,
  registrationHandoffHelpersScript,
  registrationScript,
  stationStateHelpersScript,
  staffAccessScript,
  staffDuckScript,
  staffHomeScript,
  startLineScript,
} from "./client-scripts.ts";
import { publicHeatStatusLabels, publicOfficialResults } from "./race-status.ts";
import { searchScript } from "./site.ts";

const eventSlugHelpers = () => new Function(
  `${eventSlugHelpersScript}; return { eventSlugFromName };`,
)();

test("staff client generates and live-previews server-compatible event slugs", () => {
  const { eventSlugFromName } = eventSlugHelpers();
  assert.equal(eventSlugFromName("  Crème   Brûlée / Duck---Race!  "), "creme-brulee-duck-race");
  assert.equal(eventSlugFromName("東京 🦆"), "event-o05wec");
  assert.match(eventSlugFromName("東京 🦆"), /^event-[a-z0-9]+$/);
  assert.ok(eventSlugFromName("Long event name ".repeat(20)).length <= 80);
  assert.match(staffHomeScript, /elements\.name\.addEventListener\("input"/);
  assert.match(staffHomeScript, /updateEventSlugPreview\(eventConfigForm, eventConfigSlugPreview, currentEvent\)/);
  assert.doesNotMatch(staffHomeScript, /slug:\s*String\(values\.get\("slug"\)\)/);
});

test("the public pages' classic scripts share one global scope without collisions", () => {
  // The home page serves live-ui.js, live.js, and participant.js as classic
  // scripts, so every top-level declaration lands in one scope.
  assert.doesNotThrow(
    () => new Function([liveUiScript, liveScript, participantScript].join("\n")),
    "home page scripts must not redeclare each other's globals",
  );
  // My Ducks additionally serves the name-search client.
  assert.doesNotThrow(
    () => new Function([liveUiScript, searchScript, participantScript].join("\n")),
    "My Ducks page scripts must not redeclare each other's globals",
  );
  // /race serves the full board client.
  assert.doesNotThrow(
    () => new Function([liveUiScript, liveScript].join("\n")),
    "race page scripts must not redeclare each other's globals",
  );
  // The phase-driven navigation runtime rides in live-ui.js, which every page
  // loads, so it must coexist with every other page client too.
  const pageClients = {
    register: registrationScript,
    "staff home": staffHomeScript,
    "staff access": staffAccessScript,
    "staff duck": staffDuckScript,
    "start line": startLineScript,
    "finish line": finishLineScript,
    "inventory intake": inventoryIntakeScript,
  };
  for (const [name, script] of Object.entries(pageClients)) {
    assert.doesNotThrow(
      () => new Function([liveUiScript, script, participantScript].join("\n")),
      `${name} scripts must not redeclare the shared navigation globals`,
    );
  }
});

test("browser clients are valid JavaScript and target protected APIs", () => {
  assert.doesNotThrow(() => new Function(searchScript));
  assert.doesNotThrow(() => new Function(registrationScript));
  assert.doesNotThrow(() => new Function(participantScript));
  assert.doesNotThrow(() => new Function(staffDuckScript));
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.doesNotThrow(() => new Function(staffAccessScript));
  assert.doesNotThrow(() => new Function(liveScript));
  assert.doesNotThrow(() => new Function(startLineScript));
  assert.doesNotThrow(() => new Function(finishLineScript));
  assert.doesNotThrow(() => new Function(inventoryIntakeScript));
  assert.doesNotThrow(() => new Function(liveUiScript));
  assert.match(registrationScript, /\/api\/v1\/registrations/);
  assert.match(registrationScript, /publicNamePolicy/);
  assert.match(registrationScript, /Your name will appear publicly as/);
  assert.match(registrationScript, /Your email and phone stay private/);
  assert.doesNotMatch(registrationScript, /duckKeepPreference|duck_keep_preference/);
  assert.match(registrationScript, /\/my-ducks\?registered=/);
  assert.match(registrationScript, /registrationStoreHandoff\(globalThis\.sessionStorage/);
  assert.doesNotMatch(registrationScript, /\/my-ducks\?registered=.*privateStatusPath/);
  assert.match(participantScript, /\/api\/v1\/registrations\/mine/);
  assert.match(participantScript, /\/api\/v1\/registrations\/mine\/presence/);
  assert.match(participantScript, /Open private status/);
  assert.match(participantScript, /registration\.paired/);
  assert.match(participantScript, /history\.replaceState/);
  assert.match(participantScript, /card\.focus/);
  assert.match(participantScript, /card\.scrollIntoView/);
  assert.doesNotMatch(participantScript, /duckKeepPreference|duck_keep_preference/);
  for (const script of [searchScript, registrationScript, participantScript]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  assert.match(staffDuckScript, /\/api\/v1\/staff\/ducks/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/registrations\/search/);
  assert.match(staffDuckScript, /registration\.email/);
  assert.match(staffDuckScript, /registration\.phone/);
  assert.doesNotMatch(staffDuckScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  // Returns tracking is gone from every browser client.
  assert.doesNotMatch(staffDuckScript, /\/dispositions|disposition/);
  assert.doesNotMatch(staffHomeScript, /return-review|\/purge-ready|\/purge-claim|\/purge-gate|return-batches/);
  assert.doesNotMatch(staffHomeScript, /disposition|RETURN_STEWARD|RETURN_PROCESSING|ARCHIVED/);
  // Delete event is the console's only cleanup call.
  assert.match(staffHomeScript, /\/force-delete/);
  assert.doesNotMatch(staffHomeScript, /"\/purge"|\/purge",/);
  assert.match(staffHomeScript, /Administrator/);
  assert.doesNotMatch(staffHomeScript, /duckKeepPreference|duck_keep_preference/);
  // Staff account and role management moved to its own /staff/access client.
  assert.match(staffAccessScript, /\/api\/v1\/staff\/profiles/);
  assert.match(staffAccessScript, /Regular staff/);
  assert.match(staffAccessScript, /System administrator/);
  assert.doesNotMatch(staffAccessScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(staffHomeScript, /\/api\/v1\/staff\/profiles/);
  assert.match(inventoryIntakeScript, /\/api\/v1\/staff\/inventory\/provisioning/);
  assert.match(inventoryIntakeScript, /provisioning\/classify/);
  assert.match(inventoryIntakeScript, /provisioning\/confirm/);
  assert.match(inventoryIntakeScript, /provisioning\/takeover/);
  assert.match(inventoryIntakeScript, /appConfirm/);
  assert.match(inventoryIntakeScript, /data-takeover-provisioning/);
  assert.match(inventoryIntakeScript, /data-end-intake-nfc/);
  assert.match(inventoryIntakeScript, /new AbortController/);
  assert.match(inventoryIntakeScript, /scan\(\{ signal: candidateController\.signal \}\)/);
  assert.match(inventoryIntakeScript, /This duck is already registered in inventory/);
  assert.match(inventoryIntakeScript, /if \(outcome === "added"\)/);
  assert.match(inventoryIntakeScript, /recordType: "url", data: tagUrl/);
  assert.doesNotMatch(inventoryIntakeScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(inventoryIntakeScript, /localStorage|sessionStorage|serviceWorker|makeReadOnly|console\./);
  assert.doesNotMatch(inventoryIntakeScript, /tagToken|physicallyPresent|console\./);
});

class FakeElement {
  constructor(tagName, ownerDocument, nativeDialog = false) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.id = "";
    this.isConnected = false;
    this.open = false;
    this.parentNode = null;
    this.textContent = "";
    this.type = "";
    this.showModalCalls = 0;
    this.closeCalls = 0;
    this.classList = {
      add: (...names) => this.updateClasses(names, []),
      contains: (name) => this.className.split(/\s+/).includes(name),
      remove: (...names) => this.updateClasses([], names),
      toggle: (name, force) => {
        const present = this.classList.contains(name);
        const next = force === undefined ? !present : Boolean(force);
        this.updateClasses(next ? [name] : [], next ? [] : [name]);
        return next;
      },
    };
    if (nativeDialog) {
      this.showModal = () => {
        this.showModalCalls += 1;
        this.open = true;
      };
      this.close = () => {
        this.closeCalls += 1;
        this.open = false;
      };
    }
  }

  updateClasses(add, remove) {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    for (const name of add) names.add(name);
    for (const name of remove) names.delete(name);
    this.className = [...names].join(" ");
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.setConnected(this.isConnected);
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.textContent = "";
    this.append(...children);
  }

  setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) child.setConnected(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "open") this.open = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "open") this.open = false;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, init = {}) {
    const event = {
      ...init,
      type: name,
      target: init.target ?? this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
    return event;
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatch("focusin", { target: this });
  }
}

class FakeDocument {
  constructor(nativeDialog) {
    this.nativeDialog = nativeDialog;
    this.elements = [];
    this.listeners = new Map();
    this.body = this.createElement("body");
    this.body.setConnected(true);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName, this, this.nativeDialog && tagName === "dialog");
    this.elements.push(element);
    return element;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, init = {}) {
    const event = { ...init, type: name, target: init.target ?? this };
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }

  find(predicate) {
    return this.elements.find(predicate);
  }
}

const confirmationHarness = (nativeDialog = true) => {
  const document = new FakeDocument(nativeDialog);
  const trigger = document.createElement("button");
  trigger.textContent = "Open confirmation";
  document.body.append(trigger);
  trigger.focus();
  const appConfirm = new Function(
    "document",
    `${confirmationDialogScript}; return appConfirm;`,
  )(document);
  return {
    appConfirm,
    backdrop: document.find((element) => element.classList.contains("app-confirmation-backdrop")),
    cancel: document.find((element) => element.textContent === "Cancel"),
    confirm: document.find((element) => element.textContent === "Confirm"),
    dialog: document.find((element) => element.tagName === "DIALOG"),
    document,
    message: document.find((element) => element.id === "app-confirmation-message"),
    trigger,
  };
};

test("confirmation dialog is DOM-safe and compatible with the page CSP", () => {
  assert.doesNotThrow(() => new Function(confirmationDialogScript));
  assert.match(confirmationDialogScript, /createElement\("dialog"\)/);
  assert.match(confirmationDialogScript, /showModal/);
  assert.match(confirmationDialogScript, /aria-modal/);
  assert.doesNotMatch(
    confirmationDialogScript,
    /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\b(?:eval|Function)\s*\(|\.style\b|setAttribute\("style"/,
  );
  assert.doesNotMatch(confirmationDialogScript, /\.on(?:click|keydown|cancel|focusin)\s*=/);
});

test("confirmation dialog traps focus, cancels with Escape, and returns focus", async () => {
  const harness = confirmationHarness();
  const pending = harness.appConfirm('<img src=x onerror="unsafe">');

  assert.equal(harness.dialog.showModalCalls, 1);
  assert.equal(harness.dialog.getAttribute("role"), "dialog");
  assert.equal(harness.dialog.getAttribute("aria-modal"), "true");
  assert.equal(harness.message.textContent, '<img src=x onerror="unsafe">');
  assert.equal(harness.document.activeElement, harness.cancel);

  harness.dialog.dispatch("keydown", { key: "Tab" });
  assert.equal(harness.document.activeElement, harness.confirm);
  harness.dialog.dispatch("keydown", { key: "Tab" });
  assert.equal(harness.document.activeElement, harness.cancel);
  harness.dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(harness.document.activeElement, harness.confirm);

  const outside = harness.document.createElement("button");
  harness.document.body.append(outside);
  outside.focus();
  assert.equal(harness.document.activeElement, harness.cancel);

  const escape = harness.dialog.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(await pending, false);
  assert.equal(harness.dialog.hidden, true);
  assert.equal(harness.document.activeElement, harness.trigger);
});

test("confirmation dialog handles cancel and confirm controls with danger styling", async () => {
  const harness = confirmationHarness();
  const cancelled = harness.appConfirm("Cancel this action");
  harness.cancel.dispatch("click");
  assert.equal(await cancelled, false);

  const nativeCancelled = harness.appConfirm("Browser cancel event");
  const cancelEvent = harness.dialog.dispatch("cancel");
  assert.equal(cancelEvent.defaultPrevented, true);
  assert.equal(await nativeCancelled, false);

  const confirmed = harness.appConfirm("Delete this action", { danger: true });
  assert.equal(harness.dialog.classList.contains("danger-zone"), true);
  assert.equal(harness.confirm.classList.contains("danger"), true);
  harness.confirm.dispatch("click");
  assert.equal(await confirmed, true);
  assert.equal(harness.document.activeElement, harness.trigger);
});

test("confirmation dialog fallback supplies a blocking backdrop and cancellation", async () => {
  const harness = confirmationHarness(false);
  const pending = harness.appConfirm("Fallback confirmation");

  assert.equal(harness.dialog.classList.contains("fallback"), true);
  assert.equal(harness.dialog.open, true);
  assert.equal(harness.backdrop.hidden, false);
  assert.equal(harness.document.activeElement, harness.cancel);
  harness.backdrop.dispatch("click");
  assert.equal(await pending, false);
  assert.equal(harness.backdrop.hidden, true);
  assert.equal(harness.document.activeElement, harness.trigger);
});

test("confirmation requests serialize without overlapping dialogs", async () => {
  const harness = confirmationHarness();
  const first = harness.appConfirm("First confirmation");
  const second = harness.appConfirm("Second confirmation", { confirmLabel: "Proceed" });

  assert.equal(harness.dialog.showModalCalls, 1);
  assert.equal(harness.message.textContent, "First confirmation");
  harness.confirm.dispatch("click");
  assert.equal(await first, true);
  assert.equal(harness.dialog.showModalCalls, 2);
  assert.equal(harness.message.textContent, "Second confirmation");
  assert.equal(harness.confirm.textContent, "Proceed");
  harness.cancel.dispatch("click");
  assert.equal(await second, false);
  assert.equal(harness.dialog.closeCalls, 2);
});

const confirmationCallsites = [
  [startLineScript, 'if (!await appConfirm(readback, { danger: true })) return;'],
  [finishLineScript, 'if (!await appConfirm("Submit this official result now? Read back: " + readback + ". This publishes immediately.", { danger: true })) return;'],
  [inventoryIntakeScript, `if (!await appConfirm(
    "Take over pending Duck #" + candidate.visibleNumber
    + "? Continue only if the previous provisioning station has been abandoned.",
    { danger: true },
  )) return;`],
  [staffHomeScript, 'if (!await appConfirm("Run “" + button.textContent + "” for " + event.name + "?")) return;'],
  [staffHomeScript, 'if (!await appConfirm("Delete this empty draft? This cannot be undone.", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Permanently delete this event and every record for it, in any state? This cannot be undone.", { danger: true })) return;'],
  [staffHomeScript, 'if (dangerous && !await appConfirm(label + " for " + selectedRegistration.firstName + " " + selectedRegistration.lastName + "?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Reactivate this participant?")) return;'],
  [staffHomeScript, 'if (!await appConfirm("Retire the current tag and activate this verified replacement?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Retire this tag without a replacement? The duck will be quarantined.", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Assign Duck #" + selectedDuck.visibleNumber + " to this race entry?")) return;'],
  [staffHomeScript, 'if (!await appConfirm("Unassign Duck #" + selectedDuck.visibleNumber + " from its participant?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Release Duck #" + selectedDuck.visibleNumber + " from this event?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm(action + "? Read back: " + readback + ". This changes the public result immediately.", { danger: mode === "correct" })) return;'],
  [staffHomeScript, 'if (!await appConfirm(confirmation)) return;'],
  [staffHomeScript, 'if (!await appConfirm("Reopen this published result and remove downstream finalist promotion when applicable?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm(label + " this notification?", { danger: action !== "retry" })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Permanently delete the registration for " + registration.firstName + " " + registration.lastName + "? This removes the participant and their race entry. This cannot be undone.", { danger: true })) return;'],
  [staffAccessScript, 'if (!await appConfirm("Really " + description + "?", { danger: action === "deactivate" })) return;'],
  [participantScript, `  const confirmed = await appConfirm(
    "Delete the registration for " + participantDisplayName(registration)
    + "? It will be removed from the race and cannot be brought back.",
    { danger: true, confirmLabel: "Delete registration" },
  );
  if (!confirmed) return;`],
];

test("every confirmation callsite preserves its warning and returns before mutation on cancel", async () => {
  for (const [script, guardedWarning] of confirmationCallsites) {
    assert.ok(script.includes(guardedWarning), `missing guarded confirmation: ${guardedWarning}`);
  }
  assert.equal((startLineScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  assert.equal((finishLineScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  assert.equal((inventoryIntakeScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  // 19 minus the four retired returns/purge confirmations, minus the retired
  // balanced-plan commit, plus participant deletion.
  assert.equal((staffHomeScript.match(/\bappConfirm\(/g) ?? []).length, 15);
  assert.equal((staffAccessScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  // My Ducks has exactly one destructive action: self-service deletion.
  assert.equal((participantScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  // The dialog is defined once, by the one bundle every page loads first, so
  // no page client can redeclare it into a broken shared global scope.
  assert.match(liveUiScript, /const appConfirm = /);
  for (const script of [
    participantScript,
    registrationScript,
    searchScript,
    staffAccessScript,
    staffDuckScript,
    staffHomeScript,
    startLineScript,
    finishLineScript,
    inventoryIntakeScript,
    liveScript,
  ]) assert.doesNotMatch(script, /const appConfirm = |appConfirmationQueue/);

  let mutations = 0;
  const harness = confirmationHarness();
  const guardedMutation = async () => {
    if (!await harness.appConfirm("Guarded mutation")) return;
    mutations += 1;
  };
  const pending = guardedMutation();
  harness.cancel.dispatch("click");
  await pending;
  assert.equal(mutations, 0);
});

test("browser clients contain no native confirmation calls", () => {
  for (const script of [
    registrationScript,
    participantScript,
    staffDuckScript,
    staffHomeScript,
    liveScript,
    liveUiScript,
    startLineScript,
    finishLineScript,
    inventoryIntakeScript,
  ]) assert.doesNotMatch(script, /\b(?:window\.)?confirm\s*\(/);
});

const registrationHandoffHelpers = () => new Function(
  `${registrationHandoffHelpersScript}; return { registrationCreateHandoff, registrationStoreHandoff };`,
)();
const participantHandoffHelpers = () => new Function(
  `${participantHandoffHelpersScript}; return { participantValidateHandoff, participantConsumeHandoff };`,
)();

test("registration handoff stores only a strictly validated private path and tolerates storage failure", () => {
  const { registrationCreateHandoff, registrationStoreHandoff } = registrationHandoffHelpers();
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const privateStatusPath = `/r/${"p".repeat(43)}`;
  const value = { registrationId, privateStatusPath, lookupCode: "PRIVATE1" };
  assert.deepEqual(registrationCreateHandoff(value), { registrationId, privateStatusPath });
  for (const rejected of [
    { ...value, registrationId: "registration-one" },
    { ...value, privateStatusPath: `https://quickducks.com${privateStatusPath}` },
    { ...value, privateStatusPath: `${privateStatusPath}?share=1` },
    { ...value, privateStatusPath: `/r/${"p".repeat(42)}` },
    { ...value, privateStatusPath: `/t/${"p".repeat(43)}` },
  ]) assert.equal(registrationCreateHandoff(rejected), null);

  let serialized = null;
  assert.equal(registrationStoreHandoff({ setItem: (_key, value) => { serialized = value; } }, value), true);
  assert.deepEqual(JSON.parse(serialized), { registrationId, privateStatusPath });
  assert.equal(registrationStoreHandoff({ setItem: () => { throw new Error("blocked"); } }, value), false);
});

test("My Ducks consumes only the matching same-origin relative private handoff once", () => {
  const { participantValidateHandoff, participantConsumeHandoff } = participantHandoffHelpers();
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const otherRegistrationId = "22222222-2222-4222-8222-222222222222";
  const privateStatusPath = `/r/${"p".repeat(43)}`;
  const handoff = { registrationId, privateStatusPath };
  assert.deepEqual(
    participantValidateHandoff(handoff, registrationId, "https://quickducks.com"),
    handoff,
  );
  for (const rejected of [
    [{ ...handoff, extra: true }, registrationId, "https://quickducks.com"],
    [handoff, otherRegistrationId, "https://quickducks.com"],
    [{ ...handoff, privateStatusPath: `//evil.example/r/${"p".repeat(43)}` }, registrationId, "https://quickducks.com"],
    [{ ...handoff, privateStatusPath: `${privateStatusPath}#share` }, registrationId, "https://quickducks.com"],
    [handoff, registrationId, "https://quickducks.com/base"],
  ]) assert.equal(participantValidateHandoff(...rejected), null);

  const values = new Map([["quickducks.registration-handoff", JSON.stringify(handoff)]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };
  assert.equal(participantConsumeHandoff(storage, otherRegistrationId, "https://quickducks.com"), null);
  assert.equal(values.size, 1);
  assert.deepEqual(participantConsumeHandoff(storage, registrationId, "https://quickducks.com"), handoff);
  assert.equal(values.size, 0);
  assert.equal(participantConsumeHandoff(storage, registrationId, "https://quickducks.com"), null);

  const removalFailure = {
    getItem: () => JSON.stringify(handoff),
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(participantConsumeHandoff(removalFailure, registrationId, "https://quickducks.com"), null);
});

const inventoryHelpers = () => new Function(
  `${inventoryIntakeHelpersScript}; return { intakeProvisioningRuntimeIssue, intakeParseCanonicalTagUrl, intakeCanonicalUrlsFromMessage, intakeSafeTakeoverCandidate, intakeCreateProvisioningMachine, intakeCreateNfcStation };`,
)();

const androidChromeUserAgent = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

test("inventory runtime gate requires visible top-level Android Chrome Web NFC", () => {
  const { intakeProvisioningRuntimeIssue } = inventoryHelpers();
  const supported = {
    userAgent: androidChromeUserAgent,
    hasNdefReader: true,
    secureContext: true,
    topLevel: true,
    visible: true,
  };
  assert.equal(intakeProvisioningRuntimeIssue(supported), null);
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, userAgent: "" }), "android-chrome");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, userAgent: "Mozilla/5.0 (iPhone) Version/18.5 Mobile Safari/604.1" }), "android-chrome");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, userAgent: "Mozilla/5.0 (Macintosh) Chrome/138.0.0.0 Safari/537.36" }), "android-chrome");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, userAgent: "Mozilla/5.0 (Linux; Android 15) Firefox/140.0" }), "android-chrome");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, userAgent: "Mozilla/5.0 (Linux; Android 15; wv) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36" }), "android-chrome");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, hasNdefReader: false }), "web-nfc");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, secureContext: false }), "secure-context");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, topLevel: false }), "top-level");
  assert.equal(intakeProvisioningRuntimeIssue({ ...supported, visible: false }), "visible");
});

test("spoofed Android user agent without Web NFC reveals nothing and calls no API", () => {
  const runtimeNotice = { hidden: true };
  const runtimeMessage = { textContent: "" };
  const controls = { hidden: true };
  const elements = new Map([
    ["[data-intake-runtime]", runtimeNotice],
    ["[data-intake-runtime-message]", runtimeMessage],
    ["[data-intake-controls]", controls],
  ]);
  const document = {
    visibilityState: "visible",
    querySelector: (selector) => elements.get(selector) ?? {},
    createElement: () => ({ setAttribute: () => {}, append: () => {} }),
    body: { append: () => {} },
  };
  const window = {};
  window.top = window;
  window.self = window;
  let apiCalls = 0;

  new Function("document", "navigator", "window", "isSecureContext", "fetch", inventoryIntakeScript)(
    document,
    { userAgent: androidChromeUserAgent },
    window,
    true,
    () => { apiCalls += 1; },
  );

  assert.equal(apiCalls, 0);
  assert.equal(controls.hidden, true);
  assert.equal(runtimeNotice.hidden, false);
  assert.match(runtimeMessage.textContent, /does not expose Web NFC/);
});

test("inventory takeover metadata is redacted and never auto-adopted", async () => {
  const { intakeSafeTakeoverCandidate } = inventoryHelpers();
  const candidate = {
    duckId: "duck-abandoned",
    provisioningCommandId: "11111111-1111-4111-8111-111111111111",
    visibleNumber: 42,
    status: "PENDING_WRITE",
    takeoverAvailable: true,
  };
  assert.deepEqual(intakeSafeTakeoverCandidate(candidate), {
    duckId: candidate.duckId,
    provisioningCommandId: candidate.provisioningCommandId,
    visibleNumber: candidate.visibleNumber,
  });
  assert.equal(intakeSafeTakeoverCandidate({ ...candidate, tagUrl: "https://quickducks.com/t/secret" }), null);

  const { calls, machine } = makeProvisioningMachine({ recover: () => candidate });
  assert.equal(await machine.recover(), null);
  assert.equal(machine.hasPending(), false);
  assert.deepEqual(calls.starts, []);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.confirms, []);
});

test("inventory intake parser accepts only exact canonical tag URLs", () => {
  const { intakeParseCanonicalTagUrl } = inventoryHelpers();
  const token = "Abc_123-xyz".repeat(2);
  const canonical = `https://quickducks.com/t/${token}`;
  assert.equal(intakeParseCanonicalTagUrl(canonical, "https://quickducks.com"), canonical);
  for (const rejected of [
    `  ${canonical}  `,
    `http://quickducks.com/t/${token}`,
    `https://www.quickducks.com/t/${token}`,
    `https://user@quickducks.com/t/${token}`,
    `${canonical}?next=1`,
    `${canonical}#fragment`,
    `https://quickducks.com/t/${"a".repeat(21)}`,
    `https://quickducks.com/t/${"a".repeat(129)}`,
    `https://quickducks.com/t/${token}/`,
    `https://quickducks.com/T/${token}`,
    `https://quickducks.com/t/${token}%2Fextra`,
    `/t/${token}`,
  ]) assert.equal(intakeParseCanonicalTagUrl(rejected, "https://quickducks.com"), null, rejected);
});

test("inventory intake parser preserves every distinct canonical URL in record order", () => {
  const { intakeCanonicalUrlsFromMessage } = inventoryHelpers();
  const first = `https://quickducks.com/t/${"a".repeat(43)}`;
  const second = `https://quickducks.com/t/${"b".repeat(43)}`;
  const message = { records: [
    { recordType: "url", value: first },
    { recordType: "text", value: "not a tag" },
    { recordType: "url", value: second },
    { recordType: "text", value: first },
  ] };
  assert.deepEqual(
    intakeCanonicalUrlsFromMessage(message, "https://quickducks.com", (record) => record.value),
    [first, second],
  );
  assert.deepEqual(intakeCanonicalUrlsFromMessage(null, "https://quickducks.com", () => ""), []);
});

test("inventory NFC station scans continuously and writes the exact canonical URL record", async () => {
  const { intakeCreateNfcStation } = inventoryHelpers();
  class FakeReader {
    listeners = new Map();
    scans = 0;
    scanSignal = null;
    writes = [];
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
    async scan({ signal }) { this.scans += 1; this.scanSignal = signal; }
    async write(message) { this.writes.push(message); }
    emit(name, event) { return this.listeners.get(name)?.(event); }
  }
  const reader = new FakeReader();
  const readings = [];
  let active = 0;
  const station = intakeCreateNfcStation({
    createReader: () => reader,
    decode: (record) => record.value,
    appOrigin: "https://quickducks.com",
    onReading: (reading) => { readings.push(reading); },
    onReadingError: () => {},
    onStartError: () => assert.fail("scan should start"),
    onActive: () => { active += 1; },
  });

  const tagUrl = `https://quickducks.com/t/${"a".repeat(43)}`;
  assert.equal(await station.start(), true);
  assert.equal(await station.start(), false);
  reader.emit("reading", {
    serialNumber: "transient-hardware-value",
    message: { records: [{ recordType: "mime", value: "ignored" }, { recordType: "url", value: tagUrl }] },
  });
  await station.write(tagUrl);
  assert.equal(reader.scans, 1);
  assert.equal(reader.scanSignal.aborted, false);
  assert.equal(active, 1);
  assert.deepEqual(readings, [{ serialNumber: "transient-hardware-value", canonicalUrls: [tagUrl] }]);
  assert.deepEqual(reader.writes, [{ records: [{ recordType: "url", data: tagUrl }] }]);
  assert.equal(reader.listeners.has("reading"), true);
});

test("ending NFC scanning aborts cleanly, is idempotent, and can restart", async () => {
  const { intakeCreateNfcStation } = inventoryHelpers();
  class FakeReader {
    listeners = new Map();
    signal = null;
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
    async scan({ signal }) { this.signal = signal; }
    async write() {}
  }
  const readers = [];
  const station = intakeCreateNfcStation({
    createReader: () => {
      const reader = new FakeReader();
      readers.push(reader);
      return reader;
    },
    decode: () => "",
    appOrigin: "https://quickducks.com",
    onReading: () => {},
    onReadingError: () => {},
    onStartError: () => assert.fail("scan should start"),
    onActive: () => {},
  });

  assert.equal(await station.start(), true);
  assert.equal(station.isActive(), true);
  assert.equal(station.stop(), true);
  assert.equal(readers[0].signal.aborted, true);
  assert.equal(readers[0].listeners.size, 0);
  assert.equal(station.isActive(), false);
  assert.equal(station.stop(), false);
  await assert.rejects(station.write(`https://quickducks.com/t/${"a".repeat(43)}`), /nfc-not-active/);

  assert.equal(await station.start(), true);
  assert.equal(readers.length, 2);
  assert.equal(readers[1].signal.aborted, false);
  assert.equal(station.isActive(), true);
  assert.equal(station.stop(), true);
});

const makeProvisioningMachine = (overrides = {}) => {
  const { intakeCreateProvisioningMachine } = inventoryHelpers();
  const pending = {
    duckId: "duck-1",
    provisioningCommandId: "11111111-1111-4111-8111-111111111111",
    visibleNumber: 42,
    tagUrl: `https://quickducks.com/t/${"p".repeat(43)}`,
    status: "PENDING_WRITE",
  };
  const calls = {
    accepted: [], classifications: [], confirms: [], feedback: [], messages: [],
    ready: [], recoveries: [], starts: [], states: [], writes: [], refreshes: 0,
  };
  let nextCommand = 0;
  const machine = intakeCreateProvisioningMachine({
    eventId: () => "event-1",
    location: () => "Bin A",
    recover: async (eventId) => {
      calls.recoveries.push(eventId);
      return overrides.recover ? overrides.recover(eventId) : null;
    },
    start: async (material) => {
      calls.starts.push({ ...material });
      return overrides.start ? overrides.start(material) : pending;
    },
    classify: async (material) => {
      calls.classifications.push({ ...material });
      return overrides.classify
        ? overrides.classify(material)
        : { kind: "pending", duckId: pending.duckId, provisioningCommandId: pending.provisioningCommandId };
    },
    write: async (tagUrl) => {
      calls.writes.push(tagUrl);
      if (overrides.write) return overrides.write(tagUrl);
    },
    confirm: async (material) => {
      calls.confirms.push({ ...material });
      return overrides.confirm ? overrides.confirm(material) : { replayed: false };
    },
    refresh: async () => {
      calls.refreshes += 1;
      if (overrides.refresh) return overrides.refresh();
    },
    accepted: (value) => calls.accepted.push(value),
    message: (...value) => calls.messages.push(value),
    state: (value) => calls.states.push(value),
    feedback: (value) => calls.feedback.push(value),
    commandId: () => `command-${++nextCommand}`,
    scheduleReady: (callback) => calls.ready.push(callback),
  });
  return { calls, machine, pending };
};

test("blank NFC reading performs one generated start, exact write, and confirmation", async () => {
  const { calls, machine, pending } = makeProvisioningMachine();
  const result = await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] });

  assert.deepEqual(result, { accepted: true, outcome: "added" });
  assert.deepEqual(calls.starts, [{ commandId: "command-1", eventId: "event-1", location: "Bin A" }]);
  assert.deepEqual(calls.writes, [pending.tagUrl]);
  assert.deepEqual(calls.confirms, [{
    commandId: "command-2",
    eventId: "event-1",
    duckId: pending.duckId,
    provisioningCommandId: pending.provisioningCommandId,
    physicalWriteVerified: true,
  }]);
  assert.deepEqual(calls.accepted, [{ outcome: "added" }]);
  assert.equal(calls.refreshes, 1);
  assert.deepEqual(calls.feedback, ["added"]);
  assert.equal(calls.recoveries.length, 1);
  assert.deepEqual(await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] }), { accepted: false, reason: "busy" });
  calls.ready[0]();
  assert.deepEqual(await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] }), { accepted: false, reason: "repeated" });
});

test("provisioning serializes physical reads without queueing a second sticker", async () => {
  let releaseStart;
  const { calls, machine, pending } = makeProvisioningMachine({
    start: () => new Promise((resolve) => { releaseStart = () => resolve(pending); }),
  });
  const first = machine.reading({ serialNumber: "serial-a", canonicalUrls: [] });
  assert.deepEqual(await machine.reading({ serialNumber: "serial-b", canonicalUrls: [] }), { accepted: false, reason: "busy" });
  releaseStart();
  assert.equal((await first).accepted, true);
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.writes.length, 1);
});

test("failed NFC write retaps the same sticker with the same URL and no new allocation", async () => {
  let attempts = 0;
  const { calls, machine, pending } = makeProvisioningMachine({
    write: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("tag moved");
    },
  });
  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] }),
    { accepted: false, reason: "write-failed" },
  );
  assert.deepEqual(
    await machine.reading({
      serialNumber: "active-tag",
      canonicalUrls: [`https://quickducks.com/t/${"a".repeat(43)}`],
    }),
    { accepted: false, reason: "mismatch" },
  );
  assert.match(calls.messages.at(-1)[0], /Finish the pending sticker/);
  assert.equal(calls.accepted.length, 0);
  assert.equal(calls.refreshes, 0);
  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(calls.starts.length, 1);
  assert.deepEqual(calls.classifications, [{
    eventId: "event-1",
    tagUrl: `https://quickducks.com/t/${"a".repeat(43)}`,
  }]);
  assert.deepEqual(calls.writes, [pending.tagUrl, pending.tagUrl]);
  assert.equal(calls.confirms.length, 1);
});

test("uncertain confirmation retries without rewrite or allocation and rejects a different sticker", async () => {
  let confirmations = 0;
  const { calls, machine, pending } = makeProvisioningMachine({
    confirm: async () => {
      confirmations += 1;
      if (confirmations === 1) throw new TypeError("network lost");
      return { replayed: false };
    },
  });
  assert.equal((await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] })).reason, "confirm-uncertain");
  assert.equal(
    (await machine.reading({ serialNumber: "serial-b", canonicalUrls: [] })).reason,
    "wrong-confirmation-tag",
  );
  assert.equal(
    (await machine.reading({
      serialNumber: "active-tag",
      canonicalUrls: [`https://quickducks.com/t/${"a".repeat(43)}`],
    })).reason,
    "mismatch",
  );
  assert.match(calls.messages.at(-1)[0], /Finish the pending sticker/);
  assert.equal(calls.accepted.length, 0);
  assert.equal(calls.refreshes, 0);
  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [pending.tagUrl] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(calls.starts.length, 1);
  assert.deepEqual(calls.writes, [pending.tagUrl]);
  assert.equal(calls.confirms.length, 2);
  assert.deepEqual(calls.confirms[1], calls.confirms[0]);
  assert.deepEqual(calls.classifications, [
    { eventId: "event-1", tagUrl: `https://quickducks.com/t/${"a".repeat(43)}` },
    { eventId: "event-1", tagUrl: pending.tagUrl },
  ]);
});

test("reload recovery recognizes the exact pending URL and confirms without rewriting", async () => {
  const { calls, machine, pending } = makeProvisioningMachine({ recover: () => pending });
  assert.equal((await machine.recover()).tagUrl, pending.tagUrl);
  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [pending.tagUrl] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(calls.starts.length, 0);
  assert.deepEqual(calls.writes, []);
  assert.equal(calls.confirms.length, 1);
});

test("ending is blocked until a pending server reservation is safely confirmed", async () => {
  let writeAttempts = 0;
  const { calls, machine } = makeProvisioningMachine({
    write: async () => {
      writeAttempts += 1;
      if (writeAttempts === 1) throw new Error("tag moved");
    },
  });

  assert.equal((await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] })).reason, "write-failed");
  assert.equal(machine.hasPending(), true);
  assert.equal(machine.end(), false);
  assert.equal(calls.confirms.length, 0);

  assert.equal((await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] })).outcome, "added");
  assert.equal(machine.hasPending(), false);
  assert.equal(machine.end(), false);
  calls.ready[0]();
  assert.equal(machine.end(), true);
});

test("a replayed server confirmation completes one session addition and remove-duck interlock", async () => {
  const { calls, machine } = makeProvisioningMachine({
    confirm: async () => ({ replayed: true }),
  });

  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.confirms.length, 1);
  assert.deepEqual(calls.accepted, [{ outcome: "added" }]);
  assert.equal(calls.ready.length, 1);
  assert.equal(calls.states.at(-1), "remove");
  assert.match(calls.messages.at(-1)[0], /Remove this duck/);
  calls.ready[0]();
  assert.equal(calls.states.at(-1), "ready");
});

test("an exact local pending URL classified as already resolves the lost confirmation", async () => {
  let confirmations = 0;
  const { calls, machine, pending } = makeProvisioningMachine({
    classify: async () => ({ kind: "already" }),
    confirm: async () => {
      confirmations += 1;
      if (confirmations === 1) throw new TypeError("response lost");
      return { replayed: true };
    },
  });

  assert.equal((await machine.reading({ serialNumber: "serial-a", canonicalUrls: [] })).reason, "confirm-uncertain");
  assert.deepEqual(
    await machine.reading({ serialNumber: "serial-a", canonicalUrls: [pending.tagUrl] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(calls.starts.length, 1);
  assert.deepEqual(calls.writes, [pending.tagUrl]);
  assert.equal(calls.confirms.length, 2);
  assert.deepEqual(calls.confirms[1], calls.confirms[0]);
  assert.deepEqual(calls.accepted, [{ outcome: "added" }]);
  assert.equal(calls.ready.length, 1);
  assert.equal(calls.states.at(-1), "remove");
});

test("all NFC record orders classify known URLs before any mutation", async () => {
  const unknownUrl = `https://quickducks.com/t/${"u".repeat(43)}`;
  const knownUrl = `https://quickducks.com/t/${"k".repeat(43)}`;
  const cases = [
    { name: "unknown then known", urls: [unknownUrl, knownUrl], classified: [unknownUrl, knownUrl] },
    { name: "known then unknown", urls: [knownUrl, unknownUrl], classified: [knownUrl, unknownUrl] },
    { name: "duplicate known", urls: [unknownUrl, knownUrl, knownUrl], classified: [unknownUrl, knownUrl] },
  ];
  for (const entry of cases) {
    const current = makeProvisioningMachine({
      classify: async ({ tagUrl }) => ({ kind: tagUrl === knownUrl ? "already" : "reusable" }),
    });
    assert.deepEqual(
      await current.machine.reading({ serialNumber: entry.name, canonicalUrls: entry.urls }),
      { accepted: true, outcome: "already" },
      entry.name,
    );
    assert.deepEqual(current.calls.classifications.map(({ tagUrl }) => tagUrl), entry.classified, entry.name);
    assert.deepEqual(current.calls.starts, [], entry.name);
    assert.deepEqual(current.calls.writes, [], entry.name);
    assert.deepEqual(current.calls.confirms, [], entry.name);
    assert.deepEqual(current.calls.accepted, [{ outcome: "already" }], entry.name);
  }
});

test("mixed pending and other canonical URLs fail after complete classification", async () => {
  const reusableUrl = `https://quickducks.com/t/${"r".repeat(43)}`;
  const knownUrl = `https://quickducks.com/t/${"k".repeat(43)}`;
  for (const otherUrl of [reusableUrl, knownUrl]) {
    const current = makeProvisioningMachine({
      recover: () => current.pending,
      classify: async ({ tagUrl }) => tagUrl === current.pending.tagUrl
        ? { kind: "pending", duckId: current.pending.duckId, provisioningCommandId: current.pending.provisioningCommandId }
        : { kind: tagUrl === knownUrl ? "already" : "reusable" },
    });
    await current.machine.recover();
    assert.equal(
      (await current.machine.reading({
        serialNumber: otherUrl,
        canonicalUrls: [current.pending.tagUrl, otherUrl],
      })).reason,
      "mismatch",
    );
    assert.equal(current.calls.classifications.length, 2);
    assert.deepEqual(current.calls.starts, []);
    assert.deepEqual(current.calls.writes, []);
    assert.deepEqual(current.calls.confirms, []);
    assert.deepEqual(current.calls.accepted, []);
    assert.equal(current.machine.hasPending(), true);
  }
});

test("multiple different known URLs fail safely without mutation", async () => {
  const firstKnownUrl = `https://quickducks.com/t/${"k".repeat(43)}`;
  const secondKnownUrl = `https://quickducks.com/t/${"q".repeat(43)}`;
  const current = makeProvisioningMachine({ classify: async () => ({ kind: "already" }) });

  assert.equal((await current.machine.reading({
    serialNumber: "multiple-known",
    canonicalUrls: [firstKnownUrl, secondKnownUrl],
  })).reason, "mismatch");
  assert.equal(current.calls.classifications.length, 2);
  assert.deepEqual(current.calls.starts, []);
  assert.deepEqual(current.calls.writes, []);
  assert.deepEqual(current.calls.confirms, []);
  assert.deepEqual(current.calls.accepted, []);
  assert.match(current.calls.messages.at(-1)[0], /multiple different registered/);
});

test("canonical existing URLs are classified before any write or allocation", async () => {
  const active = makeProvisioningMachine({ classify: async () => ({ kind: "already" }) });
  assert.deepEqual(
    await active.machine.reading({ serialNumber: "active", canonicalUrls: [active.pending.tagUrl] }),
    { accepted: true, outcome: "already" },
  );
  assert.equal(active.calls.starts.length, 0);
  assert.equal(active.calls.writes.length, 0);
  assert.equal(active.calls.confirms.length, 0);
  assert.deepEqual(active.calls.accepted, [{ outcome: "already" }]);
  assert.equal(active.calls.accepted.some(({ outcome }) => outcome === "added"), false);
  assert.equal(active.calls.ready.length, 0);
  assert.equal(active.calls.states.at(-1), "ready");
  assert.match(active.calls.messages.at(-1)[0], /already registered in inventory/);

  const reusableUrl = `https://quickducks.com/t/${"r".repeat(43)}`;
  const secondReusableUrl = `https://quickducks.com/t/${"s".repeat(43)}`;
  const reusable = makeProvisioningMachine({ classify: async () => ({ kind: "reusable" }) });
  assert.deepEqual(
    await reusable.machine.reading({ serialNumber: "purged", canonicalUrls: [reusableUrl, secondReusableUrl] }),
    { accepted: true, outcome: "added" },
  );
  assert.equal(reusable.calls.starts.length, 1);
  assert.deepEqual(reusable.calls.writes, [reusable.pending.tagUrl]);
  assert.equal(reusable.calls.writes.includes(reusableUrl), false);
  assert.equal(reusable.calls.confirms.length, 1);

  const mismatch = makeProvisioningMachine({
    classify: async () => ({ kind: "mismatch", message: "Unknown inventory." }),
  });
  assert.equal(
    (await mismatch.machine.reading({ serialNumber: "unknown", canonicalUrls: [mismatch.pending.tagUrl] })).reason,
    "mismatch",
  );
  assert.equal(mismatch.calls.starts.length, 0);
  assert.equal(mismatch.calls.writes.length, 0);
  assert.match(mismatch.calls.messages.at(-1)[0], /Unknown inventory/);
});

test("live clients build safe DOM and retain reconnect plus polling fallback", () => {
  for (const script of [
    searchScript,
    registrationScript,
    participantScript,
    liveScript,
    startLineScript,
    finishLineScript,
    inventoryIntakeScript,
    staffHomeScript,
    staffDuckScript,
  ]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(script, /quickDucksLive\.subscribe/);
  }
  for (const script of [liveUiScript, participantScript, liveScript, startLineScript, finishLineScript]) {
    assert.doesNotMatch(script, /setInterval/);
  }
  for (const script of [participantScript, liveScript, startLineScript, finishLineScript]) {
    assert.doesNotMatch(script, /new WebSocket\(|liveCreatePollScheduler\(/);
  }
  assert.match(liveUiScript, /new WebSocketClass/);
  assert.match(liveUiScript, /liveReconnectDelay/);
  assert.match(liveUiScript, /15000/);
  assert.match(liveUiScript, /liveCreatePollScheduler/);
  assert.match(liveUiScript, /\/api\/v1\/live/);
  assert.match(liveUiScript, /\/api\/v1\/staff\/session/);
  assert.match(liveUiScript, /data-live-dirty/);
  assert.match(liveScript, /\/api\/v1\/race-board/);
  assert.doesNotMatch(liveScript, /\/api\/v1\/registrations\/mine/);
  assert.match(participantScript, /\/api\/v1\/registrations\/mine/);
  assert.match(liveScript, /replaceChildren/);
  assert.match(liveScript, /textContent/);
  assert.match(participantScript, /ArrowLeft/);
  assert.match(participantScript, /replaceChildren/);
  assert.match(participantScript, /textContent/);
  // Rosters lock when the round starts, so the station offers no lock action
  // and a planned heat is only ever a waiting state here.
  assert.doesNotMatch(startLineScript, /"lock"/);
  assert.match(startLineScript, /LOADING: \["ready"/);
  assert.match(startLineScript, /CALLING: \["start"/);
  assert.doesNotMatch(startLineScript, /\/results\/finalize|\["finish"/);
  assert.match(finishLineScript, /NDEFReader/);
  assert.match(finishLineScript, /That duck is already selected/);
  assert.match(finishLineScript, /That duck is not in the selected heat/);
  assert.match(finishLineScript, /finishSelected\.length !== finishRequiredPlaces/);
  assert.match(finishLineScript, /\/results\/finalize/);
});

const freshnessStrings = [
  /Updated just now/,
  /Updates are arriving live/,
  /Checking for fresh updates/,
  /Reconnecting; this (?:page|station) is still checking for updates/,
  /Updates are delayed/,
  /Saved registrations are temporarily unavailable/,
  /personal details are delayed/,
  /public race board is current/,
];

const liveScripts = [
  liveUiScript,
  liveRuntimeHelpersScript,
  liveScript,
  participantScript,
  startLineScript,
  finishLineScript,
  inventoryIntakeScript,
  staffHomeScript,
  staffDuckScript,
  searchScript,
  registrationScript,
];

test("no browser client renders ambient freshness or connection-status chatter", () => {
  for (const script of liveScripts) {
    for (const pattern of freshnessStrings) assert.doesNotMatch(script, pattern);
    assert.doesNotMatch(script, /data-(?:live|station|my-ducks)-freshness/);
    assert.doesNotMatch(script, /liveSuccessfulFreshness|[Ff]reshness/);
  }
  // The shared hub no longer fans a connection status out to subscribers.
  assert.doesNotMatch(liveUiScript, /setStatus|subscriber\.status/);
  for (const script of [liveScript, participantScript, startLineScript, finishLineScript]) {
    assert.doesNotMatch(script, /status:\s*\(status\)/);
  }
});

test("hard failures stay visible through error-only lines and station message lines", () => {
  // Stations keep their own actionable operational message line.
  assert.match(startLineScript, /data-station-message/);
  assert.match(startLineScript, /if \(error\.message !== "signed-out"\) startMessage\.textContent = error\.message;/);
  assert.match(finishLineScript, /data-station-message/);
  assert.match(finishLineScript, /if \(error\.message !== "signed-out"\) finishMessage\.textContent = error\.message;/);
  assert.match(inventoryIntakeScript, /data-intake-message/);

  // The public board and My Ducks have no other message surface, so each keeps a
  // minimal error-only line that is cleared on the next successful refresh.
  assert.match(liveScript, /data-live-board-error/);
  assert.match(liveScript, /liveShowBoardError\("The race board could not be loaded\./);
  assert.match(liveScript, /liveShowBoardError\(null\)/);
  assert.match(liveScript, /liveBoardError\.hidden = message === null/);
  assert.match(participantScript, /data-my-ducks-error/);
  assert.match(participantScript, /participantShowError\("Saved registrations could not be loaded\./);
  assert.match(participantScript, /participantShowError\(null\)/);
  assert.match(participantScript, /participantError\.hidden = message === null/);
});

// A very small attribute-selector DOM good enough to run the two public
// participant clients end to end without a browser.
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
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.clientWidth = 0;
    this.dataset = {};
    this.disabled = false;
    this.focusCalls = 0;
    this.hidden = false;
    this.listeners = new Map();
    this.scrollCalls = 0;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.tabIndex = 0;
    this.textContent = "";
    this.type = "";
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, init = {}) {
    const event = { ...init, type: name, target: this, preventDefault() {} };
    return Promise.all([...(this.listeners.get(name) ?? [])].map((listener) => listener(event)));
  }

  focus() {
    this.focusCalls += 1;
  }

  scrollIntoView() {
    this.scrollCalls += 1;
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => quickMatches(node, selector));
  }

  text() {
    return [this.textContent, ...this.children.map((child) => child.text())].join(" ").trim();
  }
}

class QuickDocument extends QuickNode {
  createElement(tagName) {
    return new QuickNode(tagName);
  }
}

class QuickFormData {
  constructor(form) {
    this.form = form;
  }

  get(name) {
    return this.form.values[name] ?? null;
  }
}

const homeHarness = (route) => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  navigation.hidden = true;
  const form = document.createElement("form");
  form.dataset.statusSearch = "";
  form.values = { name: "Daisy" };
  const message = document.createElement("p");
  message.dataset.searchMessage = "";
  const results = document.createElement("div");
  results.dataset.searchResults = "";
  document.append(navigation, form, message, results);

  const requests = [];
  const fetchStub = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return route(String(url), options);
  };
  const subscriptions = [];
  const cleaned = [];
  const live = {
    markClean(root) { cleaned.push(root); },
    subscribe(subscriber) { subscriptions.push(subscriber); },
  };

  new Function("document", "fetch", "FormData", "globalThis", searchScript)(
    document,
    fetchStub,
    QuickFormData,
    { quickDucksLive: live },
  );

  return { cleaned, document, form, message, navigation, requests, results, subscriptions };
};

const currentEventResponse = () => Response.json({ event: { id: "event-1" } });
const searchResult = (overrides = {}) => ({
  event: { id: "event-1", slug: "race", name: "Race", eventDate: null, status: "REGISTRATION_OPEN" },
  participantDisplayName: "Daisy D.",
  duck: null,
  assignedHeat: { roundOne: null, final: null },
  currentHeat: null,
  outcome: "AWAITING_DUCK_PAIRING",
  followId: "11111111-1111-4111-8111-111111111111",
  inMyDucks: false,
  ...overrides,
});
const cardAction = (results) => results.children[0].children.find((child) => child.className === "actions");

test("a search result offers one add action that confirms and reveals the My Ducks nav", async () => {
  let followStatus = 200;
  const harness = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    if (url.startsWith("/api/v1/race-status/search")) return Response.json({ results: [searchResult()] });
    return Response.json({ followed: true, alreadyInCollection: false }, { status: followStatus });
  });

  await harness.form.dispatch("submit");
  const card = harness.results.children[0];
  assert.equal(card.className, "duck-card");
  assert.equal(card.children[0].textContent, "Daisy D.");
  // The public search has no lookup code, so no card line can claim one.
  assert.doesNotMatch(card.text(), /lookup/i);

  const actions = cardAction(harness.results);
  const button = actions.children[0];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.type, "button");
  assert.equal(button.className, "button small");
  assert.equal(button.textContent, "Add to My Ducks");
  assert.equal(harness.navigation.hidden, true);

  await button.dispatch("click");
  const follow = harness.requests.at(-1);
  assert.equal(follow.url, "/api/v1/registrations/mine/follow");
  assert.equal(follow.options.method, "POST");
  assert.equal(follow.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(follow.options.body), {
    followId: "11111111-1111-4111-8111-111111111111",
  });

  const confirmed = cardAction(harness.results);
  assert.equal(confirmed.children.length, 1);
  assert.equal(confirmed.children[0].tagName, "SPAN");
  assert.equal(confirmed.children[0].textContent, "In My Ducks");
  assert.equal(confirmed.children[0].className, "success-tag");
  assert.equal(harness.navigation.hidden, false, "the My Ducks nav must be revealed");
  assert.equal(harness.navigation.dataset.hasRegistrations, "true");
  // The search shares the My Ducks page, so a successful follow asks the hub to
  // rerun every authoritative refetch instead of rendering the new entry itself.
  assert.equal(harness.cleaned.at(-1), harness.form);
  assert.equal(followStatus, 200);
});

test("a result already in the collection renders the added state with no add action", async () => {
  const harness = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    return Response.json({ results: [searchResult({ inMyDucks: true })] });
  });

  await harness.form.dispatch("submit");
  const actions = cardAction(harness.results);
  assert.equal(actions.children.length, 1);
  assert.equal(actions.children[0].textContent, "In My Ducks");
  assert.equal(actions.children.some((child) => child.tagName === "BUTTON"), false);
  assert.equal(harness.requests.filter((item) => item.url.includes("/follow")).length, 0);
});

test("a failed add restores the action and reports the failure on that result", async () => {
  const harness = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    if (url.startsWith("/api/v1/race-status/search")) return Response.json({ results: [searchResult()] });
    return Response.json({ error: "Too many requests." }, { status: 429 });
  });

  await harness.form.dispatch("submit");
  const card = harness.results.children[0];
  const button = cardAction(harness.results).children[0];
  await button.dispatch("click");

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Add to My Ducks");
  const feedback = card.children.at(-1);
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /could not be added to My Ducks/);
  assert.equal(harness.navigation.hidden, true);
});

test("a search result without a follow identifier renders no add action", async () => {
  const harness = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    return Response.json({ results: [searchResult({ followId: undefined })] });
  });

  await harness.form.dispatch("submit");
  assert.equal(cardAction(harness.results), undefined);
  assert.equal(harness.results.children[0].children.length, 2);
});

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
  return { controls, section, track };
};

const myDucksHarness = (route, search = "", confirmResult = true) => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  navigation.hidden = true;
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
  const awaiting = participantSection(document, "awaiting");
  const paired = participantSection(document, "paired");
  page.append(error, success, empty, awaiting.section, paired.section);
  document.append(navigation, page);

  const requests = [];
  const fetchStub = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return route(String(url), options);
  };
  const subscriptions = [];
  // `appConfirm` ships in live-ui.js, which My Ducks loads first, so the page
  // client receives it from the shared global scope rather than defining it.
  const confirmations = [];
  const busy = [];
  const appConfirm = async (message, options) => {
    confirmations.push({ message, options });
    return confirmResult;
  };

  new Function(
    "document", "location", "window", "globalThis", "requestAnimationFrame", "history", "fetch",
    "appConfirm",
    participantScript,
  )(
    document,
    { search, pathname: "/my-ducks", hash: "", origin: "https://quickducks.com" },
    { addEventListener() {} },
    {
      quickDucksLive: {
        beginBusy() {
          busy.push("begin");
          return () => busy.push("end");
        },
        subscribe(subscriber) { subscriptions.push(subscriber); },
      },
    },
    (callback) => callback(),
    { replaceState() {}, state: null },
    fetchStub,
    appConfirm,
  );

  return {
    awaiting,
    busy,
    confirmations,
    document,
    empty,
    error,
    navigation,
    paired,
    requests,
    subscriptions,
    success,
  };
};

const collected = (registrationId, paired, overrides = {}) => ({
  registrationId,
  firstName: "Daisy",
  lastName: "Duck",
  displayName: "Daisy Duck",
  lookupCode: "DAISY123",
  followed: false,
  registrationStatus: "SUBMITTED",
  paired,
  raceStatus: null,
  ...overrides,
});

const renderMyDucks = async (registrations) => {
  const harness = myDucksHarness(() => Response.json({ registrations }));
  assert.equal(harness.subscriptions.length, 1);
  await harness.subscriptions[0].refresh();
  return harness;
};

const deleteButton = (card) => card.descendants()
  .find((node) => node.tagName === "BUTTON" && node.dataset.deleteRegistration !== undefined) ?? null;

test("an empty participant group hides its whole section instead of an empty state", async () => {
  const awaitingOnly = await renderMyDucks([collected("11111111-1111-4111-8111-111111111111", false)]);
  assert.equal(awaitingOnly.awaiting.section.hidden, false);
  assert.equal(awaitingOnly.awaiting.controls.hidden, false);
  assert.equal(awaitingOnly.paired.section.hidden, true, "an empty paired group hides its section");
  assert.equal(awaitingOnly.empty.hidden, true);
  assert.equal(awaitingOnly.navigation.hidden, false);
  assert.equal(awaitingOnly.error.hidden, true);

  const pairedOnly = await renderMyDucks([collected("22222222-2222-4222-8222-222222222222", true)]);
  assert.equal(pairedOnly.awaiting.section.hidden, true, "an empty awaiting group hides its section");
  assert.equal(pairedOnly.paired.section.hidden, false);
  assert.equal(pairedOnly.empty.hidden, true);

  const both = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false),
    collected("22222222-2222-4222-8222-222222222222", true),
  ]);
  assert.equal(both.awaiting.section.hidden, false);
  assert.equal(both.paired.section.hidden, false);
  assert.equal(both.empty.hidden, true);
});

test("an entirely empty collection keeps one guidance message instead of a blank page", async () => {
  const harness = await renderMyDucks([]);

  assert.equal(harness.awaiting.section.hidden, true);
  assert.equal(harness.paired.section.hidden, true);
  assert.equal(harness.empty.hidden, false, "the page must never render nothing at all");
  assert.equal(harness.navigation.hidden, true);
});

test("My Ducks sections stay hidden until the first successful collection response", async () => {
  const harness = myDucksHarness(() => Response.json({ error: "unavailable" }, { status: 503 }));
  await harness.subscriptions[0].refresh();

  assert.equal(harness.awaiting.section.hidden, true);
  assert.equal(harness.paired.section.hidden, true);
  assert.equal(harness.empty.hidden, true, "a failed first load must not claim an empty collection");
  assert.equal(harness.error.hidden, false);
  assert.match(harness.error.textContent, /Saved registrations could not be loaded/);
});

test("a live regroup moves a newly paired participant between the two sections", async () => {
  let paired = false;
  const harness = myDucksHarness(() => Response.json({
    registrations: [collected("11111111-1111-4111-8111-111111111111", paired)],
  }));

  await harness.subscriptions[0].refresh();
  assert.equal(harness.awaiting.track.children.length, 1);
  assert.equal(harness.paired.section.hidden, true);

  paired = true;
  await harness.subscriptions[0].refresh();
  assert.equal(harness.awaiting.section.hidden, true);
  assert.equal(harness.awaiting.track.children.length, 0);
  assert.equal(harness.paired.section.hidden, false);
  assert.equal(harness.paired.track.children.length, 1);
  assert.equal(harness.empty.hidden, true);
});

test("a followed card shows the policy display name and never a lookup code", async () => {
  const harness = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false),
    collected("22222222-2222-4222-8222-222222222222", false, {
      firstName: null,
      lastName: null,
      displayName: "Donald M.",
      lookupCode: null,
      followed: true,
    }),
  ]);

  const [owned, followed] = harness.awaiting.track.children;
  assert.match(owned.text(), /Daisy Duck/);
  assert.match(owned.text(), /Staff lookup code: DAISY123/);
  assert.match(followed.text(), /Donald M\./);
  assert.doesNotMatch(followed.text(), /Staff lookup code/);
  assert.doesNotMatch(followed.text(), /null/);
  assert.equal(followed.children[0].className, "success-tag");
  assert.equal(followed.children[0].textContent, "Following");
});

test("the delete action appears only on an own removable entry, never on a followed one", async () => {
  const harness = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false, { deletable: true }),
    // Own and unpaired, but the server did not mark it removable.
    collected("22222222-2222-4222-8222-222222222222", false, { deletable: false }),
    // Followed entries never carry a delete, even if `deletable` were wrong.
    collected("33333333-3333-4333-8333-333333333333", false, {
      firstName: null,
      lastName: null,
      displayName: "Donald M.",
      lookupCode: null,
      followed: true,
      deletable: true,
    }),
    // Paired entries live in the other section and are never removable.
    collected("44444444-4444-4444-8444-444444444444", true, { deletable: false }),
  ]);

  const [removable, notRemovable, followed] = harness.awaiting.track.children;
  const [paired] = harness.paired.track.children;
  assert.ok(deleteButton(removable), "an own removable entry offers deletion");
  assert.equal(deleteButton(removable).className, "button danger small");
  assert.equal(deleteButton(removable).textContent, "Delete registration");
  assert.equal(deleteButton(notRemovable), null);
  assert.equal(deleteButton(followed), null, "a followed entry is someone else's registration");
  assert.equal(deleteButton(paired), null);
  // No delete action is silently repurposed into an unfollow.
  assert.doesNotMatch(followed.text(), /Delete|Remove|Unfollow/);
  assert.equal(harness.confirmations.length, 0);
});

test("deleting confirms with danger styling, posts the guarded command, and refetches", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  let registrations = [collected(registrationId, false, { deletable: true })];
  const harness = myDucksHarness((url) => url.endsWith("/mine/delete")
    ? Response.json({ deleted: true, replayed: false })
    : Response.json({ registrations }));
  await harness.subscriptions[0].refresh();

  const button = deleteButton(harness.awaiting.track.children[0]);
  registrations = [];
  await button.dispatch("click");

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].message, /Delete the registration for Daisy Duck\?/);
  assert.match(harness.confirmations[0].message, /cannot be brought back/);
  assert.deepEqual(harness.confirmations[0].options, {
    danger: true,
    confirmLabel: "Delete registration",
  });

  const request = harness.requests.find((item) => item.url.endsWith("/mine/delete"));
  assert.ok(request, "the delete must reach the public endpoint");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/json");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), ["commandId", "registrationId"]);
  assert.equal(payload.registrationId, registrationId);
  assert.match(payload.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // The card is removed by refetching the authoritative collection, not by
  // trusting the mutation response.
  assert.equal(harness.requests.at(-1).url, "/api/v1/registrations/mine");
  assert.equal(harness.awaiting.track.children.length, 0);
  assert.equal(harness.empty.hidden, false);
  assert.deepEqual(harness.busy, ["begin", "end"]);
  assert.equal(harness.error.hidden, true);
});

test("a cancelled delete confirmation never calls the endpoint", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const harness = myDucksHarness(
    () => Response.json({ registrations: [collected(registrationId, false, { deletable: true })] }),
    "",
    false,
  );
  await harness.subscriptions[0].refresh();

  const button = deleteButton(harness.awaiting.track.children[0]);
  await button.dispatch("click");

  assert.equal(harness.confirmations.length, 1);
  assert.equal(harness.requests.some((item) => item.url.includes("/delete")), false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Delete registration");
  assert.equal(harness.awaiting.track.children.length, 1);
});

test("a refused delete restores the action and reports the refusal on that card", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const harness = myDucksHarness((url) => url.endsWith("/mine/delete")
    ? Response.json({ error: "This registration already has a race duck." }, { status: 409 })
    : Response.json({ registrations: [collected(registrationId, false, { deletable: true })] }));
  await harness.subscriptions[0].refresh();

  const card = harness.awaiting.track.children[0];
  const button = deleteButton(card);
  await button.dispatch("click");

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Delete registration");
  const feedback = card.children.at(-1);
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /could not be deleted/);
  assert.match(feedback.textContent, /ask race staff/);
  assert.equal(harness.awaiting.track.children.length, 1, "the card stays until the server removes it");
  assert.deepEqual(harness.busy, ["begin", "end"]);
});

test("the just-registered highlight survives the section-visibility change", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const harness = myDucksHarness(
    () => Response.json({ registrations: [collected(registrationId, false)] }),
    `?registered=${registrationId}`,
  );

  await harness.subscriptions[0].refresh();

  assert.equal(harness.awaiting.section.hidden, false);
  assert.equal(harness.success.hidden, false);
  assert.match(harness.success.text(), /Registration saved\./);
  assert.match(harness.success.text(), /Daisy Duck is highlighted below\./);
  const card = harness.awaiting.track.children[0];
  assert.equal(card.className, "duck-card participant-card is-current");
  assert.equal(card.getAttribute("aria-current"), "true");
  assert.equal(card.focusCalls, 1);
  assert.equal(card.scrollCalls, 1);
});

const liveBoardStageHelpers = () => new Function(
  `${liveBoardStageScript}; return { liveEventStage, liveStageSummary };`,
)();

test("the live board names the stage for every event lifecycle status", () => {
  const { liveEventStage } = liveBoardStageHelpers();

  assert.deepEqual(
    Object.fromEntries(
      [
        "DRAFT",
        "REGISTRATION_OPEN",
        "REGISTRATION_CLOSED",
        "ROUND_ONE",
        "FINAL",
        "COMPLETED",
      ].map((status) => [status, liveEventStage(status).label]),
    ),
    {
      DRAFT: "Race being prepared",
      REGISTRATION_OPEN: "Participant registration open",
      REGISTRATION_CLOSED: "Registration closed",
      ROUND_ONE: "Round one under way",
      FINAL: "Final under way",
      COMPLETED: "Results official",
    },
  );

  // Retired statuses are unknown values now and must fall back like any other.
  // Unknown and prototype-shaped values fall back instead of leaking enum text.
  for (const status of [
    "", "SOMETHING_NEW", "constructor", "toString", undefined, null,
    "RETURN_PROCESSING", "ARCHIVED",
  ]) {
    assert.deepEqual(
      liveEventStage(status),
      { label: "Race stage updating", summary: "The race stage is being confirmed." },
      String(status),
    );
  }
});

test("the live board summary leads with the stage and keeps running-heat detail", () => {
  const { liveStageSummary } = liveBoardStageHelpers();

  assert.equal(
    liveStageSummary("REGISTRATION_OPEN", null, false),
    "Registration is open. Sign up to put a duck in this race. Heats have not been posted yet.",
  );
  assert.equal(
    liveStageSummary("REGISTRATION_CLOSED", null, true),
    "Registration is closed while staff finalize the heats. The latest official heats and results are below.",
  );
  assert.equal(
    liveStageSummary("ROUND_ONE", "Round one · Heat 5 · Racing now", true),
    "Round one is under way. Running now: Round one · Heat 5 · Racing now.",
  );
  assert.equal(
    liveStageSummary("ROUND_ONE", null, true),
    "Round one is under way. The latest official heats and results are below.",
  );
  assert.equal(
    liveStageSummary("FINAL", "Final · Heat 1 · Racing now", true),
    "The final is under way. Running now: Final · Heat 1 · Racing now.",
  );
  assert.equal(
    liveStageSummary("COMPLETED", null, true),
    "Every heat is finished and the results are final. The latest official heats and results are below.",
  );
  assert.match(liveStageSummary("DRAFT", null, false), /^Race staff are still preparing this race\./);
  // Retired statuses get the neutral fallback, not a returns-flavoured message.
  for (const status of ["RETURN_PROCESSING", "ARCHIVED"]) {
    assert.match(liveStageSummary(status, null, true), /^The race stage is being confirmed\./, status);
  }
});

test("the live board renders the stage chip from the public board status only", () => {
  assert.match(liveScript, /liveBoardStageChip = document\.querySelector\("\[data-live-board-stage\]"\)/);
  assert.match(liveScript, /liveBoardStageChip\.textContent = liveEventStage\(event\.status\)\.label/);
  assert.match(liveScript, /liveBoardStageChip\.textContent = "No race scheduled"/);
  assert.match(liveScript, /liveBoardTitle\.textContent = event\.name/);
  assert.match(liveScript, /liveBoardSummary\.textContent = liveStageSummary\(/);
  // The stage never depends on anything beyond the public projection.
  assert.doesNotMatch(liveScript, /event\.(?:email|phone|lookupCode|privateToken|staff)/);
  // Heat and podium rendering stays intact underneath the stage.
  assert.match(liveScript, /liveRound\("Round one", event\.roundOneHeats, event\.currentHeat\)/);
  assert.match(liveScript, /liveRound\("Final", event\.finalHeats, event\.currentHeat\)/);
  assert.match(liveScript, /liveText\("h3", "Official podium"\)/);
});

test("station state helpers prioritize unpublished results and stable render keys", () => {
  const helpers = new Function(
    `${stationStateHelpersScript}; return { startPickHeat, finishPickHeat, stationHeatRenderKey };`,
  )();
  const heats = [
    { id: "new-running", round: "ROUND_ONE", status: "RUNNING", revision: 5 },
    { id: "next", round: "ROUND_ONE", status: "CALLING", revision: 3 },
    { id: "pending", round: "ROUND_ONE", status: "AWAITING_RESULT", revision: 8 },
  ];

  assert.equal(helpers.startPickHeat(heats, "ROUND_ONE").id, "pending");
  assert.equal(helpers.finishPickHeat(heats, "ROUND_ONE").id, "pending");
  assert.equal(
    helpers.stationHeatRenderKey({ id: "event" }, { heat: heats[2] }),
    "event:pending:8:AWAITING_RESULT",
  );
});

test("live runtime helpers coalesce refreshes and switch fake poll timers", async () => {
  const helpers = new Function(
    `${liveRuntimeHelpersScript}; return { livePollDelay, liveReconnectDelay, liveParseRefreshSignal, liveSignalMatches, liveCreateRefreshQueue, liveCreatePollScheduler, liveCreateHub };`,
  )();
  assert.equal(helpers.livePollDelay(false), 5000);
  assert.equal(helpers.livePollDelay(true), 30000);
  assert.equal(helpers.liveReconnectDelay(0, 0), 800);
  assert.equal(helpers.liveReconnectDelay(0, 1), 1200);
  assert.equal(helpers.liveReconnectDelay(8, 1), 15000);

  let release;
  let refreshes = 0;
  const firstRefresh = new Promise((resolve) => { release = resolve; });
  const queued = helpers.liveCreateRefreshQueue(async () => {
    refreshes += 1;
    if (refreshes === 1) await firstRefresh;
  }, () => false);
  const first = queued();
  const second = queued();
  assert.equal(first, second);
  assert.equal(refreshes, 1);
  release();
  await first;
  assert.equal(refreshes, 2);

  let hidden = false;
  const timers = new Map();
  let nextTimer = 0;
  const scheduler = helpers.liveCreatePollScheduler(
    async () => {},
    () => hidden,
    (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    (id) => timers.delete(id),
  );
  scheduler.schedule(false);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [5000]);
  scheduler.schedule(true);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [30000]);
  hidden = true;
  scheduler.schedule(true);
  assert.equal(timers.size, 0);
});

const makeLiveHarness = () => {
  const documentListeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const main = { clears: 0, replaceChildren() { this.clears += 1; } };
  let staffRoot = null;
  const documentObject = {
    hidden: false,
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    querySelector(selector) {
      if (selector === "main") return main;
      if (selector === "[data-live-staff]") return staffRoot;
      return null;
    },
  };
  class FakeSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      FakeSocket.instances.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.listeners.get("close")?.(); }
    emit(type, event = {}) { this.listeners.get(type)?.(event); }
  }
  const locationCalls = [];
  const locationObject = {
    protocol: "https:",
    host: "quickducks.com",
    reload() { locationCalls.push(["reload"]); },
    replace(path) { locationCalls.push(["replace", path]); },
  };
  const helpers = new Function(`${liveRuntimeHelpersScript}; return { liveCreateHub, liveParseRefreshSignal };`)();
  let nowValue = 0;
  const hub = helpers.liveCreateHub({
    WebSocketClass: FakeSocket,
    documentObject,
    locationObject,
    setTimer(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    now: () => nowValue,
  });
  return {
    documentListeners,
    documentObject,
    FakeSocket,
    helpers,
    hub,
    locationCalls,
    main,
    setNow(value) { nowValue = value; },
    setStaffRoot(value) { staffRoot = value; },
    timers,
  };
};

// A subscriber root with one form control that the hub can mark dirty/clean.
const makeDirtyRoot = () => {
  const control = { dataset: {}, matches: () => true, querySelectorAll: () => [] };
  const root = {
    dataset: {},
    querySelector: (selector) => selector === "[data-live-dirty='true']" && control.dataset.liveDirty === "true"
      ? control
      : null,
    querySelectorAll: (selector) => selector === "[data-live-dirty='true']" && control.dataset.liveDirty === "true"
      ? [control]
      : [],
  };
  return { control, root };
};

const liveFrame = (domains = ["participants"]) => JSON.stringify({
  type: "refresh",
  domains,
  version: "11111111-1111-4111-8111-111111111111",
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("shared live hub validates frames, reconnects, coalesces, and defers dirty or busy refreshes", async () => {
  const harness = makeLiveHarness();
  let refreshes = 0;
  let release = null;
  harness.hub.subscribe({
    domains: ["participants"],
    refresh: async () => {
      refreshes += 1;
      if (release !== null) await new Promise((resolve) => { release.resolve = resolve; });
    },
  });
  await settle();
  assert.equal(refreshes, 1);

  harness.hub.start();
  const socket = harness.FakeSocket.instances[0];
  assert.equal(socket.url, "wss://quickducks.com/api/v1/live");
  socket.emit("open");
  await settle();
  assert.equal(refreshes, 2);

  socket.emit("message", { data: JSON.stringify({ type: "refresh", domains: ["participants"], version: "participant-name" }) });
  await settle();
  assert.equal(refreshes, 2);

  release = {};
  socket.emit("message", { data: liveFrame() });
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 3);
  release.resolve();
  release = null;
  await settle();
  assert.equal(refreshes, 4);

  const control = {
    dataset: {},
    matches() { return true; },
    querySelectorAll() { return []; },
  };
  harness.documentObject.querySelector = (selector) => selector === "[data-live-dirty='true']" && control.dataset.liveDirty === "true"
    ? control
    : selector === "main" ? harness.main : null;
  harness.documentListeners.get("input")({ target: control });
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 4);
  harness.hub.markClean(control);
  await settle();
  assert.equal(refreshes, 5);

  const endBusy = harness.hub.beginBusy();
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 5);
  endBusy();
  await settle();
  assert.equal(refreshes, 6);

  socket.emit("close");
  const reconnect = [...harness.timers.values()].find((timer) => timer.delay < 2000);
  assert.ok(reconnect);
  reconnect.callback();
  assert.equal(harness.FakeSocket.instances.length, 2);
});

test("live hub opens no socket and schedules no polls without subscribers", async () => {
  const harness = makeLiveHarness();
  harness.hub.start();
  await settle();
  assert.equal(harness.FakeSocket.instances.length, 0);
  assert.equal(harness.timers.size, 0);

  let refreshes = 0;
  harness.hub.subscribe({ domains: ["participants"], refresh: async () => { refreshes += 1; } });
  await settle();
  assert.equal(harness.FakeSocket.instances.length, 1);
  assert.equal(harness.FakeSocket.instances[0].url, "wss://quickducks.com/api/v1/live");
  assert.ok(harness.timers.size > 0);
  assert.equal(refreshes, 1);
});

test("live hub connects on start when a subscriber already exists", async () => {
  const harness = makeLiveHarness();
  harness.hub.subscribe({ domains: ["participants"], refresh: async () => {} });
  await settle();
  assert.equal(harness.FakeSocket.instances.length, 0);
  harness.hub.start();
  assert.equal(harness.FakeSocket.instances.length, 1);
});

test("an abandoned edit in one root defers only that subscriber, not the others", async () => {
  const harness = makeLiveHarness();
  const blocked = makeDirtyRoot();
  const unblocked = makeDirtyRoot();
  let blockedRefreshes = 0;
  let unblockedRefreshes = 0;
  harness.hub.subscribe({
    domains: ["participants"],
    root: blocked.root,
    refresh: async () => { blockedRefreshes += 1; },
  });
  harness.hub.subscribe({
    domains: ["participants"],
    root: unblocked.root,
    refresh: async () => { unblockedRefreshes += 1; },
  });
  harness.hub.start();
  await settle();
  assert.equal(blockedRefreshes, 1);
  assert.equal(unblockedRefreshes, 1);

  const socket = harness.FakeSocket.instances[0];
  socket.emit("open");
  await settle();
  harness.documentListeners.get("input")({ target: blocked.control });
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(blockedRefreshes, 2, "dirty root must defer its own subscriber");
  assert.equal(unblockedRefreshes, 3, "a clean root must keep refreshing");

  harness.hub.markClean(blocked.root);
  await settle();
  assert.equal(blockedRefreshes, 3, "cleaning the root must release the deferred refresh");
});

test("a subscriber blocked by an abandoned edit recovers after five minutes", async () => {
  const harness = makeLiveHarness();
  const { control, root } = makeDirtyRoot();
  let refreshes = 0;
  harness.hub.subscribe({
    domains: ["participants"],
    root,
    refresh: async () => { refreshes += 1; },
  });
  harness.hub.start();
  await settle();
  assert.equal(refreshes, 1);
  const socket = harness.FakeSocket.instances[0];
  socket.emit("open");
  await settle();
  assert.equal(refreshes, 2);

  harness.documentListeners.get("input")({ target: control });
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 2, "a fresh edit must defer the refresh");

  harness.setNow(299999);
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 2, "the deferral must hold inside the five-minute bound");

  harness.setNow(300000);
  socket.emit("message", { data: liveFrame() });
  await settle();
  assert.equal(refreshes, 3, "an abandoned edit must stop blocking after five minutes");
});

test("purge and staff deactivation clear rendered private data before navigation", async (context) => {
  const purge = makeLiveHarness();
  purge.hub.subscribe({ domains: ["participants"], refresh: async () => {} });
  purge.hub.start();
  purge.FakeSocket.instances[0].emit("message", { data: liveFrame(["all"]) });
  await settle();
  assert.equal(purge.main.clears, 1);
  assert.deepEqual(purge.locationCalls, [["reload"]]);

  const deactivation = makeLiveHarness();
  deactivation.setStaffRoot({ dataset: { systemAdmin: "false", roles: "REGISTRATION" } });
  context.mock.method(globalThis, "fetch", async () => Response.json(
    { error: "Staff authentication required." },
    { status: 401 },
  ));
  deactivation.hub.subscribe({ domains: ["staff"], refresh: async () => {} });
  deactivation.hub.start();
  deactivation.FakeSocket.instances[0].emit("message", { data: liveFrame(["staff"]) });
  await settle();
  assert.equal(deactivation.main.clears, 1);
  assert.deepEqual(deactivation.locationCalls, [["replace", "/staff"]]);
});

test("finish selection rejects wrong-heat and duplicate race entries", () => {
  const validate = new Function(
    `${finishSelectionValidationScript}; return finishSelectionProblem;`,
  )();
  const roster = [{ raceEntryId: "entry-1" }, { raceEntryId: "entry-2" }];

  assert.equal(validate([], roster, "entry-1"), null);
  assert.equal(validate([{ raceEntryId: "entry-1" }], roster, "entry-1"), "duplicate");
  assert.equal(validate([], roster, "entry-other"), "wrong-heat");
});

test("finish scans serialize rapid lookups, preserve place order, and discard stale responses", async () => {
  const { finishCreateSerializedSelector } = new Function(
    `${finishScanSerializationScript}; return { finishCreateSerializedSelector };`,
  )();
  let context = { eventId: "event", heatId: "heat", revision: 4, intendedPlace: 1 };
  const lookups = [];
  const accepted = [];
  const busy = [];
  let stale = 0;
  const selector = finishCreateSerializedSelector({
    readContext: () => ({ ...context }),
    setBusy: (value) => busy.push(value),
    lookup: (value) => new Promise((resolve) => lookups.push({ value, resolve })),
    accept: (selection, captured) => accepted.push({ selection, place: captured.intendedPlace }),
    stale: () => { stale += 1; },
  });

  const first = selector("duck-1");
  const ignored = await selector("duck-2");
  assert.deepEqual(ignored, { accepted: false, reason: "busy" });
  assert.equal(lookups.length, 1);
  lookups[0].resolve({ raceEntryId: "entry-1" });
  assert.deepEqual(await first, { accepted: true, place: 1 });

  context = { ...context, intendedPlace: 2 };
  const second = selector("duck-2");
  lookups[1].resolve({ raceEntryId: "entry-2" });
  assert.deepEqual(await second, { accepted: true, place: 2 });
  assert.deepEqual(accepted.map((item) => item.place), [1, 2]);
  assert.deepEqual(busy, [true, false, true, false]);

  context = { ...context, intendedPlace: 3 };
  const staleLookup = selector("duck-3");
  context = { ...context, revision: 5 };
  lookups[2].resolve({ raceEntryId: "entry-3" });
  assert.deepEqual(await staleLookup, { accepted: false, reason: "stale" });
  assert.equal(stale, 1);
  assert.deepEqual(accepted.map((item) => item.place), [1, 2]);
});

test("NFC scanning cleans up unsupported records and read errors so one retry can start", async () => {
  const { finishCreateNfcScanner } = new Function(
    `${finishNfcHelpersScript}; return { finishCreateNfcScanner };`,
  )();
  const readers = [];
  const active = [];
  const values = [];
  let unsupported = 0;
  let readingErrors = 0;
  class FakeReader {
    listeners = new Map();
    scanCalls = 0;
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }
    async scan() { this.scanCalls += 1; }
    emit(name, event = {}) { return this.listeners.get(name)?.(event); }
  }
  const scanner = finishCreateNfcScanner({
    createReader: () => {
      const reader = new FakeReader();
      readers.push(reader);
      return reader;
    },
    createController: () => ({ signal: {}, abort() {} }),
    decode: (record) => record.value,
    onValue: async (value) => { values.push(value); },
    onUnsupported: () => { unsupported += 1; },
    onReadingError: () => { readingErrors += 1; },
    onStartError: () => assert.fail("scan should start"),
    setActive: (value) => active.push(value),
  });

  assert.equal(await scanner(), true);
  assert.equal(await scanner(), false);
  assert.equal(readers.length, 1);
  await readers[0].emit("reading", { message: { records: [{ recordType: "mime" }] } });
  assert.equal(unsupported, 1);
  assert.equal(readers[0].listeners.size, 0);

  assert.equal(await scanner(), true);
  readers[1].emit("readingerror");
  assert.equal(readingErrors, 1);
  assert.equal(readers[1].listeners.size, 0);

  assert.equal(await scanner(), true);
  const reading = readers[2].emit("reading", {
    message: { records: [{ recordType: "url", value: "https://quickducks.com/t/token" }] },
  });
  readers[2].emit("reading", {
    message: { records: [{ recordType: "url", value: "duplicate" }] },
  });
  await reading;
  assert.deepEqual(values, ["https://quickducks.com/t/token"]);
  assert.deepEqual(active, [true, false, true, false, true, false]);
  assert.deepEqual(readers.map((reader) => reader.scanCalls), [1, 1, 1]);
});

test("handoff helpers reject expired, wrong-heat, and stale-revision scans", () => {
  const helpers = new Function(
    `${finishHandoffHelpersScript}; return { finishParseHandoff, finishBuildHandoffSearch, finishHandoffProblem };`,
  )();
  const stored = {
    returnPath: "/staff/finish-line",
    eventId: "event-1",
    heatId: "heat-1",
    revision: 7,
    expiresAt: 10_000,
  };
  const token = "a".repeat(32);
  const handoff = helpers.finishParseHandoff("?" + helpers.finishBuildHandoffSearch(stored, token));
  const current = { eventId: "event-1", heatId: "heat-1", revision: 7, status: "AWAITING_RESULT" };

  assert.equal(helpers.finishHandoffProblem(handoff, current, 9_000), null);
  assert.equal(helpers.finishHandoffProblem(handoff, current, 10_000), "expired");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, heatId: "heat-2" }, 9_000), "wrong-heat");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, revision: 8 }, 9_000), "stale-revision");
  assert.equal(helpers.finishHandoffProblem(handoff, { ...current, status: "RUNNING" }, 9_000), "not-awaiting");
});

test("staff duck scan hands complete iPhone context back without submitting", () => {
  const token = "a".repeat(32);
  const context = {
    returnPath: "/staff/finish-line",
    eventId: "event-1",
    heatId: "heat-1",
    revision: 7,
    expiresAt: Date.now() + 60_000,
  };
  const values = new Map([[
    "quickducks.finishStation",
    JSON.stringify(context),
  ]]);
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) { values.delete(key); },
  };
  let destination = null;
  const location = {
    pathname: `/staff/ducks/${token}`,
    replace(value) { destination = value; },
  };

  new Function("document", "location", "localStorage", staffDuckScript)(null, location, localStorage);

  const destinationUrl = new URL(destination, "https://quickducks.com");
  assert.equal(destinationUrl.pathname, "/staff/finish-line");
  assert.deepEqual(Object.fromEntries(destinationUrl.searchParams), {
    tag: token,
    eventId: context.eventId,
    heatId: context.heatId,
    revision: String(context.revision),
    expiresAt: String(context.expiresAt),
  });
  assert.equal(values.has("quickducks.finishStation"), false);
  assert.doesNotMatch(destination, /submit|result/i);
});

const nodeText = (node) => node.textContent + node.children.map(nodeText).join("");

const duckLinkHelpers = () => {
  const document = new FakeDocument(false);
  const helpers = new Function(
    "document",
    `${duckDetailHelpersScript}; return { duckDetailPath, duckDetailLink, duckHeatStatusLabel, duckOfficialResult };`,
  )(document);
  return { ...helpers, document };
};

// The board and My Ducks both render duck numbers, so the same builder decides
// when a number becomes a link and what that link points at.
test("the duck detail link builder emits a plain navigation only for a real duck number", () => {
  const { duckDetailPath, duckDetailLink, document } = duckLinkHelpers();

  assert.equal(duckDetailPath(128), "/duck/128");

  const link = duckDetailLink(document, 128);
  assert.equal(link.tagName, "A");
  assert.equal(link.href, "/duck/128");
  assert.equal(link.textContent, "Duck #128");
  assert.equal(link.className, "duck-number-link");
  // A plain navigation carries no click handler and no scripted behaviour.
  assert.equal(link.listeners.size, 0);
  assert.equal(link.getAttribute("target"), null);

  // No duck assigned, or any value that is not a usable visible number, must
  // never produce a link.
  for (const value of [null, undefined, 0, -3, 1.5, "128", Number.NaN]) {
    assert.equal(duckDetailLink(document, value), null, String(value));
  }
});

test("browser duck-detail wording is generated from the server projection", () => {
  const { duckHeatStatusLabel, duckOfficialResult } = duckLinkHelpers();

  assert.deepEqual(
    Object.fromEntries(Object.keys(publicHeatStatusLabels).map((status) => [status, duckHeatStatusLabel(status)])),
    publicHeatStatusLabels,
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(publicOfficialResults).map((outcome) => [outcome, duckOfficialResult(outcome)])),
    publicOfficialResults,
  );

  // Unknown and prototype-shaped values fall back instead of leaking enum text.
  for (const value of ["", "SOMETHING_NEW", "constructor", "toString"]) {
    assert.equal(duckHeatStatusLabel(value), "Status being checked", value);
    assert.equal(duckOfficialResult(value), null, value);
  }
  // Outcomes without a finalized heat have no official finishing result.
  for (const outcome of ["NOT_RACED", "RUNNING", "AWAITING_RESULT", "FINALIST", "AWAITING_DUCK_PAIRING"]) {
    assert.equal(duckOfficialResult(outcome), null, outcome);
  }
});

const liveDuckPage = ({ raceStatus = null, personalStatus = 200, boardEvent = null } = {}) => {
  const document = new FakeDocument(false);
  const personal = document.createElement("div");
  personal.dataset.livePersonal = "number";
  const nodes = {
    "[data-live-board]": document.createElement("section"),
    "[data-live-board-stage]": document.createElement("p"),
    "[data-live-board-title]": document.createElement("h2"),
    "[data-live-board-summary]": document.createElement("p"),
    "[data-live-board-content]": document.createElement("div"),
    "[data-live-board-error]": document.createElement("p"),
    "[data-live-personal]": personal,
    main: document.createElement("main"),
  };
  document.querySelector = (selector) => nodes[selector] ?? null;
  const requests = [];
  const subscriptions = [];
  const reloads = [];
  const fetchStub = async (url) => {
    requests.push(url);
    if (url.startsWith("/api/v1/race-board")) {
      return { ok: true, status: 200, async json() { return { event: boardEvent }; } };
    }
    return {
      ok: personalStatus === 200,
      status: personalStatus,
      async json() { return { raceStatus }; },
    };
  };
  const api = new Function(
    "document",
    "fetch",
    "globalThis",
    "location",
    `${duckDetailHelpersScript}${liveScript}; return { liveRefreshWork, liveBoardDuckCell };`,
  )(
    document,
    fetchStub,
    { quickDucksLive: { subscribe(options) { subscriptions.push(options); } } },
    { pathname: "/duck/128", reload() { reloads.push("reload"); }, replace(value) { reloads.push(value); } },
  );
  return { api, nodes, personal, requests, subscriptions, reloads };
};

test("the public duck detail page subscribes to the shared live hub and refetches authoritatively", async () => {
  const page = liveDuckPage({
    raceStatus: {
      participantDisplayName: "Jamie R.",
      duck: { visibleNumber: 128 },
      assignedHeat: { roundOne: { number: 7, status: "FINALIZED" }, final: { number: 1, status: "RUNNING" } },
      currentHeat: { round: "FINAL", number: 1, status: "RUNNING" },
      outcome: "ROUND_ONE_WINNER",
    },
  });

  assert.equal(page.subscriptions.length, 1);
  assert.deepEqual(page.subscriptions[0].domains, ["event", "participants", "ducks", "heats"]);
  assert.equal(page.subscriptions[0].root, page.nodes["[data-live-board]"]);

  await page.api.liveRefreshWork();

  // D1 stays authoritative: the refresh refetches both public projections.
  assert.deepEqual(page.requests, ["/api/v1/race-board", "/api/v1/ducks/number/128"]);
  const facts = page.personal.children[0];
  assert.equal(facts.className, "facts");
  assert.deepEqual(facts.children.map((fact) => fact.children.map((part) => part.textContent)), [
    ["Participant", "Jamie R."],
    ["Duck", "Duck #128"],
    ["Round one heat", "Heat 7 · Result official"],
    ["Final heat", "Heat 1 · Racing now"],
    ["Currently running", "Final · Heat 1 · Racing now"],
    ["Race status", "Round one winner"],
    ["Official result", "Won its round-one heat"],
  ]);
});

test("the public duck detail page omits an official result until a heat is finalized", async () => {
  const page = liveDuckPage({
    raceStatus: {
      participantDisplayName: "Jamie R.",
      duck: { visibleNumber: 9 },
      assignedHeat: { roundOne: null, final: null },
      currentHeat: null,
      outcome: "HEAT_ASSIGNMENT_PENDING",
    },
  });

  await page.api.liveRefreshWork();

  assert.deepEqual(page.personal.children[0].children.map((fact) => fact.children.map((part) => part.textContent)), [
    ["Participant", "Jamie R."],
    ["Duck", "Duck #9"],
    ["Round one heat", "Not assigned yet"],
    ["Final heat", "Not in the final"],
    ["Currently running", "No heat is running right now"],
    ["Race status", "Heat assignment pending"],
  ]);
});

test("a duck number that stops resolving clears the page and reloads into the not-found state", async () => {
  const page = liveDuckPage({ personalStatus: 404 });

  await page.api.liveRefreshWork();

  assert.deepEqual(page.reloads, ["reload"]);
  assert.equal(page.nodes.main.children.length, 0);
});

test("live board entries link a visible duck number and stay plain text when unassigned", () => {
  const { api } = liveDuckPage();

  const paired = api.liveBoardDuckCell({ participantDisplayName: "Jamie R.", duckNumber: 128, place: null });
  assert.equal(paired.children.length, 1);
  assert.equal(paired.children[0].tagName, "A");
  assert.equal(paired.children[0].href, "/duck/128");
  assert.equal(nodeText(paired), "Duck #128");

  const placed = api.liveBoardDuckCell({ participantDisplayName: "Jamie R.", duckNumber: 4, place: 1 });
  assert.equal(placed.children[0].href, "/duck/4");
  assert.equal(nodeText(placed), "Duck #4 · 1st place");

  // No duck assigned means no link at all, not an empty or dead one.
  const pending = api.liveBoardDuckCell({ participantDisplayName: "Jamie R.", duckNumber: null, place: null });
  assert.equal(pending.children.length, 0);
  assert.equal(nodeText(pending), "Duck number pending");
  assert.equal(pending.children.some((child) => child.tagName === "A"), false);
});

const participantCards = () => {
  const document = new FakeDocument(false);
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  const api = new Function(
    "document",
    "window",
    "location",
    "fetch",
    `${duckDetailHelpersScript}${participantScript}; return { participantAddRaceFacts };`,
  )(
    document,
    { addEventListener() {} },
    { search: "", pathname: "/my-ducks", hash: "" },
    async () => { throw new Error("offline"); },
  );
  const card = () => document.createElement("article");
  return { ...api, card };
};

test("My Ducks paired cards link the duck number and awaiting cards do not", () => {
  const { participantAddRaceFacts, card } = participantCards();

  const paired = card();
  participantAddRaceFacts(paired, {
    duck: { visibleNumber: 42 },
    assignedHeat: { roundOne: { number: 3, status: "PLANNED" }, final: null },
    currentHeat: null,
    outcome: "NOT_RACED",
  });
  const pairedDuckFact = paired.children[0].children[0];
  assert.deepEqual(pairedDuckFact.children.map((part) => part.tagName), ["DT", "DD"]);
  assert.equal(pairedDuckFact.children[0].textContent, "Duck");
  const link = pairedDuckFact.children[1].children[0];
  assert.equal(link.tagName, "A");
  assert.equal(link.href, "/duck/42");
  assert.equal(link.textContent, "Duck #42");

  const awaiting = card();
  participantAddRaceFacts(awaiting, {
    duck: null,
    assignedHeat: { roundOne: null, final: null },
    currentHeat: null,
    outcome: "AWAITING_DUCK_PAIRING",
  });
  const awaitingDuckFact = awaiting.children[0].children[0];
  assert.equal(awaitingDuckFact.children[1].textContent, "Waiting for duck assignment");
  assert.equal(
    awaitingDuckFact.children.some((part) => part.children.some((child) => child.tagName === "A")),
    false,
  );
});

test("the shared duck-link helper is declared once across the public classic scripts", () => {
  // live.js and participant.js both build duck links, so the declaration lives
  // in the runtime both pages already load rather than in either script.
  assert.match(liveUiScript, /const duckDetailLink =/);
  assert.doesNotMatch(liveScript, /const duckDetailLink =/);
  assert.doesNotMatch(participantScript, /const duckDetailLink =/);
  assert.doesNotThrow(
    () => new Function([liveUiScript, liveScript, searchScript, participantScript].join("\n")),
    "duck-link helpers must not redeclare an existing public global",
  );
  for (const script of [duckDetailHelpersScript, liveScript, participantScript]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  // The public duck views never read or render private material.
  assert.doesNotMatch(duckDetailHelpersScript, /email|phone|lookupCode|privateToken|tagToken|token/i);
});
