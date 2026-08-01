import assert from "node:assert/strict";
import test from "node:test";

import {
  announcerHelpersScript,
  announcerScript,
  confirmationDialogScript,
  duckDetailHelpersScript,
  eventLifecycleHelpersScript,
  eventSlugHelpersScript,
  finishLineScript,
  finishNfcHelpersScript,
  finishScanSerializationScript,
  finishSelectionValidationScript,
  heatBagHelpersScript,
  inventoryIntakeHelpersScript,
  liveBoardStageScript,
  liveScript,
  liveRuntimeHelpersScript,
  liveUiScript,
  ownershipProofHelpersScript,
  participantHandoffHelpersScript,
  participantQrDecoderScript,
  participantQrHelpersScript,
  participantScript,
  podiumPlaceHelpersScript,
  registrationHandoffHelpersScript,
  registrationOwnershipProofHelpersScript,
  registrationScript,
  rosterEligibilityHelpersScript,
  stationStateHelpersScript,
  staffAccessScript,
  staffDuckScript,
  staffHomeScript,
  staffInventoryScript,
  startLineScript,
} from "./client-scripts.ts";
import { isAllowedDuckName } from "./duck-name-filter.ts";
import { DUCK_NAME_ADJECTIVES } from "./duck-name-suggestions.ts";
import { publicHeatStatusLabels, publicOfficialResults } from "./race-status.ts";
import { searchScript } from "./site.ts";

const eventSlugHelpers = () => new Function(
  `${eventSlugHelpersScript}; return { eventSlugFromName };`,
)();

const participantQrHelpers = () => new Function(
  `${participantQrHelpersScript}; return { qrParseParticipantPayload, qrScannerSupported, qrNativeDetection, qrCameraProblem, qrCropFrame };`,
)();

test("participant ownership proofs remain participant-scoped and out of URLs", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const registration = new Function(
    `${registrationOwnershipProofHelpersScript}; return { registrationOwnershipStoreProof };`,
  )();
  const participant = new Function(
    `${ownershipProofHelpersScript}; return { participantOwnershipReadProof, participantOwnershipStoreProof };`,
  )();
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const firstProof = "a".repeat(43);
  const secondProof = "b".repeat(43);

  assert.equal(registration.registrationOwnershipStoreProof(storage, firstId, firstProof), true);
  assert.equal(participant.participantOwnershipStoreProof(storage, secondId, secondProof), true);
  assert.equal(participant.participantOwnershipReadProof(storage, firstId), firstProof);
  assert.equal(participant.participantOwnershipReadProof(storage, secondId), secondProof);
  assert.equal(participant.participantOwnershipReadProof(storage, crypto.randomUUID()), null);
  assert.equal(participant.participantOwnershipStoreProof(storage, firstId, "too-short"), false);
  assert.equal([...values.values()].some((value) => value.includes("/r/") || value.includes("http")), false);

  values.set("quickducks.participant-ownership.v1", "not-json");
  assert.equal(participant.participantOwnershipReadProof(storage, firstId), null);
});

test("the scanner only accepts QuickDucks participant payloads", async () => {
  const { qrParseParticipantPayload } = participantQrHelpers();
  const { participantQrPayload } = await import("./participant-qr.ts");

  // The browser parser must agree exactly with the server encoder.
  assert.equal(qrParseParticipantPayload(participantQrPayload("DAASY234")), "DAASY234");
  assert.equal(qrParseParticipantPayload(" qd1:daasy234 "), "DAASY234");
  // Unrelated codes a camera will inevitably see must be ignored so the console
  // keeps scanning instead of sending them to the pairing command.
  assert.equal(qrParseParticipantPayload("https://quickducks.com/t/" + "a".repeat(32)), null);
  assert.equal(qrParseParticipantPayload("DAASY234"), null);
  assert.equal(qrParseParticipantPayload("QD1:DAISY234"), null);
  assert.equal(qrParseParticipantPayload("QD1:"), null);
  assert.equal(qrParseParticipantPayload(""), null);
  assert.equal(qrParseParticipantPayload(undefined), null);
});

test("camera scanning is offered wherever there is a camera and a secure context", () => {
  const { qrScannerSupported } = participantQrHelpers();
  const supported = {
    isSecureContext: true,
    BarcodeDetector: function BarcodeDetector() {},
    navigator: { mediaDevices: { getUserMedia() {} } },
  };

  assert.equal(qrScannerSupported(supported), true);
  // iOS Safari and Firefox have no BarcodeDetector but do have a camera, and
  // must still be offered scanning through the bundled decoder.
  assert.equal(qrScannerSupported({ ...supported, BarcodeDetector: undefined }), true);
  // Only a missing camera or an insecure context removes the option.
  assert.equal(qrScannerSupported({ ...supported, isSecureContext: false }), false);
  assert.equal(qrScannerSupported({ ...supported, navigator: {} }), false);
  assert.equal(qrScannerSupported({ ...supported, navigator: { mediaDevices: {} } }), false);
});

test("native QR detection is used when usable and declined otherwise", async () => {
  const { qrNativeDetection } = participantQrHelpers();
  const detector = (formats, detect = async () => [{ rawValue: "QD1:DAASY234" }]) => ({
    BarcodeDetector: Object.assign(
      function BarcodeDetector() { return { detect }; },
      { getSupportedFormats: async () => formats },
    ),
  });

  const native = await qrNativeDetection(detector(["qr_code", "ean_13"]));
  assert.equal(typeof native, "function");
  assert.deepEqual(await native({}), [{ rawValue: "QD1:DAASY234" }]);

  // A browser without the API, without QR support, or that throws while
  // probing must fall through to the bundled decoder instead of failing.
  assert.equal(await qrNativeDetection({}), null);
  assert.equal(await qrNativeDetection(detector(["ean_13"])), null);
  assert.equal(await qrNativeDetection({
    BarcodeDetector: Object.assign(function BarcodeDetector() {}, {
      getSupportedFormats: async () => { throw new Error("blocked"); },
    }),
  }), null);
});

test("the bundled decoder loads once, on demand, from a same-origin script", async () => {
  const load = () => {
    const listeners = {};
    const element = {
      addEventListener: (name, handler) => { listeners[name] = handler; },
    };
    const appended = [];
    const scope = {};
    const documentRef = {
      createElement: () => element,
      head: { append: (node) => appended.push(node) },
    };
    const helpers = new Function(
      `${participantQrHelpersScript}${participantQrDecoderScript}; return { qrLoadDecoder };`,
    )();
    return { helpers, element, listeners, appended, scope, documentRef };
  };

  const first = load();
  const pending = first.helpers.qrLoadDecoder(first.documentRef, first.scope);
  assert.equal(first.appended.length, 1);
  assert.equal(first.element.src, "/assets/qr-decoder.js");
  first.scope.jsQR = () => null;
  first.listeners.load();
  assert.equal(await pending, first.scope.jsQR);
  // A second request must reuse the loaded decoder, not inject another tag.
  await first.helpers.qrLoadDecoder(first.documentRef, first.scope);
  assert.equal(first.appended.length, 1);

  // A failed download rejects and is retryable rather than caching failure.
  const second = load();
  const failing = second.helpers.qrLoadDecoder(second.documentRef, second.scope);
  second.listeners.error();
  await assert.rejects(failing, /decoder-unavailable/);
  second.helpers.qrLoadDecoder(second.documentRef, second.scope);
  assert.equal(second.appended.length, 2);
});

test("staff pairing pairs from a scan or an exact code and always keeps a manual path", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  // One shared, guarded pairing command backs every entry point.
  assert.equal(staffDuckScript.match(/\/assignments"/g).length, 1);
  assert.match(staffDuckScript, /const pairWithLookupCode = async \(lookupCode\)/);
  assert.match(staffDuckScript, /commandId: crypto\.randomUUID\(\)/);

  // A scanned participant code pairs without a second confirmation step.
  assert.match(staffDuckScript, /qrParseParticipantPayload\(code\.rawValue\)/);
  assert.match(staffDuckScript, /await pairWithLookupCode\(lookupCode\)/);
  // An exact typed code pairs directly; anything else stays a reviewed list.
  assert.match(staffDuckScript, /body\.exactMatch && body\.exactMatch\.assignedDuckNumber === null/);
  assert.match(staffDuckScript, /await pairWithLookupCode\(body\.exactMatch\.lookupCode\)/);
  assert.match(staffDuckScript, /button\.addEventListener\("click", \(\) => renderSelection\(registration\)\)/);

  // A failed scan invites another attempt or a manual search instead of dead-ending.
  assert.match(staffDuckScript, /not a QuickDucks participant code/);
  assert.match(staffDuckScript, /Scan again, or search for the participant manually/);
  assert.match(staffDuckScript, /data-qr-cancel/);

  // Native detection is preferred, with the bundled decoder as the fallback so
  // iOS Safari and Firefox can scan too.
  assert.match(staffDuckScript, /const native = await qrNativeDetection\(globalThis\)/);
  assert.match(staffDuckScript, /if \(native !== null\) return native/);
  assert.match(staffDuckScript, /await qrLoadDecoder\(document, globalThis\)/);
  assert.match(staffDuckScript, /willReadFrequently: true/);
  // The scan loop must not care which decoder is running.
  assert.match(staffDuckScript, /const codes = await qrDetector\(qrVideo\)/);

  // Pairing publishes a live signal, so the refresh it triggers must keep
  // confirming the staff member's own action instead of replacing it with a
  // generic inspection view.
  assert.match(staffDuckScript, /justPairedCode = result\.participant\.lookupCode/);
  assert.match(staffDuckScript, /participant\.lookupCode === justPairedCode/);
  assert.match(staffDuckScript, /confirmed\s*\n?\s*\? "Duck #" \+ data\.duck\.visibleNumber \+ " paired"/);

  // The camera must be released on every exit path, not just on success.
  assert.match(staffDuckScript, /for \(const track of qrStream\.getTracks\(\)\) track\.stop\(\)/);
  assert.match(staffDuckScript, /addEventListener\("pagehide", qrReleaseCamera\)/);
  assert.match(staffDuckScript, /if \(!document\.hidden \|\| qrStarting\) return;[\s\S]*?qrVisibilityTimer = setTimeout\([\s\S]*?if \(document\.hidden\) qrStop\(\);[\s\S]*?2000\)/);
  // Camera startup begins before decoder loading or the mobile permission
  // prompt, so neither a live refresh nor transient permission visibility can
  // tear it down.
  assert.match(staffDuckScript, /qrStarting = true;[\s\S]*?qrScanning = true;[\s\S]*?await qrCreateDetector\(\)/);
  assert.match(staffDuckScript, /if \(qrStarting \|\| qrScanning\) return;[\s\S]*?currentEvent = eventResponse\.event/);
  assert.match(staffDuckScript, /const qrStop = \(resumeRefresh = true\)[\s\S]*?staffDuckSubscription\?\.resume\(\)/);
  assert.match(staffDuckScript, /qrMessage\.textContent = qrCameraProblem\(error\);\s*staffDuckSubscription\?\.resume\(\)/);
  assert.match(staffDuckScript, /qrVideo\.srcObject = qrStream;\s*\/\/ Permission has settled[\s\S]*?qrStarting = false;\s*qrScheduleHiddenStop\(\);\s*await qrVideo\.play\(\)/);
  assert.match(staffDuckScript, /\} catch \(error\) \{\s*if \(qrStarting \|\| qrScanning\) return;\s*if \(error\.message !== "signed-out"\)/);
  assert.match(staffDuckScript, /isBlocked: \(\) => staffDuckBusy > 0 \|\| selectedRegistration !== null \|\| qrScanning/);

  // Scanning is a convenience over the code, never a new source of truth.
  assert.doesNotMatch(staffDuckScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("the pairing search lists the unpaired by default and puts the keyboard away on Enter", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  // The list is the resting state: opening the pairing work area runs the same
  // search with whatever is typed, which on arrival is nothing.
  assert.match(staffDuckScript, /void runRegistrationSearch\(registrationSearchInput\?\.value \|\| "", false\)/);
  assert.match(
    staffDuckScript,
    /workArea\.hidden = false;[\s\S]*?void runRegistrationSearch\(registrationSearchInput\?\.value \|\| "", false\);/,
  );
  // An empty query is sent as an empty query rather than suppressed.
  assert.match(staffDuckScript, /new URLSearchParams\(\{ eventId: currentEvent\.id, q: query \}\)/);
  assert.equal(staffDuckScript.match(/registrations\/search\?/g).length, 1);
  // Automatic list loads must not mark an already-clean form clean: markClean
  // resumes live subscriptions and would recursively queue the duck load.
  assert.match(
    staffDuckScript,
    /if \(globalThis\.quickDucksLive\.isDirty\(registrationSearchForm\)\) \{\s*globalThis\.quickDucksLive\.markClean\(registrationSearchForm\);/,
  );

  // Typing narrows the same list, debounced, and never fires a pairing command.
  assert.match(staffDuckScript, /registrationSearchInput\.addEventListener\("input", queueRegistrationSearch\)/);
  assert.match(staffDuckScript, /registrationSearchTimer = setTimeout\(\s*\n?\s*\(\) => \{ void runRegistrationSearch\(registrationSearchInput\.value, false\); \}/);
  assert.match(staffDuckScript, /if \(autoPair && body\.exactMatch && body\.exactMatch\.assignedDuckNumber === null\)/);

  // Enter must not submit the form natively, and must drop the soft keyboard.
  assert.match(
    staffDuckScript,
    /const submitRegistrationSearch = \(\) => \{\s*\n\s*if \(!registrationSearchInput\) return;\s*\n\s*clearTimeout\(registrationSearchTimer\);\s*\n\s*registrationSearchInput\.blur\(\);/,
  );
  assert.match(
    staffDuckScript,
    /registrationSearchInput\.addEventListener\("keydown", \(event\) => \{\s*\n\s*if \(event\.key !== "Enter"\) return;\s*\n\s*event\.preventDefault\(\);\s*\n\s*submitRegistrationSearch\(\);/,
  );
  assert.match(
    staffDuckScript,
    /registrationSearchForm\.addEventListener\("submit", \(event\) => \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*submitRegistrationSearch\(\);/,
  );

  // Only unpaired participants are ever drawn, and the browser says so rather
  // than re-deciding it: there is no "already paired with Duck #" row left.
  assert.match(staffDuckScript, /text\("span", contact \+ " · waiting for a duck", "muted"\)/);
  assert.doesNotMatch(staffDuckScript, /already paired with Duck #/);
  assert.doesNotMatch(staffDuckScript, /button\.disabled = registration\.assignedDuckNumber !== null/);
  assert.match(staffDuckScript, /Anyone already paired is not listed here/);
  assert.match(staffDuckScript, /body\.truncated === true/);

  // A slower earlier request must never repaint over a newer one.
  assert.match(staffDuckScript, /const sequence = \+\+registrationSearchSequence/);
  assert.match(staffDuckScript, /if \(sequence !== registrationSearchSequence\) return/);

  assert.doesNotMatch(staffDuckScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("fallback decoding reads a centred, downscaled crop of the camera frame", () => {
  const { qrCropFrame } = participantQrHelpers();
  const calls = [];
  const context = {
    canvas: { width: 0, height: 0 },
    drawImage: (...args) => calls.push(args),
    getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
  };

  // A landscape frame crops to a centred square, then downscales to the target.
  const frame = qrCropFrame({ videoWidth: 1280, videoHeight: 720 }, context, 400);
  assert.deepEqual(calls[0].slice(1), [280, 0, 720, 720, 0, 0, 400, 400]);
  assert.equal(frame.width, 400);
  assert.equal(frame.height, 400);
  assert.equal(context.canvas.width, 400);

  // A frame smaller than the target is never upscaled into wasted work.
  qrCropFrame({ videoWidth: 320, videoHeight: 240 }, context, 400);
  assert.deepEqual(calls[1].slice(1), [40, 0, 240, 240, 0, 0, 240, 240]);
});

test("camera failures explain the fix and always keep manual search available", () => {
  const { qrCameraProblem } = participantQrHelpers();
  const named = (name) => qrCameraProblem(Object.assign(new Error("denied"), { name }));

  assert.match(named("NotAllowedError"), /Allow camera access/);
  assert.match(named("NotFoundError"), /No usable camera/);
  assert.match(named("NotReadableError"), /another app/);
  for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "AbortError", "Whatever"]) {
    assert.match(named(name), /search manually|Cancel and search/);
  }
  // No provider or device detail may reach staff-visible text.
  assert.doesNotMatch(named("NotAllowedError"), /denied/);
});

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
    announcer: announcerScript,
    "finish line": finishLineScript,
    "staff inventory": staffInventoryScript,
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
  assert.doesNotThrow(() => new Function(announcerScript));
  assert.doesNotThrow(() => new Function(finishLineScript));
  assert.doesNotThrow(() => new Function(staffInventoryScript));
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
  assert.match(participantScript, /Show this code to staff at registration table to get your duck!/);
  // The collection's current-assignment projection is the only visibility
  // boundary. Stale duck, heat, or outcome fields must not reveal assigned
  // details while the authoritative paired field says this card is awaiting.
  const unpairedGuard = participantScript.indexOf("if (registration.paired !== true) {");
  const pairedGuard = participantScript.indexOf("if (registration.paired === true) {");
  const raceFactsGuard = participantScript.indexOf("if (registration.paired === true) {", pairedGuard + 1);
  assert.ok(unpairedGuard >= 0);
  assert.ok(pairedGuard > unpairedGuard);
  assert.ok(raceFactsGuard > pairedGuard);
  assert.match(participantScript, /owned\.filter\(\(registration\) => registration\.paired !== true\)/);
  assert.match(participantScript, /owned\.filter\(\(registration\) => registration\.paired === true\)/);
  for (const label of ['"Assigned heat"', '"Race activity"', '"Race status"']) {
    assert.ok(
      participantScript.indexOf(label, raceFactsGuard) > raceFactsGuard,
      `${label} must stay behind the paired guard`,
    );
  }
  assert.match(participantScript, /history\.replaceState/);
  // The just-registered card is scrolled into view but never focused or marked:
  // it must look exactly like it does on a plain refresh.
  assert.match(participantScript, /card\.scrollIntoView/);
  assert.doesNotMatch(participantScript, /card\.focus/);
  assert.doesNotMatch(participantScript, /is-current|Just registered|aria-current/);
  assert.doesNotMatch(participantScript, /duckKeepPreference|duck_keep_preference/);
  for (const script of [searchScript, registrationScript, participantScript]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  assert.match(staffDuckScript, /\/api\/v1\/staff\/ducks/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/registrations\/search/);
  assert.match(staffDuckScript, /registration\.email/);
  assert.match(staffDuckScript, /registration\.phone/);
  // Scanning the duck someone is complaining about reaches the same moderation
  // endpoint the participant console uses, with a command identifier.
  assert.match(staffDuckScript, /\/clear-duck-name/);
  assert.match(staffDuckScript, /commandId: crypto\.randomUUID\(\)/);
  // The control is drawn only when the response carried the participant
  // projection, which the API sends only to the roles that may clear a name.
  assert.match(staffDuckScript, /if \(typeof participant\.registrationId !== "string"\) return;/);
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
  assert.match(staffInventoryScript, /\/api\/v1\/staff\/inventory\/provisioning/);
  assert.match(staffInventoryScript, /provisioning\/classify/);
  assert.match(staffInventoryScript, /provisioning\/confirm/);
  assert.match(staffInventoryScript, /provisioning\/takeover/);
  assert.match(staffInventoryScript, /appConfirm/);
  assert.match(staffInventoryScript, /data-takeover-provisioning/);
  assert.match(staffInventoryScript, /data-end-intake-nfc/);
  assert.match(staffInventoryScript, /new AbortController/);
  assert.match(staffInventoryScript, /scan\(\{ signal: candidateController\.signal \}\)/);
  assert.match(staffInventoryScript, /This duck is already in inventory\. Its record is open below/);
  // Scanning an already-registered duck opens its record rather than only
  // refusing to overwrite it.
  assert.match(staffInventoryScript, /outcome === "already" && typeof duckId === "string"/);
  assert.match(staffInventoryScript, /\/api\/v1\/staff\/inventory\/ducks\//);
  assert.match(staffInventoryScript, /\/delete", commandOptions\("POST"/);
  assert.match(staffInventoryScript, /\/set-duck-name/);
  assert.match(staffInventoryScript, /\/clear-duck-name/);
  // Every command staff can no longer run is gone from the client too.
  assert.doesNotMatch(staffInventoryScript, /tags\/replace|tags\/retire|data-inventory-edit-form/);
  assert.doesNotMatch(staffInventoryScript, /Physical condition|elements\.condition|condition: String/);
  assert.match(staffInventoryScript, /if \(outcome === "added"\)/);
  assert.match(staffInventoryScript, /recordType: "url", data: tagUrl/);
  assert.doesNotMatch(staffInventoryScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(staffInventoryScript, /localStorage|sessionStorage|serviceWorker|makeReadOnly|console\./);
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
  [staffInventoryScript, `if (!await appConfirm(
      "Take over pending Duck #" + candidate.visibleNumber
      + "? Continue only if the previous provisioning station has been abandoned.",
      { danger: true },
    )) return;`],
  [staffInventoryScript, `if (!await appConfirm(
    "Clear this duck's name? It goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;`],
  [staffInventoryScript, 'if (!await appConfirm("Assign Duck #" + selectedDuck.visibleNumber + " to this race entry?")) return;'],
  [staffInventoryScript, 'if (!await appConfirm("Unpair Duck #" + selectedDuck.visibleNumber + " from its participant?", { danger: true })) return;'],
  [staffInventoryScript, 'if (!await appConfirm("Release Duck #" + selectedDuck.visibleNumber + " from this event?", { danger: true })) return;'],
  [staffInventoryScript, `if (!await appConfirm(
    duck.participant
      ? "Delete Duck #" + duck.visibleNumber + "? Its participant goes back into the queue for a new duck, and this duck is gone for good."
      : "Delete Duck #" + duck.visibleNumber + "? It is gone for good.",
    { danger: true, confirmLabel: "Delete duck" },
  )) return;`],
  [staffHomeScript, 'if (!await appConfirm("Run “" + button.textContent + "” for " + event.name + "?")) return;'],
  [staffHomeScript, 'if (dangerous && !await appConfirm(label + " for " + selectedRegistration.firstName + " " + selectedRegistration.lastName + "?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Reactivate this participant?")) return;'],
  [staffHomeScript, 'if (!await appConfirm(action + "? Read back: " + readback + ". This changes the public result immediately.", { danger: mode === "correct" })) return;'],
  [staffHomeScript, 'if (!await appConfirm(confirmation)) return;'],
  [staffHomeScript, `if (!await appConfirm(
        "Reset this heat to Loading? Its locked roster and lock details will remain. Start and finish progress and any unsubmitted result entry will be cleared.",
        { danger: true, confirmLabel: "Reset Heat" },
      )) return;`],
  [staffHomeScript, 'if (!await appConfirm("Reopen this published result and remove downstream finalist promotion when applicable?", { danger: true })) return;'],
  [staffHomeScript, 'if (!await appConfirm(label + " this notification?", { danger: action !== "retry" })) return;'],
  [staffHomeScript, 'if (!await appConfirm("Permanently delete the registration for " + registration.firstName + " " + registration.lastName + "? This removes the participant and their race entry. This cannot be undone.", { danger: true })) return;'],
  [staffHomeScript, `if (!await appConfirm(
    "Clear the duck name chosen by " + registration.firstName + " " + registration.lastName
    + "? The duck goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;`],
  [staffDuckScript, `if (!await appConfirm(
    "Clear this duck's chosen name? It goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;`],
  [staffDuckScript, `if (!await appConfirm(
      "Mark Duck #" + data.duck.visibleNumber + " as the official Heat " + candidate.heatNumber + " winner? This publishes immediately.",
      { danger: true, confirmLabel: "Mark winner" },
    )) return;`],
  // Recording a podium place says which place, and says whether this one
  // publishes the final. The staffer is pressing one of three near-identical
  // buttons, so the read-back is the only thing standing between a mis-tap and
  // a wrong official result.
  [staffDuckScript, `if (!await appConfirm(
    "Record " + duckLabel + " as " + podiumPlaceLabel(place) + " in the final?"
      + (lastPlace
        ? " That is the last place, so this publishes the official podium immediately."
        : " You can clear this place by scanning this duck again."),
    { danger: true, confirmLabel: "Record " + podiumPlaceLabel(place) },
  )) return;`],
  [staffDuckScript, `if (!await appConfirm(
    "Clear " + duckLabel + " from " + podiumPlaceLabel(place) + " in the final?"
      + " That place goes back to being open for the next duck scanned.",
    { danger: true, confirmLabel: "Clear " + podiumPlaceLabel(place) },
  )) return;`],
  [finishLineScript, `if (!await appConfirm(
    "Clear " + label + " from Duck #" + placement.visibleNumber + "? That place goes back to being open"
      + " for the next duck scanned.",
    { danger: true, confirmLabel: "Clear " + label },
  )) return;`],
  [finishLineScript, `if (!await appConfirm(
    "Publish this podium now? Read back: " + readback + ". This publishes immediately.",
    { danger: true, confirmLabel: "Publish podium" },
  )) return;`],
  // The last-resort manual winner. It publishes an official result immediately,
  // exactly like the scan it stands in for, so it is confirmed exactly like one
  // — and the read-back names the duck, the racer, and the heat, because the
  // staffer picked this one out of a dropdown rather than holding it.
  [finishLineScript, `if (!await appConfirm(
    "Record " + duckLabel + " (" + who + ") as the official Heat " + heatNumber + " winner?"
      + " Use this only because that duck's tag could not be scanned. This publishes immediately.",
    { danger: true, confirmLabel: "Record winner" },
  )) return;`],
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
  // Submitting a podium the station assembled itself, clearing a place that was
  // scanned into one, publishing a scanned podium a withdrawal completed, and
  // the last-resort manual winner. The fourth one publishes an official result
  // from a dropdown instead of from a duck in the staffer's hand, which is the
  // callsite here that most needs a read-back before it commits.
  assert.equal((finishLineScript.match(/\bappConfirm\(/g) ?? []).length, 4);
  // Inventory owns takeover, clearing a duck name, assign, unpair, release,
  // and delete duck. Every one of them is destructive or irreversible.
  assert.equal((staffInventoryScript.match(/\bappConfirm\(/g) ?? []).length, 6);
  // Delete event owns its typed-name modal, while the remaining console
  // mutations use the shared confirmation dialog.
  assert.equal((staffHomeScript.match(/\bappConfirm\(/g) ?? []).length, 10);
  assert.equal((staffAccessScript.match(/\bappConfirm\(/g) ?? []).length, 1);
  // The staff duck scan confirms name moderation, round-one winner
  // publication, and both directions of a final podium place.
  assert.equal((staffDuckScript.match(/\bappConfirm\(/g) ?? []).length, 4);
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
    announcerScript,
    finishLineScript,
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
    announcerScript,
    finishLineScript,
    ]) assert.doesNotMatch(script, /\b(?:window\.)?confirm\s*\(/);
});

// The announcer is read-only, so it must never grow a confirmation prompt: a
// prompt would mean it had acquired something to confirm.
test("the announcer client has no confirmation dialog because it has nothing to confirm", () => {
  assert.doesNotMatch(announcerScript, /\bappConfirm\(/);
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

// The inventory page itself is not device gated: it lists ducks and runs every
// inventory command anywhere. Only the scanning station is conditional, and a
// spoofed Android user agent without Web NFC must leave it shut and silent.
test("spoofed Android user agent without Web NFC keeps the station shut and calls no provisioning API", () => {
  const runtimeNotice = { hidden: true };
  const runtimeMessage = { textContent: "" };
  const controls = { hidden: true };
  const stub = () => ({
    hidden: false,
    dataset: {},
    classList: { toggle() {} },
    elements: {},
    children: [],
    textContent: "",
    style: {},
    addEventListener() {},
    append() {},
    replaceChildren() {},
    querySelector: () => stub(),
    querySelectorAll: () => [],
    focus() {},
    reset() {},
  });
  const root = stub();
  root.dataset.appOrigin = "https://quickducks.com";
  const elements = new Map([
    ["[data-intake-runtime]", runtimeNotice],
    ["[data-intake-runtime-message]", runtimeMessage],
    ["[data-intake-controls]", controls],
    ["[data-staff-inventory]", root],
  ]);
  const document = {
    visibilityState: "visible",
    querySelector: (selector) => elements.get(selector) ?? stub(),
    querySelectorAll: () => [],
    createElement: () => stub(),
    body: { append: () => {} },
  };
  const window = {};
  window.top = window;
  window.self = window;
  const requests = [];

  new Function(
    "document", "navigator", "window", "isSecureContext", "fetch", "location", "globalThis", "Option",
    staffInventoryScript,
  )(
    document,
    { userAgent: androidChromeUserAgent },
    window,
    true,
    (url) => {
      requests.push(String(url));
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ events: [] }) });
    },
    { search: "", pathname: "/staff/inventory", assign() {} },
    {
      quickDucksLive: {
        beginBusy: () => () => {},
        markClean() {},
        subscribe: () => ({ resume() {} }),
      },
    },
    function Option() {},
  );

  assert.equal(controls.hidden, true, "the station controls stay shut");
  assert.equal(runtimeNotice.hidden, false);
  assert.match(runtimeMessage.textContent, /does not expose Web NFC/);
  assert.equal(requests.some((url) => url.includes("/provisioning")), false, "no provisioning API is touched");
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
      classify: async ({ tagUrl }) => tagUrl === knownUrl
        ? { kind: "already", duckId: "duck-known" }
        : { kind: "reusable" },
    });
    // The identifier of the duck already in inventory travels back with the
    // verdict, which is what lets the page open its record.
    assert.deepEqual(
      await current.machine.reading({ serialNumber: entry.name, canonicalUrls: entry.urls }),
      { accepted: true, outcome: "already", duckId: "duck-known" },
      entry.name,
    );
    assert.deepEqual(current.calls.classifications.map(({ tagUrl }) => tagUrl), entry.classified, entry.name);
    assert.deepEqual(current.calls.starts, [], entry.name);
    assert.deepEqual(current.calls.writes, [], entry.name);
    assert.deepEqual(current.calls.confirms, [], entry.name);
    assert.deepEqual(current.calls.accepted, [{ outcome: "already", duckId: "duck-known" }], entry.name);
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
  const active = makeProvisioningMachine({
    classify: async () => ({ kind: "already", duckId: "duck-known" }),
  });
  assert.deepEqual(
    await active.machine.reading({ serialNumber: "active", canonicalUrls: [active.pending.tagUrl] }),
    { accepted: true, outcome: "already", duckId: "duck-known" },
  );
  assert.equal(active.calls.starts.length, 0);
  assert.equal(active.calls.writes.length, 0);
  assert.equal(active.calls.confirms.length, 0);
  assert.deepEqual(active.calls.accepted, [{ outcome: "already", duckId: "duck-known" }]);
  assert.equal(active.calls.accepted.some(({ outcome }) => outcome === "added"), false);
  assert.equal(active.calls.ready.length, 0);
  assert.equal(active.calls.states.at(-1), "ready");
  assert.match(active.calls.messages.at(-1)[0], /already in inventory/);

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
    announcerScript,
    finishLineScript,
      staffHomeScript,
    staffDuckScript,
  ]) {
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(script, /quickDucksLive\.subscribe/);
  }
  for (const script of [liveUiScript, participantScript, liveScript, startLineScript, announcerScript, finishLineScript]) {
    assert.doesNotMatch(script, /setInterval/);
  }
  for (const script of [participantScript, liveScript, startLineScript, announcerScript, finishLineScript]) {
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
  // The announcer only ever reads: the roster to call up and the results the
  // finish line has already published.
  assert.match(announcerScript, /announcer-roster/);
  assert.doesNotMatch(announcerScript, /\/results\/finalize|\/lock|\/ready|\/call|\/start\b|\/finish\b/);
  assert.match(finishLineScript, /NDEFReader/);
  assert.match(finishLineScript, /That duck is already selected/);
  assert.match(finishLineScript, /That duck is not in the selected heat/);
  assert.match(finishLineScript, /finishSelected\.length !== finishRequiredPlaces/);
  assert.match(finishLineScript, /\/results\/finalize/);
});

test("heat controls use the exact flow labels and gate the race-director reset", () => {
  for (const script of [startLineScript, staffHomeScript]) {
    assert.match(script, /LOADING: \["ready", "Mark Heat Ready"\]/);
    assert.match(script, /READY: \["call", "Heat Has Been Announced"\]/);
    assert.match(script, /CALLING: \["start", "Start This Heat"\]/);
    assert.doesNotMatch(script, /Mark heat ready|Call this heat|Start this heat|Mark ready|Call heat|Start heat/);
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  assert.equal(publicHeatStatusLabels.CALLING, "Heat has been announced");

  const source = staffHomeScript.match(/const heatResetAllowed = \(heat\) => [\s\S]*?;\n/)?.[0];
  assert.ok(source, "the console defines the heat reset visibility gate");
  const allowedFor = (canDirectRace) => new Function(
    "canDirectRace",
    `${source}\nreturn heatResetAllowed;`,
  )(canDirectRace);
  const resettable = {
    status: "READY",
    rosterLocked: true,
    rosterSize: 3,
    publishedResultCount: 0,
  };
  for (const status of ["READY", "CALLING", "RUNNING", "AWAITING_RESULT"]) {
    assert.equal(allowedFor(true)({ ...resettable, status }), true, status);
    assert.equal(allowedFor(false)({ ...resettable, status }), false, `non-director ${status}`);
  }
  for (const status of ["PLANNED", "LOADING", "FINALIZED", "CANCELLED"]) {
    assert.equal(allowedFor(true)({ ...resettable, status }), false, status);
  }
  assert.equal(allowedFor(true)({ ...resettable, rosterLocked: false }), false);
  assert.equal(allowedFor(true)({ ...resettable, rosterSize: 0 }), false);
  assert.equal(allowedFor(true)({ ...resettable, publishedResultCount: 1 }), false);

  assert.match(staffHomeScript, /text\("button", "Reset Heat", "button danger small"\)/);
  assert.match(
    staffHomeScript,
    /encodeURIComponent\(selectedHeat\.id\) \+ "\/reset"/,
  );
  assert.match(staffHomeScript, /commandOptions\("POST", \{ commandId: crypto\.randomUUID\(\), revision: selectedHeat\.revision \}\)/);
  assert.match(staffHomeScript, /\{ danger: true, confirmLabel: "Reset Heat" \}/);
  assert.match(staffHomeScript, /locked roster and lock details will remain/);
  assert.match(staffHomeScript, /unsubmitted result entry will be cleared/);
  assert.match(staffHomeScript, /await loadHeats\(\);/);

  // A reset publishes a heat refresh. The finish station must accept it even
  // with a reviewed selection, then clear that selection on the new revision.
  assert.match(
    finishLineScript,
    /if \(changedHeatContext\) \{\s*finishSelected = \[\];\s*finishClearIneligible\(\);\s*\}/,
  );
  assert.match(finishLineScript, /isBlocked: \(\) => finishScanBusy \|\| finishCommandBusy/);
  assert.doesNotMatch(finishLineScript, /isBlocked: \(\) =>[^\n]*finishSelected/);
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
  announcerScript,
  finishLineScript,
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
  for (const script of [liveScript, participantScript, startLineScript, announcerScript, finishLineScript]) {
    assert.doesNotMatch(script, /status:\s*\(status\)/);
  }
});

test("hard failures stay visible through error-only lines and station message lines", () => {
  // Stations keep their own actionable operational message line.
  assert.match(startLineScript, /data-station-message/);
  assert.match(startLineScript, /if \(error\.message !== "signed-out"\) startMessage\.textContent = error\.message;/);
  assert.match(finishLineScript, /data-station-message/);
  assert.match(finishLineScript, /if \(error\.message !== "signed-out"\) finishMessage\.textContent = error\.message;/);
  assert.match(staffInventoryScript, /data-intake-message/);

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
    this.selectCalls = 0;
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

  select() {
    this.selectCalls += 1;
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

  createElementNS(namespace, tagName) {
    const node = new QuickNode(tagName);
    node.namespaceURI = namespace;
    return node;
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
    subscribe(subscriber) {
      subscriptions.push(subscriber);
      return { refresh: subscriber.refresh };
    },
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

  const dirtyInput = harness.document.createElement("input");
  dirtyInput.dataset.liveDirty = "true";
  harness.form.append(dirtyInput);
  await harness.form.dispatch("submit");
  assert.equal(
    harness.requests.filter((item) => item.url.startsWith("/api/v1/race-status/search")).length,
    1,
    "one submit must spend only one public-search request",
  );
  assert.equal(harness.cleaned.length, 0, "an already-completed search must not queue itself again");
  assert.equal(dirtyInput.dataset.liveDirty, undefined, "the submitted query must allow later live refreshes");
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

test("an authoritative search refresh clears stale cards into the no-results state", async () => {
  let results = [
    searchResult(),
    searchResult({ followId: "22222222-2222-4222-8222-222222222222" }),
  ];
  const harness = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    return Response.json({ results });
  });

  await harness.form.dispatch("submit");
  assert.equal(harness.results.children.length, 2, "same-name identities render independently");
  assert.equal(harness.message.textContent, "2 matches found.");
  assert.equal(
    harness.requests.filter((item) => item.url.startsWith("/api/v1/race-status/search")).length,
    1,
  );

  // Registration, follow, unfollow, and live updates all converge through this
  // server refetch; no name-based or cached membership assumption is retained.
  results = [];
  await harness.subscriptions[0].refresh();
  assert.equal(harness.results.children.length, 0);
  assert.equal(harness.message.textContent, "No matching public race status was found.");
  assert.equal(
    harness.requests.filter((item) => item.url.startsWith("/api/v1/race-status/search")).length,
    2,
    "one later live refresh must issue one new authoritative search",
  );
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

test("a search result replaces the generic label with the chosen duck name", async () => {
  const named = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    return Response.json({
      results: [searchResult({
        duck: { visibleNumber: 12 },
        duckName: "Sir Quacks-a-Lot",
        assignedHeat: { roundOne: { number: 3, status: "PLANNED" }, final: null },
        outcome: "NOT_RACED",
      })],
    });
  });
  await named.form.dispatch("submit");
  assert.equal(
    named.results.children[0].children[1].textContent,
    "Sir Quacks-a-Lot · Heat 3 · not raced",
  );

  // No name, or one the server's read-time filter suppressed, leaves the number
  // exactly as it was.
  const plain = homeHarness((url) => {
    if (url.startsWith("/api/v1/events/current")) return currentEventResponse();
    return Response.json({
      results: [searchResult({
        duck: { visibleNumber: 12 },
        duckName: null,
        assignedHeat: { roundOne: { number: 3, status: "PLANNED" }, final: null },
        outcome: "NOT_RACED",
      })],
    });
  });
  await plain.form.dispatch("submit");
  assert.equal(plain.results.children[0].children[1].textContent, "Duck #12 · Heat 3 · not raced");
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

const myDucksHarness = (route, search = "", confirmResult = true, localStorage) => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  navigation.dataset.phaseVisible = "true";
  navigation.hidden = false;
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
  const followed = participantSection(document, "followed");
  page.append(error, success, empty, awaiting.section, paired.section, followed.section);
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
  const cleaned = [];
  const appConfirm = async (message, options) => {
    confirmations.push({ message, options });
    return confirmResult;
  };

  new Function(
    "document", "location", "window", "globalThis", "requestAnimationFrame", "history", "fetch",
    "appConfirm",
    // `duckDetailLink` ships in live-ui.js, which every page loads first, so the
    // page client receives it from the shared classic scope.
    [duckDetailHelpersScript, participantScript].join("\n"),
  )(
    document,
    { search, pathname: "/my-ducks", hash: "", origin: "https://quickducks.com" },
    { addEventListener() {} },
    {
      localStorage,
      quickDucksLive: {
        beginBusy() {
          busy.push("begin");
          return () => busy.push("end");
        },
        markClean(root) { cleaned.push(root); },
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
    cleaned,
    confirmations,
    document,
    empty,
    error,
    followed,
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
  // Drawing geometry as the projection sends it. The path is a real, if tiny,
  // run of the encoder's own output alphabet.
  qr: { size: 29, path: "M4 4h7v1h-7zM12 4h1v1h-1z" },
  followed: false,
  registrationStatus: "SUBMITTED",
  paired,
  duckName: null,
  nameable: false,
  raceStatus: null,
  ...overrides,
});

// The exact shape the server projects for a followed link: no first or last
// name, no lookup code, no duck name, and never a naming or delete permission.
const followedEntry = (registrationId, overrides = {}) => collected(registrationId, false, {
  firstName: null,
  lastName: null,
  displayName: "Donald M.",
  lookupCode: null,
  qr: null,
  duckName: null,
  nameable: false,
  followed: true,
  ...overrides,
});

const pairedStatus = (visibleNumber = 12) => ({
  event: { id: "event-1", slug: "race", name: "Race", eventDate: null, status: "ROUND_ONE" },
  participantDisplayName: "Daisy D.",
  duck: { visibleNumber },
  duckName: null,
  assignedHeat: { roundOne: { number: 3, status: "PLANNED" }, final: null },
  currentHeat: null,
  outcome: "NOT_RACED",
});

const unfollowButton = (card) => card.descendants()
  .find((node) => node.tagName === "BUTTON" && node.dataset.unfollowRegistration !== undefined) ?? null;

const nameForm = (card) => card.descendants()
  .find((node) => node.tagName === "FORM" && node.dataset.duckNameForm !== undefined) ?? null;

const nameToggle = (card) => card.descendants()
  .find((node) => node.tagName === "BUTTON" && node.dataset.duckNameToggle !== undefined) ?? null;

const suggestButton = (card) => card.descendants()
  .find((node) => node.tagName === "BUTTON" && node.dataset.duckNameSuggest !== undefined) ?? null;

const duckFact = (card) => card.descendants()
  .find((node) => node.className === "fact" && node.children[0]?.textContent === "Duck") ?? null;

const renderMyDucks = async (registrations) => {
  const harness = myDucksHarness(() => Response.json({ registrations }));
  assert.equal(harness.subscriptions.length, 1);
  await harness.subscriptions[0].refresh();
  return harness;
};

const deleteButton = (card) => card.descendants()
  .find((node) => node.tagName === "BUTTON" && node.dataset.deleteRegistration !== undefined) ?? null;

test("saving contact details keeps the owned card while the authoritative refresh verifies them", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const proof = "P".repeat(43);
  const storage = {
    getItem(key) {
      return key === "quickducks.participant-ownership.v1"
        ? JSON.stringify({ [registrationId]: proof })
        : null;
    },
    setItem() {},
  };
  let contact = {
    registrationId,
    email: "owned.contact@example.test",
    phone: "+15550107777",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
    revision: 0,
  };
  const harness = myDucksHarness((url, options) => {
    if (url === "/api/v1/registrations/mine") {
      return Response.json({ registrations: [collected(registrationId, false)] });
    }
    if (options.method === "PATCH") {
      const update = JSON.parse(options.body);
      contact = {
        registrationId,
        email: update.email,
        phone: update.phone,
        emailNotificationsEnabled: update.emailNotificationsEnabled,
        smsNotificationsEnabled: update.smsNotificationsEnabled,
        revision: 1,
      };
      return Response.json({ ...contact, replayed: false });
    }
    return Response.json(contact);
  }, "", true, storage);
  await harness.subscriptions[0].refresh();

  const originalCard = harness.awaiting.track.children[0];
  const originalPanel = originalCard.querySelector("[data-contact-panel]");
  await originalCard.querySelector("[data-contact-edit]").dispatch("click");
  const form = originalCard.querySelector("[data-contact-form]");
  const input = (name) => form.descendants().find((node) => node.name === name);
  input("email").value = "owned.updated@example.test";
  input("phone").value = "+15550108888";
  input("emailNotificationsEnabled").checked = true;
  input("smsNotificationsEnabled").checked = true;
  await form.dispatch("submit");

  assert.equal(harness.awaiting.track.children[0], originalCard);
  assert.ok(originalCard.descendants().includes(originalPanel));
  assert.match(originalPanel.text(), /Email: owned\.updated@example\.test/);
  assert.match(originalPanel.text(), /Phone: \+15550108888/);
  assert.match(originalPanel.text(), /Email updates: Opted in/);
  assert.match(originalPanel.text(), /SMS updates: Opted in/);
  assert.equal(originalPanel.querySelector("[data-contact-form]").hidden, true);

  // Ending the live busy period queues this read in the browser. The response
  // is authoritative, but because it confirms the mutation it must not detach
  // the card a Playwright/user interaction is still observing.
  await harness.subscriptions[0].refresh();
  assert.equal(harness.awaiting.track.children[0], originalCard);
  assert.match(originalPanel.text(), /Email: owned\.updated@example\.test/);
});

test("an empty participant group normally hides its whole section instead of an empty state", async () => {
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
  assert.equal(harness.navigation.hidden, false);
});

test("open registration keeps the empty awaiting heading and registration action area", async () => {
  const harness = myDucksHarness(() => Response.json({ registrations: [] }));
  harness.awaiting.section.dataset.keepEmpty = "true";
  await harness.subscriptions[0].refresh();

  assert.equal(harness.awaiting.section.hidden, false);
  assert.equal(harness.awaiting.track.hidden, true);
  assert.equal(harness.awaiting.controls.hidden, true);
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
    followedEntry("22222222-2222-4222-8222-222222222222"),
  ]);

  // Registered-on-this-device and followed are different things, so they live
  // in different sections rather than being mixed by pairing state alone.
  const [owned] = harness.awaiting.track.children;
  const [followed] = harness.followed.track.children;
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
    followedEntry("33333333-3333-4333-8333-333333333333", { deletable: true }),
    // Paired entries live in the other section and are never removable.
    collected("44444444-4444-4444-8444-444444444444", true, { deletable: false }),
  ]);

  const [removable, notRemovable] = harness.awaiting.track.children;
  const [paired] = harness.paired.track.children;
  const [followed] = harness.followed.track.children;
  assert.ok(deleteButton(removable), "an own removable entry offers deletion");
  assert.equal(deleteButton(removable).className, "button danger small");
  assert.equal(deleteButton(removable).textContent, "Delete registration");
  assert.equal(deleteButton(notRemovable), null);
  assert.equal(deleteButton(followed), null, "a followed entry is someone else's registration");
  assert.equal(deleteButton(paired), null);
  // Removing a followed entry is a separate, non-destructive action: it never
  // reuses or renames the registration delete.
  assert.doesNotMatch(followed.text(), /Delete registration/);
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

test("the just-registered notice names the participant without highlighting the card", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  const harness = myDucksHarness(
    () => Response.json({ registrations: [collected(registrationId, false)] }),
    `?registered=${registrationId}`,
  );

  await harness.subscriptions[0].refresh();

  assert.equal(harness.awaiting.section.hidden, false);
  // The notice is the one-time affordance: it names the participant so the
  // private status link beside it is unambiguous, and it never sends the visitor
  // looking for a highlight that no longer exists.
  assert.equal(harness.success.hidden, false);
  assert.match(harness.success.text(), /Registration saved\./);
  assert.match(harness.success.text(), /Daisy Duck\./);
  assert.doesNotMatch(harness.success.text(), /highlighted/);

  // The card is byte-for-byte the plain-refresh card: no highlight class, no
  // "Just registered" pill, no aria-current, and no stolen focus.
  const card = harness.awaiting.track.children[0];
  assert.equal(card.className, "duck-card participant-card");
  assert.equal(card.getAttribute("aria-current"), null);
  assert.equal(card.tabIndex, 0, "the card must not be made programmatically focusable");
  assert.equal(card.focusCalls, 0);
  assert.doesNotMatch(card.text(), /Just registered/);
  assert.equal(card.children.filter((child) => child.className === "success-tag").length, 0);
  // Scrolling the new card into view is kept: it is orientation, not emphasis.
  assert.equal(card.scrollCalls, 1);

  const plain = await renderMyDucks([collected(registrationId, false)]);
  assert.equal(plain.awaiting.track.children[0].className, card.className);
  assert.equal(plain.awaiting.track.children[0].text(), card.text());
});

test("the card of a just-registered participant stays plain once staff pair it", async () => {
  const registrationId = "11111111-1111-4111-8111-111111111111";
  let registrations = [collected(registrationId, false)];
  const harness = myDucksHarness(
    () => Response.json({ registrations }),
    `?registered=${registrationId}`,
  );
  await harness.subscriptions[0].refresh();

  // Staff pair the duck; the live refresh regroups the card into My Ducks.
  registrations = [collected(registrationId, true, { nameable: true, raceStatus: pairedStatus() })];
  await harness.subscriptions[0].refresh();

  const [card] = harness.paired.track.children;
  assert.equal(harness.awaiting.track.children.length, 0);
  assert.equal(card.className, "duck-card participant-card");
  assert.equal(card.getAttribute("aria-current"), null);
  assert.doesNotMatch(card.text(), /Just registered/);

  const plain = await renderMyDucks([
    collected(registrationId, true, { nameable: true, raceStatus: pairedStatus() }),
  ]);
  assert.equal(plain.paired.track.children[0].className, card.className);
});

test("a followed participant keeps its Following pill", async () => {
  const harness = await renderMyDucks([followedEntry("33333333-3333-4333-8333-333333333333")]);
  const [card] = harness.followed.track.children;

  assert.equal(card.children[0].className, "success-tag");
  assert.equal(card.children[0].textContent, "Following");
});

test("My Ducks separates own unpaired, own paired, and followed participants", async () => {
  const harness = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false),
    collected("22222222-2222-4222-8222-222222222222", true, { nameable: true, raceStatus: pairedStatus() }),
    // A followed entry stays in the followed section whether or not its
    // participant has been paired with a duck.
    followedEntry("33333333-3333-4333-8333-333333333333", { paired: true, raceStatus: pairedStatus(88) }),
  ]);

  assert.equal(harness.awaiting.track.children.length, 1);
  assert.equal(harness.paired.track.children.length, 1);
  assert.equal(harness.followed.track.children.length, 1);
  for (const section of [harness.awaiting, harness.paired, harness.followed]) {
    assert.equal(section.section.hidden, false);
    assert.equal(section.controls.hidden, false);
  }
  assert.equal(harness.empty.hidden, true);

  // Own entries carry their full detail; the followed one carries only the
  // public projection.
  const [ownUnpaired] = harness.awaiting.track.children;
  const [ownPaired] = harness.paired.track.children;
  const [followed] = harness.followed.track.children;
  assert.match(ownUnpaired.text(), /Staff lookup code: DAISY123/);
  assert.match(ownPaired.text(), /Staff lookup code: DAISY123/);
  assert.doesNotMatch(followed.text(), /DAISY123|lookup code:/i);

  // Only the owner's paired card offers naming, and only the followed card
  // offers unfollowing.
  assert.equal(nameForm(ownUnpaired), null, "there is no duck to name yet");
  assert.ok(nameForm(ownPaired), "a paired own entry can be named");
  assert.equal(nameForm(followed), null, "a followed duck belongs to someone else");
  assert.equal(unfollowButton(ownUnpaired), null);
  assert.equal(unfollowButton(ownPaired), null);
  assert.ok(unfollowButton(followed), "a followed entry can be removed from this list");
  assert.equal(unfollowButton(followed).className, "button secondary small");
  assert.equal(unfollowButton(followed).textContent, "Stop following");

  // An empty followed group hides its own section like the other two.
  const ownOnly = await renderMyDucks([collected("11111111-1111-4111-8111-111111111111", false)]);
  assert.equal(ownOnly.followed.section.hidden, true);
  assert.equal(ownOnly.followed.track.children.length, 0);
});

test("the owner's card replaces the generic label with the chosen duck name", async () => {
  const harness = await renderMyDucks([
    collected("22222222-2222-4222-8222-222222222222", true, {
      nameable: true,
      duckName: "Sir Quacks-a-Lot",
      raceStatus: pairedStatus(12),
    }),
  ]);

  const [card] = harness.paired.track.children;
  const fact = duckFact(card);
  const value = fact.children[1];
  const link = value.children[0];
  assert.equal(link.tagName, "A");
  assert.equal(link.className, "duck-number-link");
  assert.equal(link.textContent, "Sir Quacks-a-Lot", "the chosen name replaces Duck #12");
  assert.equal(link.href, "/duck/12", "the link still points at the public duck page");
  assert.equal(
    value.children.some((child) => child.className === "duck-number-note"),
    false,
    "the generic Duck #12 label is completely replaced",
  );
  assert.doesNotMatch(value.text(), /Duck #12/);
  // Renaming lives with the duck's identity: the control is a Rename button in
  // this same fact, and the field it reveals starts folded away and pre-filled.
  const toggle = nameToggle(card);
  assert.ok(value.descendants().includes(toggle), "the Rename button belongs to the Duck fact");
  assert.equal(toggle.textContent, "Rename");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  const form = nameForm(card);
  assert.equal(form.hidden, true, "the field stays folded away until Rename is pressed");
  assert.equal(toggle.getAttribute("aria-controls"), form.id);
  const input = form.descendants().find((node) => node.tagName === "INPUT");
  assert.equal(input.value, "Sir Quacks-a-Lot");
  assert.match(form.text(), /replaces the generic duck number on public race status/);
  assert.match(form.text(), /race staff can remove a name that is not/);
});

test("an unnamed duck offers naming rather than renaming", async () => {
  const harness = await renderMyDucks([
    collected("22222222-2222-4222-8222-222222222222", true, {
      nameable: true,
      duckName: null,
      raceStatus: pairedStatus(12),
    }),
  ]);

  const [card] = harness.paired.track.children;
  assert.equal(nameToggle(card).textContent, "Name this duck");
  const input = nameForm(card).descendants().find((node) => node.tagName === "INPUT");
  assert.equal(input.value, "");
});

test("the Rename button reveals the field, and Cancel folds it away again", async () => {
  const harness = await renderMyDucks([
    collected("22222222-2222-4222-8222-222222222222", true, {
      nameable: true,
      duckName: "Sir Quacks-a-Lot",
      raceStatus: pairedStatus(12),
    }),
  ]);

  const [card] = harness.paired.track.children;
  const toggle = nameToggle(card);
  const form = nameForm(card);
  const input = form.descendants().find((node) => node.tagName === "INPUT");

  await toggle.dispatch("click");
  assert.equal(form.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(input.focusCalls, 1, "the field takes focus so the keyboard opens");
  assert.equal(input.selectCalls, 1, "the existing name is selected, ready to be replaced");

  input.value = "A Draft Nobody Kept";
  const cancel = form.descendants()
    .find((node) => node.tagName === "BUTTON" && node.textContent === "Cancel");
  await cancel.dispatch("click");
  assert.equal(form.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(input.value, "Sir Quacks-a-Lot", "cancelling discards the draft");
  assert.equal(toggle.focusCalls, 1, "focus returns to the button that opened the field");
  assert.equal(harness.cleaned.at(-1), form, "the abandoned edit stops deferring live refreshes");
  assert.equal(harness.requests.some((item) => item.url.includes("duck-name")), false);
});

// The open editor has to survive a background repaint: My Ducks rebuilds every
// card whenever the collection response changes, and folding the field away
// mid-edit would look like the site had thrown the name away.
test("an open name field stays open across a live refresh", async () => {
  const registrationId = "22222222-2222-4222-8222-222222222222";
  let heatStatus = "PLANNED";
  const harness = myDucksHarness(() => Response.json({
    registrations: [collected(registrationId, true, {
      nameable: true,
      duckName: null,
      raceStatus: {
        ...pairedStatus(12),
        assignedHeat: { roundOne: { number: 3, status: heatStatus }, final: null },
      },
    })],
  }));
  await harness.subscriptions[0].refresh();

  await nameToggle(harness.paired.track.children[0]).dispatch("click");
  assert.equal(nameForm(harness.paired.track.children[0]).hidden, false);

  heatStatus = "RUNNING";
  await harness.subscriptions[0].refresh();
  const repainted = harness.paired.track.children[0];
  assert.equal(nameForm(repainted).hidden, false, "the repainted card keeps the field open");
  assert.equal(nameToggle(repainted).getAttribute("aria-expanded"), "true");
});

test("Suggest a name fills the field with a name the endpoint would accept", async () => {
  const harness = await renderMyDucks([
    collected("22222222-2222-4222-8222-222222222222", true, {
      nameable: true,
      duckName: null,
      raceStatus: pairedStatus(12),
    }),
  ]);

  const [card] = harness.paired.track.children;
  const form = nameForm(card);
  const input = form.descendants().find((node) => node.tagName === "INPUT");
  const suggest = suggestButton(card);
  assert.equal(suggest.type, "button");
  assert.equal(suggest.textContent, "Suggest a name");

  const seen = new Set();
  for (let press = 0; press < 25; press += 1) {
    const previous = input.value;
    await suggest.dispatch("click");
    assert.notEqual(input.value, previous, "pressing again always changes the suggestion");
    assert.ok(input.value.length > 0 && input.value.length <= 40);
    assert.equal(input.value, input.value.trim().replace(/\s+/g, " "));
    assert.ok(DUCK_NAME_ADJECTIVES.includes(input.value.split(" ")[0]));
    assert.ok(isAllowedDuckName(input.value), `the filter refuses "${input.value}"`);
    seen.add(input.value);
  }
  assert.ok(seen.size > 1, "the generator is not returning one fixed name");
  // A suggestion is an edit, so it defers live refreshes exactly like typing.
  assert.equal(input.dataset.liveDirty, "true");
  assert.equal(input.focusCalls > 0, true);
  // Nothing is saved until the participant presses Save.
  assert.equal(harness.requests.some((item) => item.url.includes("duck-name")), false);
});

test("saving a name folds the field away again", async () => {
  const registrationId = "22222222-2222-4222-8222-222222222222";
  let duckName = null;
  const harness = myDucksHarness((url) => url.endsWith("/mine/duck-name")
    ? Response.json({ named: true, replayed: false })
    : Response.json({
      registrations: [collected(registrationId, true, {
        nameable: true,
        duckName,
        raceStatus: pairedStatus(12),
      })],
    }));
  await harness.subscriptions[0].refresh();

  await nameToggle(harness.paired.track.children[0]).dispatch("click");
  const form = nameForm(harness.paired.track.children[0]);
  form.descendants().find((node) => node.tagName === "INPUT").value = "Bubbles";
  duckName = "Bubbles";
  await form.dispatch("submit");

  const repainted = harness.paired.track.children[0];
  assert.equal(nameForm(repainted).hidden, true);
  assert.equal(nameToggle(repainted).textContent, "Rename");
});

test("a followed entry renders the public duck name without owner naming controls", async () => {
  const harness = await renderMyDucks([
    followedEntry("33333333-3333-4333-8333-333333333333", {
      paired: true,
      duckName: "Owner Field Must Stay Hidden",
      nameable: true,
      raceStatus: { ...pairedStatus(88), duckName: "Public Bubbles" },
    }),
  ]);

  const [card] = harness.followed.track.children;
  assert.doesNotMatch(card.text(), /Owner Field Must Stay Hidden/);
  assert.equal(duckFact(card).children[1].children[0].textContent, "Public Bubbles");
  assert.doesNotMatch(card.text(), /Duck #88/);
  assert.equal(nameForm(card), null);
});

test("naming posts the trimmed value once and rerenders from the collection", async () => {
  const registrationId = "22222222-2222-4222-8222-222222222222";
  let duckName = null;
  const harness = myDucksHarness((url) => url.endsWith("/mine/duck-name")
    ? Response.json({ named: true, duckName: "Bubbles", replayed: false })
    : Response.json({
      registrations: [collected(registrationId, true, {
        nameable: true,
        duckName,
        raceStatus: pairedStatus(12),
      })],
    }));
  await harness.subscriptions[0].refresh();

  const form = nameForm(harness.paired.track.children[0]);
  const input = form.descendants().find((node) => node.tagName === "INPUT");
  assert.equal(input.maxLength, 40);
  input.value = "  Bubbles   the   Third  ";
  duckName = "Bubbles the Third";
  await form.dispatch("submit");

  const request = harness.requests.find((item) => item.url.endsWith("/mine/duck-name"));
  assert.ok(request, "the name must reach the public endpoint");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/json");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), ["commandId", "duckName", "registrationId"]);
  assert.equal(payload.registrationId, registrationId);
  assert.equal(payload.duckName, "Bubbles the Third", "the client trims and collapses before sending");
  assert.match(payload.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // The card is repainted from the authoritative collection, not the response,
  // and the edited field is marked clean so live refreshes resume.
  assert.equal(harness.requests.at(-1).url, "/api/v1/registrations/mine");
  assert.equal(harness.cleaned.at(-1), form);
  assert.deepEqual(harness.busy, ["begin", "end"]);
  const link = duckFact(harness.paired.track.children[0]).children[1].children[0];
  assert.equal(link.textContent, "Bubbles the Third");
});

test("a blank or overlong duck name never reaches the endpoint", async () => {
  const registrationId = "22222222-2222-4222-8222-222222222222";
  const harness = myDucksHarness(() => Response.json({
    registrations: [collected(registrationId, true, { nameable: true, raceStatus: pairedStatus() })],
  }));
  await harness.subscriptions[0].refresh();

  const form = nameForm(harness.paired.track.children[0]);
  const input = form.descendants().find((node) => node.tagName === "INPUT");
  const feedback = form.children.at(-1);

  for (const value of ["", "   ", "a".repeat(41)]) {
    input.value = value;
    await form.dispatch("submit");
    assert.equal(feedback.hidden, false, JSON.stringify(value));
    assert.match(feedback.textContent, /1 to 40 characters/);
    assert.equal(harness.requests.some((item) => item.url.includes("duck-name")), false);
    assert.deepEqual(harness.busy, [], "a rejected value never starts a mutation");
  }
});

test("a failed name save restores the action and reports it on that card", async () => {
  const registrationId = "22222222-2222-4222-8222-222222222222";
  const harness = myDucksHarness((url) => url.endsWith("/mine/duck-name")
    ? Response.json({ error: "conflict" }, { status: 409 })
    : Response.json({
      registrations: [collected(registrationId, true, { nameable: true, raceStatus: pairedStatus() })],
    }));
  await harness.subscriptions[0].refresh();

  const form = nameForm(harness.paired.track.children[0]);
  const input = form.descendants().find((node) => node.tagName === "INPUT");
  const button = form.descendants().find((node) => node.tagName === "BUTTON");
  input.value = "Bubbles";
  await form.dispatch("submit");

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Save name");
  const feedback = form.children.at(-1);
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /could not be saved/);
  assert.deepEqual(harness.busy, ["begin", "end"]);
});

test("unfollowing posts the guarded command and refetches the collection", async () => {
  const registrationId = "33333333-3333-4333-8333-333333333333";
  let registrations = [followedEntry(registrationId)];
  const harness = myDucksHarness((url) => url.endsWith("/mine/unfollow")
    ? Response.json({ unfollowed: true, replayed: false })
    : Response.json({ registrations }));
  await harness.subscriptions[0].refresh();

  const button = unfollowButton(harness.followed.track.children[0]);
  registrations = [];
  await button.dispatch("click");

  // Unfollowing is reversible, so it asks for no destructive confirmation.
  assert.equal(harness.confirmations.length, 0);
  const request = harness.requests.find((item) => item.url.endsWith("/mine/unfollow"));
  assert.ok(request, "the unfollow must reach its own endpoint");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/json");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), ["commandId", "registrationId"]);
  assert.equal(payload.registrationId, registrationId);
  assert.match(payload.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The delete endpoint is never involved.
  assert.equal(harness.requests.some((item) => item.url.includes("/mine/delete")), false);

  assert.equal(harness.requests.at(-1).url, "/api/v1/registrations/mine");
  assert.equal(harness.followed.track.children.length, 0);
  assert.equal(harness.followed.section.hidden, true);
  assert.equal(harness.empty.hidden, false);
  assert.deepEqual(harness.busy, ["begin", "end"]);
});

test("a failed unfollow keeps the card and reports the failure on it", async () => {
  const registrationId = "33333333-3333-4333-8333-333333333333";
  const harness = myDucksHarness((url) => url.endsWith("/mine/unfollow")
    ? Response.json({ error: "Not found." }, { status: 404 })
    : Response.json({ registrations: [followedEntry(registrationId)] }));
  await harness.subscriptions[0].refresh();

  const card = harness.followed.track.children[0];
  const button = unfollowButton(card);
  await button.dispatch("click");

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Stop following");
  const feedback = card.children.at(-1);
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /could not be removed from My Ducks/);
  assert.equal(harness.followed.track.children.length, 1);
});

// The public duck pages ship the follow control in participant.js, the
// browser-collection client, so a duck scan can add the participant without the
// board client ever touching a collection endpoint.
const duckPageHarness = (route, pathname, inMyDucks = false) => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  navigation.dataset.phaseVisible = "true";
  navigation.hidden = false;
  const follow = document.createElement("div");
  follow.dataset.duckFollow = "";
  follow.dataset.followId = "11111111-1111-4111-8111-111111111111";
  const message = document.createElement("p");
  message.dataset.followMessage = "";
  message.hidden = true;
  const button = document.createElement("button");
  button.dataset.followButton = "";
  button.textContent = "Follow this duck";
  const added = document.createElement("span");
  added.dataset.followAdded = "";
  added.textContent = "In My Ducks";
  follow.append(inMyDucks ? added : button);
  document.append(navigation, follow, message);

  const requests = [];
  const subscriptions = [];
  const busy = [];
  new Function(
    "document", "location", "window", "globalThis", "requestAnimationFrame", "history", "fetch",
    "appConfirm",
    // `duckDetailLink` ships in live-ui.js, which every page loads first, so the
    // page client receives it from the shared classic scope.
    [duckDetailHelpersScript, participantScript].join("\n"),
  )(
    document,
    { search: "", pathname, hash: "", origin: "https://quickducks.com" },
    { addEventListener() {} },
    {
      quickDucksLive: {
        beginBusy() {
          busy.push("begin");
          return () => busy.push("end");
        },
        markClean() {},
        subscribe(subscriber) { subscriptions.push(subscriber); },
      },
    },
    (callback) => callback(),
    { replaceState() {}, state: null },
    async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return route(String(url), options);
    },
    async () => true,
  );
  return { busy, button, document, follow, message, navigation, requests, subscriptions };
};

const followResponse = (overrides = {}) => Response.json({
  destination: "RACE_STATUS",
  raceStatus: {
    ...pairedStatus(12),
    followId: "11111111-1111-4111-8111-111111111111",
    inMyDucks: false,
    ...overrides,
  },
});

test("a tag scan offers one follow action and records saved-list presence", async () => {
  const harness = duckPageHarness((url) => url.startsWith("/api/v1/registrations/mine/follow")
    ? Response.json({ followed: true, alreadyInCollection: false })
    : url.startsWith("/api/v1/ducks/") ? followResponse() : Response.json({ hasRegistrations: false }), "/t/tag-token-value");

  assert.equal(harness.navigation.hidden, false);
  await harness.button.dispatch("click");

  const request = harness.requests.find((item) => item.url.endsWith("/mine/follow"));
  assert.ok(request, "the follow must reach the existing follow endpoint");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    followId: "11111111-1111-4111-8111-111111111111",
  });
  // The confirmed state is a plain tag plus a way into the saved list.
  assert.equal(harness.follow.children[0].textContent, "In My Ducks");
  assert.equal(harness.follow.children[0].className, "success-tag");
  assert.equal(harness.follow.children[1].href, "/my-ducks");
  assert.equal(harness.navigation.hidden, false);
  assert.equal(harness.navigation.dataset.hasRegistrations, "true");
  assert.deepEqual(harness.busy, ["begin", "end"]);
});

test("the duck page follow control repaints from the authoritative duck response", async () => {
  const states = [
    ["/t/tag-token-value", "/api/v1/ducks/tag-token-value"],
    ["/duck/12", "/api/v1/ducks/number/12"],
  ];
  for (const [pathname, expectedUrl] of states) {
    let inMyDucks = false;
    const harness = duckPageHarness(
      (url) => url.startsWith("/api/v1/ducks/") ? followResponse({ inMyDucks }) : Response.json({ hasRegistrations: false }),
      pathname,
    );
    // The presence probe and the follow control each subscribe or fetch once.
    const followSubscription = harness.subscriptions.at(-1);
    await followSubscription.refresh();
    assert.equal(harness.requests.some((item) => item.url === expectedUrl), true, expectedUrl);
    assert.equal(harness.follow.children[0].dataset.followButton, "");
    assert.equal(harness.follow.children[0].textContent, "Follow this duck");

    inMyDucks = true;
    await followSubscription.refresh();
    assert.equal(harness.follow.children[0].textContent, "In My Ducks");
    assert.equal(harness.follow.hidden, false);

    // A participant who stops being followable loses the control entirely
    // rather than keeping a dead button.
    const gone = duckPageHarness(
      (url) => url.startsWith("/api/v1/ducks/")
        ? Response.json({ destination: "RACE_STATUS", raceStatus: pairedStatus(12) })
        : Response.json({ hasRegistrations: false }),
      pathname,
    );
    await gone.subscriptions.at(-1).refresh();
    assert.equal(gone.follow.hidden, true);
    assert.equal(gone.follow.children.length, 0);
  }
});

test("a page without a follow container holds no follow subscription at all", async () => {
  const document = new QuickDocument("#document");
  const navigation = document.createElement("a");
  navigation.dataset.myDucksNav = "";
  document.append(navigation);
  const requests = [];
  const subscriptions = [];
  new Function(
    "document", "location", "window", "globalThis", "requestAnimationFrame", "history", "fetch",
    "appConfirm",
    // `duckDetailLink` ships in live-ui.js, which every page loads first, so the
    // page client receives it from the shared classic scope.
    [duckDetailHelpersScript, participantScript].join("\n"),
  )(
    document,
    { search: "", pathname: "/", hash: "", origin: "https://quickducks.com" },
    { addEventListener() {} },
    { quickDucksLive: { beginBusy: () => () => {}, markClean() {}, subscribe(s) { subscriptions.push(s); } } },
    (callback) => callback(),
    { replaceState() {}, state: null },
    async (url) => {
      requests.push(String(url));
      return Response.json({ hasRegistrations: false });
    },
    async () => true,
  );
  await Promise.resolve();

  assert.deepEqual(subscriptions, []);
  assert.deepEqual(requests, ["/api/v1/registrations/mine/presence"]);
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

// Both rounds still publish through the same scanned endpoint on the duck's own
// inspection page. What differs now is where the staffer ends up.
//
// Round one publishes one winner and there is nothing left to do with that duck,
// so the page hands them back to the station that owns the rest of the heat.
// The final builds its podium one scan at a time, so its staffer stays here and
// keeps scanning; sending them away after each place would be three round trips
// for one result.
test("a scanned round-one winner returns to the finish line and the final keeps scanning", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  assert.match(staffDuckScript, /"Mark Duck as Heat " \+ candidate\.heatNumber \+ " Winner"/);
  assert.match(staffDuckScript, /\/heat-winner/);
  // The final's saved-place banner still renders on this page.
  assert.match(staffDuckScript, /const success = winnerSuccess;\s*winnerSuccess = null;/);

  // The return trip is one fixed same-origin literal with two acknowledgement
  // parameters built from the duck and the heat this page already resolved.
  // Nothing from the response body or from the current URL reaches it, so it
  // cannot be steered into an open redirect.
  assert.match(
    staffDuckScript,
    /location\.assign\("\/staff\/finish-line\?recorded=heat-winner"\s*\+ "&duck=" \+ encodeURIComponent\(data\.duck\.visibleNumber\)\s*\+ "&heat=" \+ encodeURIComponent\(candidate\.heatNumber\)\);/,
  );
  // Only the committed path navigates. The catch below it re-enables the button
  // and shows the server's error, so a refusal can never redirect or claim a
  // winner was saved.
  assert.match(
    staffDuckScript,
    /message\.textContent = "Official winner saved\. Returning to the finish line…";\s*location\.assign\("\/staff\/finish-line/,
  );

  // The finish line's primary instruction names NFC and nothing else, and the
  // finalists bag is part of the same prominent workflow. Pinning the exact
  // sentence is what proves QR was removed from it; the final's own multi-place
  // instruction is a different sentence and still mentions both.
  assert.match(
    finishLineScript,
    /const FINISH_WINNER_SCAN_INSTRUCTION = "Heat finished\. Scan the winning duck's permanent NFC tag"\s*\+ " to open its inspection page and select it as the winner\.";/,
  );
  assert.match(
    finishLineScript,
    /const FINISH_FINALISTS_BAG_INSTRUCTION = "Then put the winning duck in the finalists bag\.";/,
  );
  // Every round-one surface says it through the constant rather than its own copy.
  assert.match(finishLineScript, /\? FINISH_WINNER_SCAN_INSTRUCTION\b/);
  assert.match(
    finishLineScript,
    /finishMessage\.textContent = FINISH_WINNER_SCAN_INSTRUCTION\s*\+ " Its inspection page will offer Mark Duck as Heat "/,
  );
  // The callout is its own region, so a scan, a refusal, or a repaint writing
  // the message line cannot overwrite the instruction.
  assert.match(finishLineScript, /finishCallout\.append\(\s*finishText\("strong", FINISH_WINNER_SCAN_INSTRUCTION\),\s*finishText\("p", FINISH_FINALISTS_BAG_INSTRUCTION\),\s*\);/);

  // The acknowledgement is validated, one-shot, and never a source of state.
  assert.match(finishLineScript, /parameters\.get\("recorded"\) !== "heat-winner"/);
  assert.match(finishLineScript, /history\.replaceState\(null, "", location\.pathname\);/);
  assert.match(finishLineScript, /\/\^\[0-9\]\{1,9\}\$\/\.test\(duckNumber\)/);

  assert.match(finishLineScript, /finishHeat\.round === "FINAL"/);
  assert.match(finishLineScript, /Submit official podium/);
  assert.doesNotMatch(finishLineScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

// A final awards up to three places, so the scan that records one has to ask
// which. The buttons come from the server's own list of open places, the request
// carries that place, and the duck already standing on the podium is offered the
// way back off instead of a second place.
test("a scanned final duck is offered only the podium places the server says are open", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  assert.match(staffDuckScript, /if \(candidate\.round === "FINAL" && candidate\.podium\) \{\s*renderPodiumAction\(data, candidate\);/);
  assert.match(staffDuckScript, /const open = podiumOpenPlaces\(podium\);/);
  assert.match(
    staffDuckScript,
    /const button = text\("button", "Mark Duck as " \+ podiumPlaceLabel\(place\), "button station-control"\);/,
  );
  // The place travels with the command, and nothing else about the round-one
  // body changes: same endpoint, same scanned context, same revision guard.
  assert.match(
    staffDuckScript,
    /raceEntryId: candidate\.raceEntryId,\s*revision: candidate\.revision,\s*place,/,
  );
  // Whether that scan published the podium is read back off the response, not
  // guessed from the count the buttons were painted with.
  assert.match(staffDuckScript, /const published = body\.heat && body\.heat\.status === "FINALIZED";/);
  // A duck that already holds a place gets the way back off it and no second
  // place to stand in.
  assert.match(staffDuckScript, /if \(podium\.selectedPlace !== null\) \{/);
  assert.match(staffDuckScript, /podium-place\/clear/);
  const openPlaces = new Function(`${podiumPlaceHelpersScript}; return podiumOpenPlaces;`)();
  assert.deepEqual(openPlaces({ availablePlaces: [1, 3] }), [1, 3]);
  // Never invents a place the server did not offer, whatever arrives.
  assert.deepEqual(openPlaces({ availablePlaces: [0, 4, 2, "1", null] }), [2]);
  assert.deepEqual(openPlaces(null), []);
  assert.deepEqual(openPlaces({}), []);
});

// The banner is the last thing a staffer reads before walking away from a duck,
// so it must describe what the server came back with rather than what the button
// they pressed was for. A replayed command can land on a podium that moved —
// the place may have been cleared since — and a publishing scan returns no
// podium at all.
test("the scanned podium banner claims a place only while the response still shows it", () => {
  const decide = new Function(
    "body",
    "place",
    "candidate",
    `${podiumPlaceHelpersScript}
     const published = body.heat && body.heat.status === "FINALIZED";
     const standing = published || podiumTakenPlacements(body.podium)
       .some((placement) => placement.place === place && placement.raceEntryId === candidate.raceEntryId);
     return { published: !!published, standing };`,
  );
  const candidate = { raceEntryId: "entry-1" };
  const awaiting = (placements) => ({ heat: { status: "AWAITING_RESULT" }, podium: { placements } });

  // The ordinary recorded place.
  assert.deepEqual(
    decide(awaiting([{ place: 2, raceEntryId: "entry-1" }]), 2, candidate),
    { published: false, standing: true },
  );
  // A replay whose place was cleared in between, and one another duck now holds.
  assert.deepEqual(decide(awaiting([]), 2, candidate), { published: false, standing: false });
  assert.deepEqual(
    decide(awaiting([{ place: 2, raceEntryId: "entry-9" }]), 2, candidate),
    { published: false, standing: false },
  );
  // The scan that published the podium carries no podium to check, and must
  // still report the result rather than doubting it.
  assert.deepEqual(
    decide({ heat: { status: "FINALIZED" }, podium: null }, 2, candidate),
    { published: true, standing: true },
  );

  // The shipped client uses exactly that decision for the banner, the title, and
  // the message line, with a distinct wording when the place is not standing.
  assert.match(
    staffDuckScript,
    /const standing = published \|\| podiumTakenPlacements\(body\.podium\)\s*\.some\(\(placement\) => placement\.place === place && placement\.raceEntryId === candidate\.raceEntryId\);/,
  );
  assert.match(staffDuckScript, /title: podiumPlaceLabel\(place\) \+ " is not recorded"/);
  assert.match(staffDuckScript, /if \(standing\) pageTitle\.textContent = /);
  assert.match(staffDuckScript, /That place is not recorded any more\. Check the podium and scan again if it should be\./);
});

// The station and the duck page must never show two different podiums. The
// moment a place is scanned, the station stops offering its own way to assemble
// one and shows the scanned podium instead, with the way to undo a place.
test("the finish line hands the podium over to the scans as soon as one place is recorded", () => {
  assert.doesNotThrow(() => new Function(finishLineScript));

  assert.match(
    finishLineScript,
    /const finishPodiumScanned = \(\) => finishHeat !== null && finishHeat\.round === "FINAL"\s*&& podiumTakenPlacements\(finishPodium\)\.length > 0;/,
  );
  assert.match(finishLineScript, /finishScanForm\.hidden = !awaiting \|\| !finalPodiumFlow \|\| scannedPodium;/);
  assert.match(finishLineScript, /finishSubmit\.hidden = !awaiting \|\| !finalPodiumFlow \|\| scannedPodium;/);
  // Hidden is a paint; the submit guard is the guard.
  assert.match(finishLineScript, /\|\| finishSelected\.length !== required\s*(?:\/\/[^\n]*\n\s*)*\|\| finishPodiumScanned\(\);/);
  assert.match(finishLineScript, /if \(finishPodiumScanned\(\)\) \{\s*finishRenderScannedPodium\(focusedRaceEntry\);/);
  assert.match(finishLineScript, /finishPodium = detail\.podium \|\| null;/);
  assert.doesNotMatch(finishLineScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("the staff console shows accumulating finalists and obeys server correction capabilities", () => {
  assert.match(staffHomeScript, /\["ROUND_ONE", "FINAL", "COMPLETED"\]\.includes\(currentEvent\?\.status\)/);
  assert.match(staffHomeScript, /No round-one winner has been recorded yet/);
  assert.doesNotMatch(staffHomeScript, /Finalist roster verified|not yet verified|data-refresh-finalists/);
  assert.match(staffHomeScript, /if \(body\.heat\.resultCorrectionAllowed\) heatControls\.append\(resultForm\(body, "correct"\)\)/);
  assert.match(staffHomeScript, /if \(!body\.heat\.resultReopenAllowed\) return/);
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

  const named = duckDetailLink(document, 128, "<Captain Quacks>");
  assert.equal(named.href, "/duck/128", "the number remains the destination");
  assert.equal(named.textContent, "<Captain Quacks>", "the public name replaces only visible text");
  assert.equal(named.children.length, 0, "the public name is never parsed as markup");

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
  const heading = document.createElement("h1");
  heading.dataset.duckHeading = "";
  heading.textContent = "Duck #128";
  const nodes = {
    "[data-live-board]": document.createElement("section"),
    "[data-live-board-stage]": document.createElement("p"),
    "[data-live-board-title]": document.createElement("h2"),
    "[data-live-board-summary]": document.createElement("p"),
    "[data-live-board-content]": document.createElement("div"),
    "[data-live-board-error]": document.createElement("p"),
    "[data-live-personal]": personal,
    "[data-duck-heading]": heading,
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
    `${duckDetailHelpersScript}${liveScript}; return { liveRefreshWork, liveBoardDuckCell, liveHeatCard };`,
  )(
    document,
    fetchStub,
    { quickDucksLive: { subscribe(options) { subscriptions.push(options); } } },
    { pathname: "/duck/128", reload() { reloads.push("reload"); }, replace(value) { reloads.push(value); } },
  );
  return { api, heading, nodes, personal, requests, subscriptions, reloads, document };
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

test("official heat winners render an accessible gold text marker beside the participant", () => {
  const { api } = liveDuckPage();
  const card = api.liveHeatCard({
    round: "ROUND_ONE",
    number: 3,
    status: "FINALIZED",
    roster: [
      { participantDisplayName: "Daisy D.", duckNumber: 4, duckName: null, place: 1 },
      { participantDisplayName: "Donald M.", duckNumber: 5, duckName: null, place: null },
    ],
  }, null);
  const winnerRow = card.children.find((child) => child.className === "board-entry");
  const participant = winnerRow.children[0];
  assert.equal(participant.className, "board-participant");
  assert.equal(participant.children[1].textContent, "Winner");
  assert.equal(participant.children[1].className, "winner-ribbon");
  assert.equal(nodeText(participant), "Daisy D.Winner");
});

test("a board entry replaces its generic label with the chosen duck name", () => {
  const { api } = liveDuckPage();

  const named = api.liveBoardDuckCell({
    participantDisplayName: "Jamie R.",
    duckNumber: 128,
    duckName: "Sir Quacks-a-Lot",
    place: null,
  });
  assert.equal(named.children[0].tagName, "A");
  assert.equal(named.children[0].textContent, "Sir Quacks-a-Lot");
  assert.equal(named.children[0].href, "/duck/128");
  assert.equal(nodeText(named), "Sir Quacks-a-Lot");

  // A placed entry keeps the chosen name and official place.
  assert.equal(
    nodeText(api.liveBoardDuckCell({
      participantDisplayName: "Jamie R.",
      duckNumber: 4,
      duckName: "Bubbles",
      place: 1,
    })),
    "Bubbles · 1st place",
  );

  // A suppressed, cleared, or absent name simply leaves the number.
  for (const duckName of [null, undefined, ""]) {
    assert.equal(
      nodeText(api.liveBoardDuckCell({
        participantDisplayName: "Jamie R.",
        duckNumber: 7,
        duckName,
        place: null,
      })),
      "Duck #7",
      String(duckName),
    );
  }

  // An entry with no duck number carries no name either.
  assert.equal(
    nodeText(api.liveBoardDuckCell({
      participantDisplayName: "Jamie R.",
      duckNumber: null,
      duckName: "Bubbles",
      place: null,
    })),
    "Duck number pending",
  );

  // The name is a text node built by the shared helper, never markup.
  const hostile = api.liveBoardDuckCell({
    participantDisplayName: "Jamie R.",
    duckNumber: 9,
    duckName: "<img src=x onerror=alert(1)>",
    place: null,
  });
  assert.equal(nodeText(hostile), "<img src=x onerror=alert(1)>");
  assert.equal(hostile.children.some((child) => child.tagName === "IMG"), false);
});

test("the public duck detail live repaint replaces every generic duck label", async () => {
  const page = liveDuckPage({
    raceStatus: {
      participantDisplayName: "Jamie R.",
      duck: { visibleNumber: 128 },
      duckName: "Sir Quacks-a-Lot",
      assignedHeat: { roundOne: null, final: null },
      currentHeat: null,
      outcome: "HEAT_ASSIGNMENT_PENDING",
    },
  });

  await page.api.liveRefreshWork();

  // The live repaint mirrors the server-rendered fact exactly.
  assert.deepEqual(
    page.personal.children[0].children
      .map((fact) => fact.children.map((part) => part.textContent))
      .find(([label]) => label === "Duck"),
    ["Duck", "Sir Quacks-a-Lot"],
  );
  assert.equal(page.heading.textContent, "Sir Quacks-a-Lot");
  assert.equal(page.document.title, "Sir Quacks-a-Lot · QuickDucks");
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
  }, { paired: true });
  const pairedDuckFact = paired.children[0].children[0];
  assert.deepEqual(pairedDuckFact.children.map((part) => part.tagName), ["DT", "DD"]);
  assert.equal(pairedDuckFact.children[0].textContent, "Duck");
  const link = pairedDuckFact.children[1].children[0];
  assert.equal(link.tagName, "A");
  assert.equal(link.href, "/duck/42");
  assert.equal(link.textContent, "Duck #42");

  const awaiting = card();
  participantAddRaceFacts(awaiting, {
    // Deliberately stale assignment details: the collection's current-pairing
    // projection is authoritative, so none of these may make the card assigned.
    duck: { visibleNumber: 42 },
    assignedHeat: { roundOne: { number: 3, status: "PLANNED" }, final: null },
    currentHeat: { round: "ROUND_ONE", number: 3, status: "RUNNING" },
    outcome: "RUNNING",
  }, { paired: false });
  const awaitingDuckFact = awaiting.children[0].children[0];
  assert.equal(awaitingDuckFact.children[1].textContent, "Waiting for duck assignment");
  assert.deepEqual(
    awaiting.children[0].children.map((fact) => fact.children[0].textContent),
    ["Duck"],
  );
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

// --- Participant QR codes on the My Ducks cards ---------------------------

const cardQr = (card) => card.descendants().find((node) => node.tagName === "SVG") ?? null;

test("My Ducks renders the pairing QR on awaiting and paired cards it owns", async () => {
  // The awaiting section is the pre-pairing state staff scan at the duck table,
  // and the code stays useful for lookup afterwards, so both owned sections
  // carry it. This is the surface a participant actually has on their phone;
  // the private status link only works if they kept it.
  const harness = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false),
    collected("22222222-2222-4222-8222-222222222222", true),
    followedEntry("33333333-3333-4333-8333-333333333333"),
  ]);

  const [awaiting] = harness.awaiting.track.children;
  const [paired] = harness.paired.track.children;
  const [followed] = harness.followed.track.children;

  assert.ok(cardQr(awaiting), "an awaiting card shows the QR staff scan");
  assert.ok(cardQr(paired), "a paired card keeps the QR for lookup");
  assert.equal(cardQr(followed), null, "a followed entry has no lookup code to encode");
});

test("the card QR is built as namespaced SVG from the projected geometry", async () => {
  // Built through createElementNS and setAttribute rather than markup, so no
  // part of the API response is ever parsed as HTML.
  const harness = await renderMyDucks([collected("11111111-1111-4111-8111-111111111111", false)]);
  const svg = cardQr(harness.awaiting.track.children[0]);

  assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(svg.getAttribute("viewBox"), "0 0 29 29");
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /lookup code/i);

  const [background, modules] = svg.children;
  assert.equal(background.tagName, "RECT");
  assert.equal(background.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(modules.tagName, "PATH");
  assert.equal(modules.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(modules.getAttribute("d"), "M4 4h7v1h-7zM12 4h1v1h-1z");
});

test("a card drops its QR rather than drawing unexpected geometry", async () => {
  // Every rejection still leaves a usable card: the readable code staff can
  // type is never gated on the QR rendering.
  const rejected = [
    { qr: null },
    { qr: undefined },
    { qr: { size: 29, path: "M0 0L5 5" } },
    { qr: { size: 29, path: 'M0 0h1v1h-1z" onload="alert(1)' } },
    { qr: { size: 0, path: "M4 4h7v1h-7z" } },
    { qr: { size: "many", path: "M4 4h7v1h-7z" } },
  ];

  for (const override of rejected) {
    const harness = await renderMyDucks([
      collected("11111111-1111-4111-8111-111111111111", false, override),
    ]);
    const [card] = harness.awaiting.track.children;
    assert.equal(cardQr(card), null, `must not draw ${JSON.stringify(override.qr)}`);
    assert.match(card.text(), /Staff lookup code: DAISY123/, "the typed code still works");
    assert.match(
      card.text(),
      /Show this code to staff at registration table to get your duck!/,
      "the typed code keeps its assignment guidance",
    );
  }
});

test("a followed card refuses a QR even if the server ever sent geometry", async () => {
  // Defence in depth for the rule this page exists to keep: a followed entry is
  // someone else's registration, and its card must never carry an encoding of
  // their lookup code. The server already withholds it, so this pins the client
  // half independently rather than trusting one guard twice.
  const harness = await renderMyDucks([
    followedEntry("33333333-3333-4333-8333-333333333333", {
      qr: { size: 29, path: "M4 4h7v1h-7zM12 4h1v1h-1z" },
    }),
  ]);

  const [followed] = harness.followed.track.children;
  assert.equal(cardQr(followed), null, "a followed card never draws a QR");
  assert.doesNotMatch(followed.text(), /lookup code:/i);
});

test("the QR caption explains duck assignment, and each label names its participant", async () => {
  const harness = await renderMyDucks([
    collected("11111111-1111-4111-8111-111111111111", false),
    collected("22222222-2222-4222-8222-222222222222", true),
  ]);

  const [awaiting] = harness.awaiting.track.children;
  const [paired] = harness.paired.track.children;

  // Before pairing the code gives the exact assignment instruction; afterwards
  // that errand is done and the assignment instruction disappears.
  assert.match(awaiting.text(), /Show this code to staff at registration table to get your duck!/);
  assert.doesNotMatch(paired.text(), /Show this code to staff at registration table to get your duck!/);
  assert.match(paired.text(), /pull up this registration/);

  // Several cards share a screen, so the accessible name has to distinguish them.
  assert.match(cardQr(awaiting).getAttribute("aria-label"), /Daisy Duck/);
});

const heatBagHelpers = () => new Function(
  `${heatBagHelpersScript}; return { heatBagCallout };`,
)();

// A duck goes into a heat bag at pairing and stays there. The bag number is
// therefore only ever the one the pairing command committed and returned.
test("the heat-bag callout is a pure function of the server's own pairing heat", () => {
  const { heatBagCallout } = heatBagHelpers();

  const roundOne = heatBagCallout({ round: "ROUND_ONE", number: 3 }, 12, false, "REGISTRATION_CLOSED");
  assert.equal(roundOne.pending, false);
  assert.equal(roundOne.instruction, "Put this duck in HEAT 3 bag");
  assert.equal(roundOne.number, "Heat 3");
  assert.equal(roundOne.duck, "Duck #12");
  assert.match(roundOne.note, /Walk Duck #12 to the heat 3 bag now/);
  assert.match(roundOne.note, /stays in that bag, in that position, for the rest of the race/);

  // A repair pairing during racing can land in the final, which is a different
  // physical bag. Both the round and the number the server sent are used.
  const final = heatBagCallout({ round: "FINAL", number: 1 }, 77, false, "FINAL");
  assert.equal(final.pending, false);
  assert.equal(final.instruction, "Put this duck in FINAL heat 1 bag");
  assert.equal(final.number, "Final · Heat 1");
  assert.equal(final.duck, "Duck #77");
  assert.match(final.note, /final heat 1 bag/);

  // A heat the server could not report is stated honestly. No blank, no guess.
  for (const pendingCase of [
    heatBagCallout(null, 12, true, "REGISTRATION_OPEN"),
    heatBagCallout(null, 12, false, "REGISTRATION_OPEN"),
    heatBagCallout({ round: "ROUND_ONE", number: 3 }, 12, true, "REGISTRATION_OPEN"),
    heatBagCallout({ round: "ROUND_ONE" }, 12, false, "REGISTRATION_OPEN"),
  ]) {
    assert.equal(pendingCase.pending, true);
    assert.equal(pendingCase.instruction, "Do not bag this duck yet");
    assert.equal(pendingCase.number, "No heat assigned");
    assert.match(pendingCase.note, /ask the race director which heat it belongs to/);
    assert.doesNotMatch(pendingCase.number, /\d/);
  }

  // The number is copied, never computed: the helper has no arithmetic at all.
  assert.doesNotMatch(heatBagHelpersScript, /number \+ 1|\+\+|length \+|Number\(/);
});

// The bag number is a promise about a physical object, so the note beside it
// has to be true. Closing registration folds a short round-one tail heat into
// the heat before it, which is the one operation that can still move an
// already-paired duck's entry — so while registration is open the note must not
// claim the bag is final, and once it has closed it must say plainly that it is.
test("the heat-bag note only promises a permanent bag once nothing can fold it", () => {
  const { heatBagCallout } = heatBagHelpers();
  const permanent = /stays in that bag, in that position, for the rest of the race/;

  // Registration open: the tail can still be folded, so no absolute claim.
  const open = heatBagCallout({ round: "ROUND_ONE", number: 5 }, 12, false, "REGISTRATION_OPEN");
  assert.equal(open.instruction, "Put this duck in HEAT 5 bag", "the bag is still named as loudly");
  assert.equal(open.number, "Heat 5");
  assert.doesNotMatch(open.note, permanent);
  assert.match(open.note, /Walk Duck #12 to the heat 5 bag now/);
  assert.match(open.note, /folded into the heat before it/);
  assert.match(open.note, /pour one whole bag into another/);
  assert.match(open.note, /Admin console names both bags/);

  // Every state in which no fold can reach this entry any more says so.
  for (const status of ["REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]) {
    const settled = heatBagCallout({ round: "ROUND_ONE", number: 5 }, 12, false, status);
    assert.equal(settled.instruction, "Put this duck in HEAT 5 bag", status);
    assert.match(settled.note, permanent, status);
    assert.doesNotMatch(settled.note, /folded into the heat before it/, status);
  }

  // A final-heat repair pairing is never folded, whatever the event status is.
  assert.match(heatBagCallout({ round: "FINAL", number: 1 }, 77, false, "REGISTRATION_OPEN").note, permanent);
  // A status the page could not resolve falls back to the cautious wording:
  // an unknown state is not a licence to promise a permanent bag.
  for (const unknown of [null, undefined, "", "DRAFT"]) {
    assert.doesNotMatch(heatBagCallout({ round: "ROUND_ONE", number: 5 }, 12, false, unknown).note, permanent);
  }
});

// The console's half of the same promise. Closing registration folds a short
// tail heat into the heat before it; that is a physical task nobody else knows
// about, so the console queues it, shows it in the same loud language as the
// pairing callout, and keeps it there until a person says the bags match.
const bagMoveHarness = () => {
  const from = staffHomeScript.indexOf("const bagMoveStorageKey");
  const to = staffHomeScript.indexOf("if (bagMove && bagMoveDismiss)");
  assert.ok(from > 0 && to > from, "the console script defines the bag-move queue");
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const elements = {
    bagMove: { hidden: true },
    bagMoveInstruction: { textContent: "" },
    bagMoveNumber: { textContent: "" },
    bagMoveDucks: { textContent: "" },
    bagMoveNote: { textContent: "" },
  };
  const api = new Function(
    "bagMove",
    "bagMoveInstruction",
    "bagMoveNumber",
    "bagMoveDucks",
    "bagMoveNote",
    "localStorage",
    `${staffHomeScript.slice(from, to)}
     return { renderBagMove, queueBagMoves, clearBagMoves, bagMoveRead, bagMoveWrite };`,
  )(
    elements.bagMove,
    elements.bagMoveInstruction,
    elements.bagMoveNumber,
    elements.bagMoveDucks,
    elements.bagMoveNote,
    storage,
  );
  return { ...api, elements, store };
};

test("the console turns a reported fold into a physical bag instruction and keeps it queued", () => {
  const merge = bagMoveHarness();
  assert.equal(merge.elements.bagMove.hidden, true, "nothing is claimed before a transition reports one");

  merge.queueBagMoves([{
    action: "MERGE",
    fromHeatNumber: 5,
    intoHeatNumber: 4,
    duckNumbers: [117, 118],
    movedEntryCount: 2,
  }], "command-a");

  assert.equal(merge.elements.bagMove.hidden, false);
  assert.equal(merge.elements.bagMoveInstruction.textContent, "Pour the Heat 5 bag into the Heat 4 bag");
  assert.equal(merge.elements.bagMoveNumber.textContent, "Heat 5 → Heat 4");
  assert.equal(merge.elements.bagMoveDucks.textContent, "2 ducks: Duck #117, Duck #118");
  assert.match(merge.elements.bagMoveNote.textContent, /Empty the whole Heat 5 bag into the Heat 4 bag/);
  assert.match(merge.elements.bagMoveNote.textContent, /too few ducks to race/);

  // It is queued, not merely painted, so re-rendering after a reload restores
  // exactly the same instruction rather than losing the physical task.
  const reloaded = bagMoveHarness();
  reloaded.bagMoveWrite(merge.bagMoveRead());
  reloaded.renderBagMove();
  assert.equal(reloaded.elements.bagMove.hidden, false);
  assert.equal(reloaded.elements.bagMoveInstruction.textContent, "Pour the Heat 5 bag into the Heat 4 bag");

  // The same command reported twice queues one task, not two.
  merge.queueBagMoves([{
    action: "MERGE",
    fromHeatNumber: 5,
    intoHeatNumber: 4,
    duckNumbers: [117, 118],
    movedEntryCount: 2,
  }], "command-a");
  assert.equal(merge.bagMoveRead().length, 1);

  // A two-pass fold queues both, in the order the staff must perform them.
  merge.queueBagMoves([
    { action: "MERGE", fromHeatNumber: 3, intoHeatNumber: 2, duckNumbers: [9], movedEntryCount: 1 },
    { action: "MERGE", fromHeatNumber: 2, intoHeatNumber: 1, duckNumbers: [8, 9], movedEntryCount: 2 },
  ], "command-b");
  assert.deepEqual(
    merge.bagMoveRead().map((move) => move.fromHeatNumber + "->" + move.intoHeatNumber),
    ["5->4", "3->2", "2->1"],
  );

  // Deleting the event removes every heat, so its bag instructions go too.
  merge.clearBagMoves();
  assert.deepEqual(merge.bagMoveRead(), []);
  assert.equal(merge.elements.bagMove.hidden, true);
});

test("the console reports a reopen split by naming the exact ducks to take back out", () => {
  const split = bagMoveHarness();
  split.queueBagMoves([{
    action: "SPLIT",
    fromHeatNumber: 4,
    intoHeatNumber: 5,
    duckNumbers: [117, 118],
    movedEntryCount: 2,
  }], "command-c");

  assert.equal(split.elements.bagMove.hidden, false);
  assert.equal(
    split.elements.bagMoveInstruction.textContent,
    "Move 2 ducks: Duck #117, Duck #118 from the Heat 4 bag into a new Heat 5 bag",
  );
  assert.equal(split.elements.bagMoveNumber.textContent, "Heat 4 → Heat 5");
  assert.match(split.elements.bagMoveNote.textContent, /Take exactly those ducks out of the Heat 4 bag/);
  assert.match(split.elements.bagMoveNote.textContent, /leave every other duck exactly where it is/);

  // The count and the list are the same fact, always. A place whose duck
  // assignment has ended contributes no number, and counting it anyway used to
  // read "Move 2 ducks: Duck #117" — one duck named, two demanded, and a
  // staffer sent to the bank to find a duck that is not there.
  const gap = bagMoveHarness();
  gap.queueBagMoves([{
    action: "SPLIT",
    fromHeatNumber: 4,
    intoHeatNumber: 5,
    duckNumbers: [117],
    movedEntryCount: 2,
  }], "command-gap");
  assert.equal(
    gap.elements.bagMoveInstruction.textContent,
    "Move 1 duck: Duck #117 from the Heat 4 bag into a new Heat 5 bag",
  );
  assert.equal(gap.elements.bagMoveDucks.textContent, "1 duck: Duck #117");
  // The roster difference is still reported, as the separate fact it is.
  assert.match(
    gap.elements.bagMoveNote.textContent,
    / 1 racer in this move has no duck assigned right now, so there is nothing to carry for them\.$/,
  );

  // The same rule for a merge, which pours a whole bag rather than searching it.
  const countOnly = bagMoveHarness();
  countOnly.queueBagMoves([{
    action: "MERGE",
    fromHeatNumber: 2,
    intoHeatNumber: 1,
    duckNumbers: [],
    movedEntryCount: 1,
  }], "command-d");
  assert.equal(countOnly.elements.bagMoveDucks.textContent, "No ducks to carry");
  assert.equal(countOnly.elements.bagMoveInstruction.textContent, "Pour the Heat 2 bag into the Heat 1 bag");
  assert.match(
    countOnly.elements.bagMoveNote.textContent,
    / 1 racer in this move has no duck assigned right now, so there is nothing to carry for them\.$/,
  );

  const mergeGap = bagMoveHarness();
  mergeGap.queueBagMoves([{
    action: "MERGE",
    fromHeatNumber: 5,
    intoHeatNumber: 4,
    duckNumbers: [117, 118],
    movedEntryCount: 4,
  }], "command-e");
  assert.equal(mergeGap.elements.bagMoveDucks.textContent, "2 ducks: Duck #117, Duck #118");
  assert.match(
    mergeGap.elements.bagMoveNote.textContent,
    / 2 racers in this move have no duck assigned right now, so there is nothing to carry for them\.$/,
  );

  // A split with nothing physical to move never reads as an instruction to move
  // nothing named: it says plainly that no duck leaves the bag.
  const emptySplit = bagMoveHarness();
  emptySplit.queueBagMoves([{
    action: "SPLIT",
    fromHeatNumber: 4,
    intoHeatNumber: 5,
    duckNumbers: [],
    movedEntryCount: 1,
  }], "command-f");
  assert.equal(emptySplit.elements.bagMoveInstruction.textContent, "No duck moves out of the Heat 4 bag");
  assert.equal(emptySplit.elements.bagMoveDucks.textContent, "No ducks to carry");
  assert.match(
    emptySplit.elements.bagMoveNote.textContent,
    /No duck in the Heat 4 bag moves, and every bag stays exactly as it is\./,
  );

  // Whatever the shape, a number the instruction states is a number of ducks it
  // also names. This is the invariant the reviewer's case broke.
  for (const move of [
    { action: "MERGE", fromHeatNumber: 5, intoHeatNumber: 4, duckNumbers: [9], movedEntryCount: 3 },
    { action: "SPLIT", fromHeatNumber: 4, intoHeatNumber: 5, duckNumbers: [9, 10], movedEntryCount: 5 },
    { action: "SPLIT", fromHeatNumber: 4, intoHeatNumber: 5, duckNumbers: [9, 10], movedEntryCount: 2 },
  ]) {
    const consistent = bagMoveHarness();
    consistent.queueBagMoves([move], `command-${move.action}-${move.movedEntryCount}`);
    const named = (consistent.elements.bagMoveInstruction.textContent.match(/Duck #\d+/g) ?? []).length;
    const claimed = consistent.elements.bagMoveInstruction.textContent.match(/(\d+) ducks?:/);
    assert.equal(claimed === null ? named : Number(claimed[1]), named, JSON.stringify(move));
    const listed = (consistent.elements.bagMoveDucks.textContent.match(/Duck #\d+/g) ?? []).length;
    const listedClaim = consistent.elements.bagMoveDucks.textContent.match(/(\d+) ducks?:/);
    assert.equal(listedClaim === null ? listed : Number(listedClaim[1]), listed, JSON.stringify(move));
  }
});

test("the bag-move queue refuses an entry it could only render as nonsense", () => {
  const harness = bagMoveHarness();
  const valid = {
    id: "command-a:0",
    action: "MERGE",
    fromHeatNumber: 5,
    intoHeatNumber: 4,
    duckNumbers: [117],
    movedEntryCount: 1,
  };

  // Anything on this origin can write the queue, and every field of it is
  // printed into an instruction a staffer walks away and acts on. It is written
  // with textContent throughout, so this is tidiness rather than safety — but
  // "Duck #[object Object]" is not an instruction anyone can follow.
  const corrupt = [
    { ...valid, duckNumbers: [{}] },
    { ...valid, duckNumbers: ["117"] },
    { ...valid, duckNumbers: [null] },
    { ...valid, duckNumbers: [1.5] },
    { ...valid, duckNumbers: [117, undefined] },
    { ...valid, duckNumbers: "117" },
    { ...valid, fromHeatNumber: "5" },
    { ...valid, action: "POUR" },
    { ...valid, id: 7 },
  ];
  harness.bagMoveWrite([...corrupt, valid]);
  assert.deepEqual(harness.bagMoveRead(), [valid], "only the well-formed entry survives the read");

  harness.renderBagMove();
  assert.equal(harness.elements.bagMoveDucks.textContent, "1 duck: Duck #117");
  assert.doesNotMatch(harness.elements.bagMoveDucks.textContent, /\[object Object\]|undefined|null|NaN/);
  assert.doesNotMatch(harness.elements.bagMoveInstruction.textContent, /\[object Object\]|undefined|null|NaN/);

  // A corrupt entry is refused on the way in as well, not only on the way out.
  const queued = bagMoveHarness();
  queued.queueBagMoves([{ ...valid, duckNumbers: [{}] }, { ...valid, duckNumbers: [118] }], "command-z");
  assert.deepEqual(queued.bagMoveRead().map((move) => move.duckNumbers), [[118]]);

  // A queue that is not a list at all, or unreadable entirely, is simply empty.
  queued.store.set("quickducks.bag-moves", "{\"nope\":true}");
  assert.deepEqual(queued.bagMoveRead(), []);
  queued.store.set("quickducks.bag-moves", "not json");
  assert.deepEqual(queued.bagMoveRead(), []);
});

test("the queued bag instruction survives everything except a person acknowledging it", () => {
  // Only the Done button removes one, and it removes exactly one, so a
  // two-pass fold is worked through rather than dismissed wholesale.
  assert.match(
    staffHomeScript,
    /data-bag-move-dismiss\]"\);[\s\S]*?bagMoveDismiss\.addEventListener\("click", \(\) => \{\s*bagMoveWrite\(bagMoveRead\(\)\.slice\(1\)\);\s*renderBagMove\(\);/,
  );
  // Nothing else in the console hides it: no refresh, no view switch, no
  // lifecycle repaint may take a physical instruction off the screen.
  assert.equal((staffHomeScript.match(/bagMove\.hidden = true/g) ?? []).length, 1);
  assert.match(staffHomeScript, /if \(queued\.length === 0\) \{\s*bagMove\.hidden = true;/);

  // The queue is written before the response is applied to the page, so the
  // instruction is on screen the moment the transition is known to have
  // committed rather than after a refetch that might fail.
  const queued = staffHomeScript.indexOf("queueBagMoves(result.bagMoves, commandId);");
  const rendered = staffHomeScript.indexOf("renderLifecycleResult(result.event);");
  assert.ok(queued > 0 && rendered > queued);

  // Storage is best effort: an unavailable or corrupt queue must never take the
  // console down.
  assert.match(staffHomeScript, /const bagMoveRead = \(\) => \{\s*try \{/);
  assert.match(staffHomeScript, /const bagMoveWrite = \(moves\) => \{\s*try \{/);

  // DOM-safe like every other console render.
  const source = staffHomeScript.slice(
    staffHomeScript.indexOf("const bagMoveStorageKey"),
    staffHomeScript.indexOf("if (bagMove && bagMoveDismiss)"),
  );
  assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("the pairing client paints the bag panel from the response and keeps it up", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  // Every field comes from heatBagCallout, which takes only the pairing
  // response plus the authoritative event status the page already loaded.
  assert.match(
    staffDuckScript,
    /const callout = heatBagCallout\(\s*result\.heat,\s*result\.duck\.visibleNumber,\s*result\.heatAssignmentPending,\s*currentEvent \? currentEvent\.status : null,\s*\)/,
  );
  assert.match(staffDuckScript, /heatBag\.classList\.toggle\("pending", callout\.pending\)/);
  assert.match(staffDuckScript, /heatBagInstruction\.textContent = callout\.instruction/);
  assert.match(staffDuckScript, /heatBagNumber\.textContent = callout\.number/);
  assert.match(staffDuckScript, /heatBagDuck\.textContent = callout\.duck/);
  assert.match(staffDuckScript, /heatBagNote\.textContent = callout\.note/);
  // Shown and scrolled to as soon as the pairing lands. The live region is
  // revealed before it is written into, so the announcement is a change inside
  // a region that is already in the accessibility tree.
  assert.match(
    staffDuckScript,
    /heatBag\.hidden = false;\s*heatBagInstruction\.textContent[\s\S]*?heatBag\.scrollIntoView\(\{ block: "start" \}\)/,
  );
  assert.match(staffDuckScript, /showHeatBag\(result\);/);
  // Only an explicit dismissal hides it, so a live refresh cannot take it off
  // the screen while the staffer walks to the bags.
  assert.equal((staffDuckScript.match(/heatBag\.hidden = true/g) ?? []).length, 1);
  assert.match(
    staffDuckScript,
    /data-heat-bag-dismiss\]"\)\.addEventListener\("click", \(\) => \{\s*heatBag\.hidden = true;/,
  );
  // The heat fact reads the server's round too, rather than assuming round one.
  assert.match(staffDuckScript, /result\.heat\.round === "FINAL" \? "Final" : "Round one"/);
  assert.doesNotMatch(staffDuckScript, /"Round one · Heat " \+ result\.heat\.number/);
  assert.doesNotMatch(staffDuckScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

// Scanning a withdrawn or disqualified duck is an expected race-day outcome,
// because that duck was bagged before its racer left and is still in the water.
test("the scanned-duck page presents an ineligible winner plainly, not as a failure", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));

  assert.match(staffDuckScript, /const ineligible = data\.winnerIneligible;/);
  assert.match(staffDuckScript, /if \(!candidate && ineligible\) \{/);
  assert.match(staffDuckScript, /winnerAction\.classList\.add\("ineligible"\)/);
  assert.match(staffDuckScript, /winnerAction\.classList\.remove\("ineligible"\)/);
  assert.match(
    staffDuckScript,
    /"Duck #" \+ data\.duck\.visibleNumber \+ " is " \+ ineligibleStatusLabel\(ineligible\.registrationStatus\)/,
  );
  // The heat is named the way staff name it in each round: a numbered round-one
  // heat, or simply "the final", of which there is only ever one.
  assert.match(
    staffDuckScript,
    /const heatLabel = ineligible\.round === "FINAL" \? "the final" : "Heat " \+ ineligible\.heatNumber;/,
  );
  assert.match(
    staffDuckScript,
    /\+ \(ineligible\.round === "FINAL" \? "a podium place in the final" : "the " \+ heatLabel \+ " winner"\)/,
  );
  assert.match(staffDuckScript, /this duck stays in its heat/);
  assert.match(staffDuckScript, /Scan the next duck to pass the finish line/);
  // The real status, never a generic word.
  const label = new Function(
    `${staffDuckScript.match(/const ineligibleStatusLabel = [\s\S]*?character\.toUpperCase\(\)\);/)[0]}\nreturn ineligibleStatusLabel;`,
  )();
  assert.equal(label("WITHDRAWN"), "Withdrawn");
  assert.equal(label("DISQUALIFIED"), "Disqualified");
  // No result command is offered for a duck that cannot win.
  assert.doesNotMatch(
    staffDuckScript.match(/if \(!candidate && ineligible\) \{[\s\S]*?return;\s*\}/)[0],
    /heat-winner|addEventListener/,
  );
});

// ---------------------------------------------------------------------------
// The other round-one result surface
//
// Round one is published by scanning a tag, so the staff duck page — not the
// finish-line form — is where a result taker stands when a heat has no winner
// left in it. "Scan the next duck" is the right answer for one refused duck and
// the wrong answer for a bag in which every duck will be refused: it walks a
// staffer through the whole heat, one DUCK_NOT_ELIGIBLE at a time, with nothing
// naming the way out.
// ---------------------------------------------------------------------------

const staffDuckWinnerHarness = () => {
  const document = new FakeDocument();
  const elements = {
    winnerAction: document.createElement("div"),
    message: document.createElement("p"),
  };
  const runtime = buildRuntime(
    [
      liftFrom(staffDuckScript, "text", /const text = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(
        staffDuckScript,
        "ineligibleStatusLabel",
        /const ineligibleStatusLabel = [\s\S]*?character\.toUpperCase\(\)\);/,
      ),
      liftFrom(
        staffDuckScript,
        "renderWinnerAction",
        /const renderWinnerAction = \(data, heatHasNoEligibleRacer = false\) => \{[\s\S]*?\n\};/,
      ),
      "let winnerSuccess = null;",
    ].join("\n").split("\n"),
    { document, ...elements },
    ["renderWinnerAction"],
  );
  return { ...elements, ...runtime };
};

const winnerBlockText = (block) => block.children.map((child) => child.textContent);

const ineligibleDuck = {
  duck: { visibleNumber: 202 },
  winnerAction: null,
  winnerIneligible: {
    eventId: "event",
    heatId: "heat-2",
    heatNumber: 2,
    raceEntryId: "entry-2",
    registrationStatus: "WITHDRAWN",
    visibleNumber: 202,
    participantDisplayName: "Daisy D.",
  },
};

test("the scanned-duck page sends the staffer on while somebody in the heat can still win", () => {
  const harness = staffDuckWinnerHarness();
  harness.renderWinnerAction(ineligibleDuck, false);

  assert.equal(harness.winnerAction.hidden, false);
  assert.deepEqual(winnerBlockText(harness.winnerAction), [
    "Duck #202 is Withdrawn",
    "Daisy D. cannot be recorded as the Heat 2 winner, and this duck stays in its heat.",
    "Scan the next duck to pass the finish line.",
  ]);
  assert.equal(harness.message.textContent, "This duck cannot win. Scan the next duck to pass the finish line.");
});

test("the scanned-duck page says nobody in the heat can win rather than looping the staffer", () => {
  const harness = staffDuckWinnerHarness();
  harness.renderWinnerAction(ineligibleDuck, true);

  assert.equal(harness.winnerAction.hidden, false);
  assert.deepEqual(winnerBlockText(harness.winnerAction), [
    "Duck #202 is Withdrawn",
    "Daisy D. cannot be recorded as the Heat 2 winner, and this duck stays in its heat.",
    "Nobody in Heat 2 can win",
    "Every racer in Heat 2 is withdrawn or disqualified, so every duck in that bag will be refused"
    + " and no result can be recorded. Every duck stays in its bag.",
    "Ask the race director to reactivate a racer, then scan that duck's tag again.",
  ]);
  // The instruction that produces the loop is gone from this surface entirely.
  assert.ok(!winnerBlockText(harness.winnerAction).includes("Scan the next duck to pass the finish line."));
  assert.equal(
    harness.message.textContent,
    "Nobody in Heat 2 can win. Ask the race director to reactivate a racer, then scan that duck's tag again.",
  );
  // Still no winner command anywhere on the page.
  assert.equal(harness.winnerAction.children.filter((child) => child.tagName === "BUTTON").length, 0);
});

test("the scanned-duck page asks the heat question only for a refused duck, and never guesses", async () => {
  const requested = [];
  const build = (responder) => buildRuntime(
    [
      rosterEligibilityHelpersScript,
      liftFrom(
        staffDuckScript,
        "winnerHeatHasNoEligibleRacer",
        /const winnerHeatHasNoEligibleRacer = async \(data\) => \{[\s\S]*?\n\};/,
      ),
    ].join("\n").split("\n"),
    {
      fetchJson: async (url) => {
        requested.push(url);
        return responder(url);
      },
    },
    ["winnerHeatHasNoEligibleRacer"],
  );

  const strandedHeat = build(() => ({
    roster: [
      { raceEntryId: "entry-1", eligible: false },
      { raceEntryId: "entry-2", eligible: false },
    ],
  }));
  assert.equal(await strandedHeat.winnerHeatHasNoEligibleRacer(ineligibleDuck), true);
  // It reads exactly the heat the server named, through the roster projection
  // the finish line reads, and asks nothing else.
  assert.deepEqual(requested, ["/api/v1/staff/events/event/heats/heat-2"]);

  // One eligible racer left is not a stranded heat: the next scan can still win.
  requested.length = 0;
  const liveHeat = build(() => ({
    roster: [
      { raceEntryId: "entry-1", eligible: false },
      { raceEntryId: "entry-2", eligible: true },
    ],
  }));
  assert.equal(await liveHeat.winnerHeatHasNoEligibleRacer(ineligibleDuck), false);

  // A roster projection from before the eligible field existed counts as
  // eligible, exactly as every other surface treats it, rather than declaring a
  // heat stranded on missing data.
  const legacyHeat = build(() => ({ roster: [{ raceEntryId: "entry-1" }] }));
  assert.equal(await legacyHeat.winnerHeatHasNoEligibleRacer(ineligibleDuck), false);

  // Nothing is asked for a duck the server did not refuse, or for a duck it
  // offered a winner action for: this costs a request, so it is spent only on
  // the case that needs it.
  requested.length = 0;
  const quiet = build(() => ({ roster: [] }));
  assert.equal(await quiet.winnerHeatHasNoEligibleRacer({ duck: { visibleNumber: 1 }, winnerIneligible: null }), false);
  assert.equal(await quiet.winnerHeatHasNoEligibleRacer({
    ...ineligibleDuck,
    winnerAction: { heatNumber: 2 },
  }), false);
  assert.equal(await quiet.winnerHeatHasNoEligibleRacer(null), false);
  assert.equal(await quiet.winnerHeatHasNoEligibleRacer({
    ...ineligibleDuck,
    winnerIneligible: { ...ineligibleDuck.winnerIneligible, heatId: null },
  }), false);
  assert.deepEqual(requested, []);

  // A failed or refused read makes no claim about the heat at all: the page says
  // exactly what it said before rather than inventing a dead end.
  const broken = build(() => { throw new Error("Heat not found."); });
  assert.equal(await broken.winnerHeatHasNoEligibleRacer(ineligibleDuck), false);
  const malformed = build(() => ({ roster: "nope" }));
  assert.equal(await malformed.winnerHeatHasNoEligibleRacer(ineligibleDuck), false);
});

test("the scanned-duck page resolves the heat before it paints, and stays DOM-safe", () => {
  assert.doesNotThrow(() => new Function(staffDuckScript));
  // The eligibility question is answered before anything is written, so the two
  // statements land together rather than one appearing under the staffer later.
  assert.match(
    staffDuckScript,
    /const heatHasNoEligibleRacer = await winnerHeatHasNoEligibleRacer\(duck\);\s*if \(qrStarting \|\| qrScanning\) return;/,
  );
  assert.match(staffDuckScript, /renderWinnerAction\(duck, heatHasNoEligibleRacer\)/);
  // One shared definition of "can this racer still win", not a second copy.
  assert.match(staffDuckScript, /const rosterEntryEligible = \(entry\) => !entry \|\| entry\.eligible !== false;/);
  assert.doesNotMatch(staffDuckScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

test("the finish line reports an ineligible duck as an outcome and stays armed", () => {
  assert.doesNotThrow(() => new Function(finishLineScript));
  assert.doesNotThrow(() => new Function(finishSelectionValidationScript));

  const { finishIneligibleLines } = new Function(
    `${finishSelectionValidationScript}; return { finishIneligibleLines };`,
  )();
  assert.deepEqual(finishIneligibleLines({
    visibleNumber: 12,
    registrationStatus: "WITHDRAWN",
    participantDisplayName: "Daisy D.",
  }), [
    "Duck #12 is Withdrawn",
    "Daisy D. cannot be recorded as a winner, and this duck stays in its heat.",
    "Scan the next duck to pass the finish line.",
  ]);
  assert.equal(finishIneligibleLines({
    visibleNumber: 7,
    registrationStatus: "DISQUALIFIED",
    participantDisplayName: "Donald D.",
  })[0], "Duck #7 is Disqualified");
  // Only the two statuses that mean "this racer left the race" are named. Any
  // other status still cannot be recorded, but announcing it by name would put
  // a word in front of a staffer that describes something else entirely.
  for (const status of ["SUBMITTED", "NO_SHOW", "", null, undefined]) {
    const lines = finishIneligibleLines({
      visibleNumber: 9,
      registrationStatus: status,
      participantDisplayName: "Daisy D.",
    });
    assert.equal(lines[0], "Duck #9 cannot be recorded", String(status));
    assert.equal(lines[1], "Daisy D. cannot be recorded as a winner, and this duck stays in its heat.");
    assert.equal(lines[2], "Scan the next duck to pass the finish line.");
  }
  assert.deepEqual(finishIneligibleLines(null), [
    "That duck cannot be recorded",
    "Scan the next duck to pass the finish line.",
  ]);

  // The client distinguishes the server's stable reason from a real failure.
  assert.match(finishLineScript, /const FINISH_DUCK_NOT_ELIGIBLE = "DUCK_NOT_ELIGIBLE";/);
  assert.match(finishLineScript, /failure\.reason = body && typeof body\.reason === "string" \? body\.reason : null/);
  assert.match(finishLineScript, /failure\.ineligible = body && body\.ineligible \? body\.ineligible : null/);
  assert.match(
    finishLineScript,
    /if \(error\.reason === FINISH_DUCK_NOT_ELIGIBLE\) \{\s*finishShowIneligible\(error\);\s*return;\s*\}/,
  );
  // Nothing about that path disarms the station, drops the heat, or needs
  // clearing: the scan form, the NFC button, and the heat all stay as they are.
  const handler = finishLineScript.match(/const finishShowIneligible = \([\s\S]*?\n\};/)[0];
  assert.doesNotMatch(handler, /finishHeat = null|finishEvent = null|finishNfcButton|finishSetScanBusy|hidden = true/);
  assert.match(handler, /finishIneligible\.hidden = false/);
  assert.match(handler, /finishMessage\.textContent = "Scan the next duck to pass the finish line\."/);
  // A good scan and a new heat clear it again without any operator action.
  assert.match(finishLineScript, /finishSelected\.push\(\{ \.\.\.selection, place: captured\.intendedPlace \}\);\s*finishClearIneligible\(\);/);

  // A racer withdrawn between selecting and submitting drops exactly that
  // selection, renumbers the rest, and leaves the station taking scans.
  assert.match(
    finishLineScript,
    /const dropped = error\.ineligibleRaceEntryIds;\s*finishSelected = finishSelected\s*\.filter\(\(selection\) => !dropped\.includes\(selection\.raceEntryId\)\)\s*\.map\(\(selection, index\) => \(\{ \.\.\.selection, place: index \+ 1 \}\)\);/,
  );
  assert.doesNotMatch(finishLineScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
});

// ---------------------------------------------------------------------------
// Roster eligibility markers
//
// A withdrawn or disqualified racer is never removed from a staff roster: their
// duck was sealed into the numbered heat bag at pairing, it keeps its slot, and
// it still floats down the river. Every staff surface therefore has to say, in
// words a staffer can act on at a glance, that this one cannot be recorded as a
// winner. These tests run the shipped render helpers, lifted out of the
// generated script rather than copied, over the whole matrix: eligible,
// ineligible, and a projection that does not carry the field at all.
// ---------------------------------------------------------------------------

const liftFrom = (source, label, pattern) => {
  const match = source.match(pattern);
  assert.ok(match, `the shipped client defines ${label}`);
  return match[0];
};

const buildRuntime = (parts, injected, returned) => {
  const names = Object.keys(injected);
  return new Function(...names, `${parts.join("\n")}\nreturn { ${returned.join(", ")} };`)(
    ...names.map((name) => injected[name]),
  );
};

// The exact wording every surface shares, asserted once so a drift in the
// sentence fails here rather than in four separate places.
const INELIGIBLE_NOTE =
  "The duck stays in its heat bag and still races, but cannot be recorded as a winner.";

const markerOf = (container) => {
  const flag = container.children.find((child) => child.className === "roster-flag");
  const note = container.children.find((child) => child.className === "roster-flag-note");
  return flag === undefined ? null : { flag: flag.textContent, note: note?.textContent ?? null };
};

test("the shared roster marker fires only on an explicit eligible:false", () => {
  const { rosterIneligibleMarker, rosterStatusWord } = new Function(
    `${rosterEligibilityHelpersScript}; return { rosterIneligibleMarker, rosterStatusWord };`,
  )();

  // The real status word, never a generic one.
  assert.equal(rosterStatusWord("WITHDRAWN"), "Withdrawn");
  assert.equal(rosterStatusWord("DISQUALIFIED"), "Disqualified");

  assert.deepEqual(rosterIneligibleMarker({ eligible: false, registrationStatus: "WITHDRAWN" }, "Do not announce"), {
    status: "Withdrawn",
    flag: "Do not announce · Withdrawn",
    note: INELIGIBLE_NOTE,
  });
  // The status may sit on the entry or on its nested participant, because the
  // staff projections differ, and both must produce the same marker.
  assert.equal(
    rosterIneligibleMarker({ eligible: false, participant: { registrationStatus: "DISQUALIFIED" } }, "Cannot win").flag,
    "Cannot win · Disqualified",
  );

  // Anything that is not an explicit false renders exactly as it did before.
  assert.equal(rosterIneligibleMarker({ eligible: true, registrationStatus: "ACTIVE" }, "Racer out"), null);
  assert.equal(rosterIneligibleMarker({}, "Racer out"), null);
  assert.equal(rosterIneligibleMarker({ registrationStatus: "WITHDRAWN" }, "Racer out"), null);
  assert.equal(rosterIneligibleMarker(undefined, "Racer out"), null);
  assert.equal(rosterIneligibleMarker(null, "Racer out"), null);

  // A status the client has never heard of still yields a usable word instead
  // of an empty marker or a throw.
  assert.equal(rosterIneligibleMarker({ eligible: false, registrationStatus: "NO_SHOW" }, "Cannot win").flag, "Cannot win · No show");
  assert.equal(rosterIneligibleMarker({ eligible: false }, "Cannot win").flag, "Cannot win · Not eligible");
});

const announcerRosterHarness = () => {
  const document = new FakeDocument();
  const announcerHeatTitle = document.createElement("h2");
  const announcerCueLine = document.createElement("p");
  const announcerRosterList = document.createElement("ul");
  const runtime = buildRuntime(
    [
      rosterEligibilityHelpersScript,
      announcerHelpersScript,
      liftFrom(announcerScript, "announcerText", /const announcerText = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(announcerScript, "announcerLine", /const announcerLine = \(label, name, duckNumber, className\) => \{[\s\S]*?\n\};/),
      liftFrom(announcerScript, "announcerRenderCurrent", /const announcerRenderCurrent = \(event, current\) => \{[\s\S]*?\n\};/),
    ],
    { document, announcerHeatTitle, announcerCueLine, announcerRosterList },
    ["announcerRenderCurrent"],
  );
  return { announcerRosterList, render: runtime.announcerRenderCurrent };
};

test("the announcer roster tells the microphone not to call an ineligible racer", () => {
  const harness = announcerRosterHarness();
  harness.render({ id: "event", status: "ROUND_ONE" }, {
    heat: { round: "ROUND_ONE", number: 2, status: "CALLING" },
    roster: [
      { slotNumber: 1, displayName: "Ada Lovelace", duckNumber: 101, registrationStatus: "ACTIVE", eligible: true },
      { slotNumber: 2, displayName: "Grace Hopper", duckNumber: 102, registrationStatus: "WITHDRAWN", eligible: false },
      { slotNumber: 3, displayName: "Alan Turing", duckNumber: 103, registrationStatus: "DISQUALIFIED", eligible: false },
      // A projection from before the field existed must paint unchanged.
      { slotNumber: 4, displayName: "Edsger Dijkstra", duckNumber: 104 },
    ],
  });

  const rows = harness.announcerRosterList.children;
  assert.equal(rows.length, 4);

  // The eligible racer and the field-less entry are untouched: no marker, no
  // class, and the same three spoken parts as before.
  for (const index of [0, 3]) {
    assert.equal(rows[index].className, "");
    assert.equal(markerOf(rows[index]), null);
    assert.equal(rows[index].children.length, 3);
  }
  assert.equal(rows[0].children[1].textContent, "Ada Lovelace");

  // The withdrawn racer keeps their slot, their name, and their duck number —
  // the announcer still has to see the roster the bags were filled from — and
  // gains an unmissable instruction naming the real status.
  assert.equal(rows[1].className, "ineligible");
  assert.equal(rows[1].children[0].textContent, "Slot 2");
  assert.equal(rows[1].children[1].textContent, "Grace Hopper");
  assert.equal(rows[1].children[2].textContent, "Duck #102");
  assert.deepEqual(markerOf(rows[1]), {
    flag: "Do not announce · Withdrawn",
    note: INELIGIBLE_NOTE,
  });
  // The marker is a STRONG element, so it is emphatic without any styling.
  assert.equal(rows[1].children[3].tagName, "STRONG");

  assert.equal(rows[2].className, "ineligible");
  assert.equal(markerOf(rows[2]).flag, "Do not announce · Disqualified");
});

const startLineRosterHarness = () => {
  const document = new FakeDocument();
  const elements = {
    startEvent: document.createElement("p"),
    startHeatTitle: document.createElement("h2"),
    startFacts: document.createElement("dl"),
    startRoster: document.createElement("ul"),
    startAction: document.createElement("div"),
    startMessage: document.createElement("p"),
  };
  const runtime = buildRuntime(
    [
      rosterEligibilityHelpersScript,
      stationStateHelpersScript,
      liftFrom(startLineScript, "startText", /const startText = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(startLineScript, "startHumanize", /const startHumanize = \(value\) => .*;\n/),
      liftFrom(startLineScript, "startAddFact", /const startAddFact = \(label, value\) => \{[\s\S]*?\n\};/),
      "let startRenderKey = null;",
      liftFrom(startLineScript, "startRender", /const startRender = \(event, detail\) => \{[\s\S]*?\n\};/),
    ],
    {
      document,
      ...elements,
      appConfirm: async () => true,
      startCommand: async () => ({}),
      startLoad: async () => {},
    },
    ["startRender"],
  );
  return { ...elements, render: runtime.startRender };
};

const startRosterEntry = (slotNumber, lastName, visibleNumber, extra = {}) => ({
  slotNumber,
  raceEntryId: `entry-${slotNumber}`,
  participant: { firstName: "Racer", lastName, registrationStatus: "ACTIVE" },
  duck: { id: `duck-${visibleNumber}`, visibleNumber },
  ...extra,
});

test("the start line marks a racer who left so the bag can be reconciled", () => {
  const harness = startLineRosterHarness();
  harness.render({ id: "event", name: "Annual Duck Race", status: "ROUND_ONE" }, {
    heat: { id: "heat-1", round: "ROUND_ONE", number: 1, status: "LOADING", revision: 0 },
    roster: [
      startRosterEntry(1, "Active", 101, { eligible: true }),
      startRosterEntry(2, "Gone", 102, {
        eligible: false,
        participant: { firstName: "Racer", lastName: "Gone", registrationStatus: "WITHDRAWN" },
      }),
      startRosterEntry(3, "Barred", 103, {
        eligible: false,
        participant: { firstName: "Racer", lastName: "Barred", registrationStatus: "DISQUALIFIED" },
      }),
      startRosterEntry(4, "Legacy", 104),
    ],
  });

  const rows = harness.startRoster.children;
  assert.equal(rows.length, 4, "no roster entry is ever dropped from a staff station");
  // Slots are never renumbered or reordered around a racer who left.
  assert.deepEqual(rows.map((row) => row.textContent), [
    "Slot 1 · Racer Active · Duck #101",
    "Slot 2 · Racer Gone · Duck #102",
    "Slot 3 · Racer Barred · Duck #103",
    "Slot 4 · Racer Legacy · Duck #104",
  ]);

  for (const index of [0, 3]) {
    assert.equal(rows[index].className, "");
    assert.equal(markerOf(rows[index]), null);
    assert.equal(rows[index].children.length, 0);
  }
  assert.equal(rows[1].className, "ineligible");
  assert.deepEqual(markerOf(rows[1]), { flag: "Racer out · Withdrawn", note: INELIGIBLE_NOTE });
  assert.equal(rows[2].className, "ineligible");
  assert.equal(markerOf(rows[2]).flag, "Racer out · Disqualified");

  // Marking a racer changes nothing else about the station: the roster count
  // and the one legal action are exactly what they were.
  assert.equal(harness.startFacts.children[1].children[1].textContent, "4");
  assert.equal(harness.startAction.children[0].textContent, "Mark Heat Ready");
});

test("the start line repaints when a racer on its locked roster withdraws", () => {
  const harness = startLineRosterHarness();
  const event = { id: "event", name: "Annual Duck Race", status: "ROUND_ONE" };
  // A locked, running heat: nothing about the heat row changes when a racer on
  // it leaves, so the status and the revision below are deliberately identical.
  const heat = { id: "heat-1", round: "ROUND_ONE", number: 1, status: "CALLING", revision: 4 };
  const before = [startRosterEntry(1, "Active", 101, { eligible: true }), startRosterEntry(2, "Leaving", 102, { eligible: true })];
  harness.render(event, { heat, roster: before });
  assert.equal(markerOf(harness.startRoster.children[1]), null);

  // An unchanged payload is still discarded, so a live signal cannot churn the
  // station or steal focus from the one action button.
  const action = harness.startAction.children[0];
  harness.render(event, { heat, roster: before });
  assert.equal(harness.startAction.children[0], action);

  harness.render(event, {
    heat,
    roster: [
      before[0],
      startRosterEntry(2, "Leaving", 102, {
        eligible: false,
        participant: { firstName: "Racer", lastName: "Leaving", registrationStatus: "WITHDRAWN" },
      }),
    ],
  });
  assert.equal(harness.startRoster.children.length, 2);
  assert.deepEqual(markerOf(harness.startRoster.children[1]), {
    flag: "Racer out · Withdrawn",
    note: INELIGIBLE_NOTE,
  });
});

const finalistHarness = (finalists) => {
  const document = new FakeDocument();
  const finalistList = document.createElement("div");
  const finalistCard = document.createElement("section");
  const runtime = buildRuntime(
    [
      rosterEligibilityHelpersScript,
      liftFrom(staffHomeScript, "text", /const text = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(staffHomeScript, "empty", /const empty = \(message\) => .*;\n/),
      liftFrom(staffHomeScript, "historyCard", /const historyCard = \(title, detail\) => \{[\s\S]*?\n\};/),
      liftFrom(staffHomeScript, "finalistsExist", /const finalistsExist = \(\) => .*;\n/),
      liftFrom(staffHomeScript, "loadFinalists", /const loadFinalists = async \(\) => \{[\s\S]*?\n\};/),
    ],
    {
      document,
      finalistList,
      finalistCard,
      currentEvent: { id: "event", status: "FINAL" },
      api: async () => ({ finalists }),
    },
    ["loadFinalists"],
  );
  return { finalistList, finalistCard, loadFinalists: runtime.loadFinalists };
};

const finalist = (slotNumber, lastName, visibleNumber, extra = {}) => ({
  raceEntryId: `entry-${slotNumber}`,
  slotNumber,
  participant: { firstName: "Racer", lastName, registrationStatus: "ACTIVE" },
  duck: { visibleNumber },
  qualifiedFrom: { heatId: `heat-${slotNumber}`, heatNumber: slotNumber },
  podiumPlace: null,
  ...extra,
});

test("the console finalist list marks a finalist who can no longer win", async () => {
  const harness = finalistHarness([
    finalist(1, "Active", 101, { eligible: true }),
    finalist(2, "Gone", 102, {
      eligible: false,
      participant: { firstName: "Racer", lastName: "Gone", registrationStatus: "WITHDRAWN" },
    }),
    finalist(3, "Legacy", 103),
  ]);
  await harness.loadFinalists();

  const cards = harness.finalistList.children;
  assert.equal(cards.length, 3, "a finalist who left keeps their slot in the final");
  assert.equal(cards[0].className, "data-card");
  assert.equal(markerOf(cards[0]), null);
  assert.equal(cards[0].children[0].textContent, "Slot 1 · Duck #101");

  assert.equal(cards[1].className, "data-card ineligible");
  assert.equal(cards[1].children[0].textContent, "Slot 2 · Duck #102");
  assert.equal(cards[1].children[1].textContent, "Racer Gone · won Heat 2");
  assert.deepEqual(markerOf(cards[1]), { flag: "Cannot win · Withdrawn", note: INELIGIBLE_NOTE });

  // A projection without the field is untouched.
  assert.equal(cards[2].className, "data-card");
  assert.equal(markerOf(cards[2]), null);
});

const readinessHarness = ({ readiness, eventStatus = "REGISTRATION_CLOSED" }) => {
  const document = new FakeDocument();
  const readinessList = document.createElement("div");
  const runtime = buildRuntime(
    [
      eventLifecycleHelpersScript,
      liftFrom(staffHomeScript, "text", /const text = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(staffHomeScript, "humanize", /const humanize = \(value\) => [^;]+;/),
      liftFrom(staffHomeScript, "lifecycleLabels", /const lifecycleLabels = \{[\s\S]*?\n\};/),
      liftFrom(staffHomeScript, "renderReadiness", /const renderReadiness = \(readiness\) => \{[\s\S]*?\n\};/),
    ],
    {
      document,
      readinessList,
      currentEvent: { id: "event", name: "Annual Duck Race", status: eventStatus },
      canDirectRace: false,
      isSystemAdmin: false,
      eventSelect: { value: "event" },
      appConfirm: async () => true,
      api: async () => ({}),
      setMessage: () => {},
      loadEvents: async () => {},
      renderLifecycleResult: () => {},
    },
    ["renderReadiness"],
  );
  return { readinessList, renderReadiness: runtime.renderReadiness };
};

const readinessState = (overrides = {}) => ({
  command: "START_ROUND_ONE",
  fromStatus: "REGISTRATION_CLOSED",
  toStatus: "ROUND_ONE",
  requiresAdmin: false,
  allowed: true,
  blockers: [],
  notes: [],
  ...overrides,
});

const readinessNote =
  "1 racer on a round-one roster is withdrawn or disqualified. That duck stays in its heat"
  + " bag and races as normal, but cannot be recorded as a winner.";

test("readiness notes render as information, never as a blocking reason", () => {
  const harness = readinessHarness({
    readiness: { "start-round-one": readinessState({ notes: [readinessNote] }) },
  });
  harness.renderReadiness({ "start-round-one": readinessState({ notes: [readinessNote] }) });

  const [card] = harness.readinessList.children;
  assert.equal(card.children[0].textContent, "Start round one");
  // A note never turns the action into a blocker: the chip still reads Ready.
  assert.equal(card.children[1].textContent, "Ready");
  assert.equal(card.children[1].className, "status-chip ready");
  const note = card.children[2];
  assert.equal(note.tagName, "P");
  assert.equal(note.textContent, readinessNote);
  assert.equal(note.className, "readiness-note", "a note must not wear the blocker treatment");
  assert.equal(card.children.filter((child) => child.className === "muted").length, 0);
});

test("readiness notes sit beside blockers without being mistaken for them", () => {
  const blocker = "At least one round-one heat is required.";
  const state = readinessState({ allowed: false, blockers: [blocker], notes: [readinessNote] });
  const harness = readinessHarness({ readiness: { "start-round-one": state } });
  harness.renderReadiness({ "start-round-one": state });

  const [card] = harness.readinessList.children;
  assert.equal(card.children[1].textContent, "Blocked");
  // Blockers keep their existing muted treatment and come first; the note keeps
  // its own class, so the two can never read as the same thing.
  assert.deepEqual(
    card.children.slice(2).map((child) => [child.className, child.textContent]),
    [["muted", blocker], ["readiness-note", readinessNote]],
  );
});

test("a readiness response without notes renders exactly as it did before", () => {
  const withoutNotes = { command: "START_ROUND_ONE", fromStatus: "REGISTRATION_CLOSED", toStatus: "ROUND_ONE", requiresAdmin: false, allowed: true, blockers: [] };
  const harness = readinessHarness({ readiness: { "start-round-one": withoutNotes } });
  assert.doesNotThrow(() => harness.renderReadiness({ "start-round-one": withoutNotes }));
  const [card] = harness.readinessList.children;
  assert.equal(card.children.length, 2);
  // A malformed notes value is ignored rather than thrown on, because one throw
  // inside a render silently kills every control after it.
  assert.doesNotThrow(() => harness.renderReadiness({
    "start-round-one": readinessState({ notes: "not an array" }),
  }));
  assert.equal(harness.readinessList.children[0].children.length, 2);
});

// Every surface on the console client checks for its own markup before touching
// it, because the client also runs on the registration desk and one throw inside
// a render silently kills every control after it. `renderLifecycleResult` is
// only reachable from a button `renderReadiness` builds, and that function
// returns early when the list is absent — but the guard is the repository rule,
// not an argument about reachability, and the cost of being wrong is invisible.
const lifecycleResultHarness = (readinessList) => {
  const document = new FakeDocument();
  const rendered = [];
  const runtime = buildRuntime(
    [
      liftFrom(staffHomeScript, "text", /const text = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(staffHomeScript, "empty", /const empty = \(message\) => .*;\n/),
      liftFrom(staffHomeScript, "renderLifecycleResult", /const renderLifecycleResult = \(event\) => \{[\s\S]*?\n\};/),
    ],
    {
      document,
      readinessList,
      currentEventDetail: { event: { id: "event", status: "REGISTRATION_CLOSED" } },
      renderEvent: (detail) => {
        rendered.push(detail.event.status);
        return true;
      },
    },
    ["renderLifecycleResult"],
  );
  return { rendered, renderLifecycleResult: runtime.renderLifecycleResult };
};

test("a lifecycle transition renders without a readiness list on the page", () => {
  const document = new FakeDocument();
  const readinessList = document.createElement("div");
  const present = lifecycleResultHarness(readinessList);
  assert.equal(present.renderLifecycleResult({ id: "event", status: "ROUND_ONE" }), true);
  assert.deepEqual(present.rendered, ["ROUND_ONE"]);
  assert.equal(readinessList.children[0].textContent, "Refreshing lifecycle actions…");
  assert.equal(readinessList.children[0].className, "empty-state");

  // The page that loads this client without the Event Details view must still
  // get its event re-rendered rather than a thrown property read.
  const absent = lifecycleResultHarness(null);
  assert.equal(absent.renderLifecycleResult({ id: "event", status: "ROUND_ONE" }), true);
  assert.deepEqual(absent.rendered, ["ROUND_ONE"], "the event still repaints");

  // An event that is not the loaded one is refused before anything is touched.
  assert.equal(absent.renderLifecycleResult({ id: "other-event", status: "FINAL" }), false);
  assert.deepEqual(absent.rendered, ["ROUND_ONE"]);
});

test("the roster marker never reaches for an unsafe DOM sink", () => {
  assert.doesNotThrow(() => new Function(rosterEligibilityHelpersScript));
  assert.doesNotMatch(rosterEligibilityHelpersScript, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  // Every marked surface builds its nodes through the same textContent factory.
  for (const script of [announcerScript, startLineScript, finishLineScript, staffHomeScript]) {
    assert.match(script, /const rosterMarkIneligible = \(container, entry, lead, text\) => \{/);
    assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  }
  // Staff see everyone. No surface filters an ineligible entry out of a roster.
  assert.doesNotMatch(announcerScript, /roster\.filter\(/);
  assert.doesNotMatch(startLineScript, /roster\.filter\(/);
});

// ---------------------------------------------------------------------------
// The finish line: how deep the podium is, and who is marked on it
//
// The station that decides who won is the one place where getting the number of
// places wrong is unrecoverable. The server sizes the final podium by the
// racers who can still take a place; if this client sizes it by the whole
// roster it demands a place whose duck answers every scan with
// DUCK_NOT_ELIGIBLE, Submit never enables, and the event has no way to finish.
// ---------------------------------------------------------------------------

const finishLineRenderHarness = () => {
  const document = new FakeDocument();
  const elements = {
    finishEventLabel: document.createElement("p"),
    finishHeatTitle: document.createElement("h2"),
    finishFacts: document.createElement("dl"),
    finishRoster: document.createElement("ul"),
    finishAction: document.createElement("div"),
    finishScanForm: document.createElement("form"),
    finishSelections: document.createElement("div"),
    finishSubmit: document.createElement("button"),
    finishMessage: document.createElement("p"),
    finishIneligible: document.createElement("div"),
    // The prominent finished-heat workflow and the acknowledgement a winner
    // recorded on a duck's own page comes back to. Both are separate regions
    // from the message line, which every scan and every repaint overwrites.
    finishCallout: document.createElement("section"),
    finishRecorded: document.createElement("section"),
  };
  const runtime = buildRuntime(
    [
      rosterEligibilityHelpersScript,
      stationStateHelpersScript,
      podiumPlaceHelpersScript,
      liftFrom(finishLineScript, "finishText", /const finishText = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(finishLineScript, "finishHumanize", /const finishHumanize = \(value\) => .*;\n/),
      liftFrom(finishLineScript, "finishPlaceLabel", /const finishPlaceLabel = \(place\) => .*;\n/),
      liftFrom(finishLineScript, "finishClearIneligible", /const finishClearIneligible = \(\) => \{[\s\S]*?\n\};/),
      liftFrom(finishLineScript, "finishAddFact", /const finishAddFact = \(label, value\) => \{[\s\S]*?\n\};/),
      liftFrom(finishLineScript, "finishEligibleEntries", /const finishEligibleEntries = \(\) => .*;\n/),
      liftFrom(finishLineScript, "finishRequiredPlaces", /const finishRequiredPlaces = \(\) => [\s\S]*?;\n/),
      liftFrom(
        finishLineScript,
        "FINISH_NO_ELIGIBLE_MESSAGE",
        /const FINISH_NO_ELIGIBLE_MESSAGE = [\s\S]*?;\n/,
      ),
      liftFrom(finishLineScript, "finishPodiumScanned", /const finishPodiumScanned = \(\) => [\s\S]*?;\n/),
      liftFrom(finishLineScript, "finishSubmitBlocked", /const finishSubmitBlocked = \(busy\) => \{[\s\S]*?\n\};/),
      liftFrom(
        finishLineScript,
        "finishRenderScannedPodium",
        /const finishRenderScannedPodium = \(focusedRaceEntry\) => \{[\s\S]*?\n\};/,
      ),
      liftFrom(finishLineScript, "finishRenderSelections", /const finishRenderSelections = \(\) => \{[\s\S]*?\n\};/),
      // The finished-heat workflow. These are lifted rather than described,
      // because the whole point of the callout is the exact words it says.
      liftFrom(
        finishLineScript,
        "FINISH_WINNER_SCAN_INSTRUCTION",
        /const FINISH_WINNER_SCAN_INSTRUCTION = [\s\S]*?;\n/,
      ),
      liftFrom(
        finishLineScript,
        "FINISH_FINALISTS_BAG_INSTRUCTION",
        /const FINISH_FINALISTS_BAG_INSTRUCTION = [\s\S]*?;\n/,
      ),
      liftFrom(
        finishLineScript,
        "FINISH_MANUAL_LAST_RESORT_HEADING",
        /const FINISH_MANUAL_LAST_RESORT_HEADING = [\s\S]*?;\n/,
      ),
      liftFrom(
        finishLineScript,
        "FINISH_MANUAL_LAST_RESORT_NOTE",
        /const FINISH_MANUAL_LAST_RESORT_NOTE = [\s\S]*?;\n/,
      ),
      liftFrom(
        finishLineScript,
        "finishRenderManualFallback",
        /const finishRenderManualFallback = \(\) => \{[\s\S]*?\n\};/,
      ),
      liftFrom(finishLineScript, "finishRenderCallout", /const finishRenderCallout = \(\) => \{[\s\S]*?\n\};/),
      liftFrom(finishLineScript, "finishRender", /const finishRender = \(event, detail\) => \{[\s\S]*?\n\};/),
      "let finishEvent = null; let finishHeat = null; let finishRosterEntries = [];",
      "let finishSelected = []; let finishRenderKey = null; let finishScanBusy = false;",
      "let finishPodium = null; let finishCommandBusy = false;",
      // The clear control is wired but never pressed by these render tests; the
      // command it sends is covered by the real handler integration tests.
      "const finishClearPodiumPlace = async () => {};",
      // Same for the manual winner command. These tests prove the control is
      // built, populated, and wired; the write it performs is covered by the
      // real-handler integration tests, which is where authorization, revision,
      // idempotency, audit, and promotion actually live.
      "const manualWinnerCalls = [];",
      "const finishRecordManualWinner = async (select, button) =>"
      + " manualWinnerCalls.push({ raceEntryId: select.value, button });",
      "const selectFor = (raceEntryId, place, visibleNumber) =>"
      + " finishSelected.push({ raceEntryId, place, visibleNumber, participantDisplayName: 'Racer ' + raceEntryId });",
      "const requiredPlaces = () => finishRequiredPlaces();",
      "const selectedPlaces = () => finishSelected.map((selection) => selection.raceEntryId + ':' + selection.place);",
      "const submitBlocked = () => finishSubmitBlocked(false);",
    ].join("\n").split("\n"),
    {
      document,
      ...elements,
      finishSubscription: null,
      globalThis: { quickDucksLive: { beginBusy: () => () => {} } },
    },
    [
      "finishRender",
      "requiredPlaces",
      "selectFor",
      "selectedPlaces",
      "submitBlocked",
      "manualWinnerCalls",
      "FINISH_NO_ELIGIBLE_MESSAGE",
      "FINISH_WINNER_SCAN_INSTRUCTION",
      "FINISH_FINALISTS_BAG_INSTRUCTION",
      "FINISH_MANUAL_LAST_RESORT_HEADING",
      "FINISH_MANUAL_LAST_RESORT_NOTE",
    ],
  );
  return { ...elements, ...runtime };
};

// The callout's parts, read back out of whatever it painted. The fallback is
// found by its own marker rather than by position, so adding a line to the
// instruction above it cannot silently retarget these assertions.
const calloutOf = (harness) => {
  const fallback = harness.finishCallout.children.find((child) => child.dataset.finishManual === "true");
  const select = fallback?.children.find((child) => child.tagName === "SELECT") ?? null;
  return {
    fallback,
    select,
    lines: harness.finishCallout.children
      .filter((child) => child !== fallback)
      .map((child) => child.textContent),
    button: fallback?.children.find((child) => child.dataset.finishManualSubmit === "true") ?? null,
    options: select === null
      ? []
      : select.children.map((option) => ({ value: option.value, label: option.textContent })),
  };
};

// The default `final` seed exactly: three finalists, one duck each.
const finalistEntry = (slotNumber, lastName, visibleNumber, extra = {}) => ({
  slotNumber,
  raceEntryId: `entry-${slotNumber}`,
  participant: { firstName: "Racer", lastName, registrationStatus: "ACTIVE" },
  duck: { id: `duck-${visibleNumber}`, visibleNumber },
  eligible: true,
  ...extra,
});

const withdrawn = (entry) => ({
  ...entry,
  eligible: false,
  participant: { ...entry.participant, registrationStatus: "WITHDRAWN" },
});

// The exact sentence the station says when no racer in the heat can win. It is
// written out here rather than read back out of the shipped script, so a silent
// drift in the wording fails this file instead of quietly changing what a
// staffer is told at the one moment they cannot work it out for themselves.
const NO_ELIGIBLE_MESSAGE = "Nobody in this heat can win:"
  + " every racer in it is withdrawn or disqualified, so no result can be recorded."
  + " Every duck stays in its bag."
  + " Ask the race director to reactivate a racer, then this station can take the result.";

const finalEvent = { id: "event", name: "Annual Duck Race", status: "FINAL" };
const finalHeat = { id: "final-heat", round: "FINAL", number: 1, status: "AWAITING_RESULT", revision: 7 };
const factValue = (facts, label) => facts.children
  .find((fact) => fact.children[0].textContent === label)?.children[1].textContent ?? null;

test("the finish line requires as many places as there are racers who can win", () => {
  const harness = finishLineRenderHarness();
  const roster = [
    finalistEntry(1, "Active", 101),
    finalistEntry(2, "Leaving", 102),
    finalistEntry(3, "Racing", 103),
  ];
  harness.finishRender(finalEvent, { heat: finalHeat, roster });
  assert.equal(harness.requiredPlaces(), 3);
  assert.equal(factValue(harness.finishFacts, "Required result"), "3 podium places");

  // One finalist withdraws. Nothing about the heat changes — same id, same
  // status, same revision — but the third place can now never be filled: the
  // server refuses that duck with DUCK_NOT_ELIGIBLE and requires two places.
  harness.finishRender(finalEvent, { heat: finalHeat, roster: [roster[0], withdrawn(roster[1]), roster[2]] });
  assert.equal(harness.requiredPlaces(), 2, "the podium is as deep as the racers who can take a place");
  assert.equal(factValue(harness.finishFacts, "Required result"), "2 podium places");
  assert.match(harness.finishMessage.textContent, /select 2 distinct ducks here/);

  // The roster itself is untouched: every duck is still in the bag, still in
  // the water, and still listed in its own slot.
  assert.equal(harness.finishRoster.children.length, 3);
  assert.deepEqual(harness.finishRoster.children.map((row) => row.children[0]?.textContent ?? null), [
    null,
    "Cannot win · Withdrawn",
    null,
  ]);

  // Two selections now arm Submit, which sizing by the whole roster never would.
  harness.selectFor("entry-1", 1, 101);
  harness.selectFor("entry-3", 2, 103);
  harness.finishRender(finalEvent, {
    heat: { ...finalHeat, revision: 7 },
    roster: [roster[0], withdrawn(roster[1]), roster[2], finalistEntry(4, "Spare", 104)],
  });
  assert.equal(harness.requiredPlaces(), 3, "a fourth eligible racer restores the third place");
});

test("the finish line marks a racer who can no longer win on the roster it decides from", () => {
  const harness = finishLineRenderHarness();
  harness.finishRender(finalEvent, {
    heat: finalHeat,
    roster: [
      finalistEntry(1, "Active", 101),
      withdrawn(finalistEntry(2, "Gone", 102)),
      {
        ...finalistEntry(3, "Barred", 103),
        eligible: false,
        participant: { firstName: "Racer", lastName: "Barred", registrationStatus: "DISQUALIFIED" },
      },
      // A projection from before the field existed paints exactly as before,
      // and counts toward the podium rather than silently shrinking it.
      { ...finalistEntry(4, "Legacy", 104), eligible: undefined },
    ],
  });

  const rows = harness.finishRoster.children;
  assert.equal(rows.length, 4, "no roster entry is ever dropped from a staff station");
  assert.deepEqual(rows.map((row) => row.textContent), [
    "Slot 1 · Racer Active · Duck #101",
    "Slot 2 · Racer Gone · Duck #102",
    "Slot 3 · Racer Barred · Duck #103",
    "Slot 4 · Racer Legacy · Duck #104",
  ]);
  for (const index of [0, 3]) {
    assert.equal(rows[index].className, "");
    assert.equal(markerOf(rows[index]), null);
  }
  assert.equal(rows[1].className, "ineligible");
  assert.deepEqual(markerOf(rows[1]), { flag: "Cannot win · Withdrawn", note: INELIGIBLE_NOTE });
  assert.equal(markerOf(rows[2]).flag, "Cannot win · Disqualified");
  // Two of four can win, so the podium is two deep, not three.
  assert.equal(harness.requiredPlaces(), 2);
});

test("the finish line repaints when a racer withdraws during AWAITING_RESULT", () => {
  const harness = finishLineRenderHarness();
  const roster = [
    finalistEntry(1, "Active", 101),
    finalistEntry(2, "Leaving", 102),
    finalistEntry(3, "Racing", 103),
  ];
  harness.finishRender(finalEvent, { heat: finalHeat, roster });
  assert.equal(markerOf(harness.finishRoster.children[1]), null);

  // An unchanged payload is still discarded, so a live signal cannot churn the
  // station or wipe reviewed selections under a staffer's hands.
  harness.selectFor("entry-1", 1, 101);
  harness.finishRender(finalEvent, { heat: finalHeat, roster });
  assert.deepEqual(harness.selectedPlaces(), ["entry-1:1"], "an identical payload is a no-op");

  // Withdrawing changes neither the heat status nor its revision. Without
  // eligibility in the render key this repaint is thrown away and the station
  // keeps an unmarked racer and an impossible third place on screen.
  harness.finishRender(finalEvent, { heat: finalHeat, roster: [roster[0], withdrawn(roster[1]), roster[2]] });
  assert.deepEqual(markerOf(harness.finishRoster.children[1]), {
    flag: "Cannot win · Withdrawn",
    note: INELIGIBLE_NOTE,
  });
  assert.equal(harness.requiredPlaces(), 2);
  // The reviewed selection is a different racer, so it survives untouched.
  assert.deepEqual(harness.selectedPlaces(), ["entry-1:1"]);
});

test("a reviewed selection whose racer leaves is dropped and the places close up", () => {
  const harness = finishLineRenderHarness();
  const roster = [
    finalistEntry(1, "Leaving", 101),
    finalistEntry(2, "Active", 102),
    finalistEntry(3, "Racing", 103),
  ];
  harness.finishRender(finalEvent, { heat: finalHeat, roster });
  harness.selectFor("entry-1", 1, 101);
  harness.selectFor("entry-2", 2, 102);

  harness.finishRender(finalEvent, { heat: finalHeat, roster: [withdrawn(roster[0]), roster[1], roster[2]] });
  // First place left the race, so second place moves up rather than leaving a
  // gap at place 1 that the server would refuse outright.
  assert.deepEqual(harness.selectedPlaces(), ["entry-2:1"]);
  assert.equal(harness.requiredPlaces(), 2);
  assert.equal(harness.finishSubmit.disabled, true, "one of two places is not a submittable podium");
});

test("a final whose racers have all left says so instead of arming an empty submit", () => {
  const harness = finishLineRenderHarness();
  harness.finishRender(finalEvent, {
    heat: finalHeat,
    roster: [
      withdrawn(finalistEntry(1, "Gone", 101)),
      withdrawn(finalistEntry(2, "Also gone", 102)),
    ],
  });
  assert.equal(harness.requiredPlaces(), 0);
  assert.equal(factValue(harness.finishFacts, "Required result"), "0 podium places");
  assert.equal(harness.finishMessage.textContent, NO_ELIGIBLE_MESSAGE);
  // Zero selections must never read as "the selections match what is required".
  assert.equal(harness.finishSubmit.disabled, true);
});

// ---------------------------------------------------------------------------
// Round one, where the same dead end was unreachable
//
// Round one was hard-coded to one required place, so the zero guard could never
// fire for it however many racers had left. The station kept saying "scan the
// winning duck", every duck in the bag answered DUCK_NOT_ELIGIBLE, and nothing
// on screen said that this heat has no winner in it or that only a race director
// can change that.
// ---------------------------------------------------------------------------

const roundOneEvent = { id: "event", name: "Annual Duck Race", status: "ROUND_ONE" };
const roundOneHeat = { id: "heat-2", round: "ROUND_ONE", number: 2, status: "AWAITING_RESULT", revision: 4 };

test("the finish line says the no-winner sentence once, from one constant", () => {
  assert.equal(finishLineRenderHarness().FINISH_NO_ELIGIBLE_MESSAGE, NO_ELIGIBLE_MESSAGE);
  // One declaration and four uses: the scan guard, the mark-finished
  // confirmation, the running heat, and the awaiting-result heat. Two hand-typed
  // copies is how the scan guard and the message line came to disagree before.
  assert.equal((finishLineScript.match(/FINISH_NO_ELIGIBLE_MESSAGE/g) ?? []).length, 5);
  assert.doesNotMatch(
    finishLineScript,
    /Ask the race director to reactivate the racer who should hold the place/,
  );
});

test("round one requires one place while somebody can win and zero when nobody can", () => {
  const harness = finishLineRenderHarness();
  const roster = [
    finalistEntry(1, "Active", 201),
    finalistEntry(2, "Leaving", 202),
    finalistEntry(3, "Also leaving", 203),
  ];

  // One winner, however many racers are on the roster: round one is one place
  // deep, not three.
  harness.finishRender(roundOneEvent, { heat: roundOneHeat, roster });
  assert.equal(harness.requiredPlaces(), 1);
  assert.equal(factValue(harness.finishFacts, "Required result"), "One winner");

  // Two of three leave. There is still somebody who can win, so nothing changes.
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [roster[0], withdrawn(roster[1]), withdrawn(roster[2])],
  });
  assert.equal(harness.requiredPlaces(), 1, "one eligible racer is still one winner");
  assert.equal(factValue(harness.finishFacts, "Required result"), "One winner");

  // The last one leaves. The count has to follow the racers, not the round.
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: roster.map(withdrawn),
  });
  assert.equal(harness.requiredPlaces(), 0, "a round-one heat nobody can win requires no place");
  assert.equal(factValue(harness.finishFacts, "Required result"), "No racer can win");

  // And the roster is untouched: every duck is still in the bag and still listed.
  assert.equal(harness.finishRoster.children.length, 3);
  assert.deepEqual(harness.finishRoster.children.map((row) => markerOf(row)?.flag ?? null), [
    "Cannot win · Withdrawn",
    "Cannot win · Withdrawn",
    "Cannot win · Withdrawn",
  ]);
});

test("a round-one heat nobody can win says so instead of sending the staffer to scan", () => {
  const harness = finishLineRenderHarness();
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [
      withdrawn(finalistEntry(1, "Gone", 201)),
      withdrawn(finalistEntry(2, "Also gone", 202)),
    ],
  });

  // The branch that used to win. "Scan the winning duck's tag" is exactly the
  // instruction that loops on DUCK_NOT_ELIGIBLE forever.
  assert.equal(harness.finishMessage.textContent, NO_ELIGIBLE_MESSAGE);
  assert.doesNotMatch(harness.finishMessage.textContent, /Scan the winning duck/);
  // It names the fact, the ducks staying put, and the only remedy there is.
  assert.match(harness.finishMessage.textContent, /^Nobody in this heat can win:/);
  assert.match(harness.finishMessage.textContent, /Every duck stays in its bag\./);
  assert.match(harness.finishMessage.textContent, /reactivate a racer/);

  // One racer comes back and the station returns to the scan instruction, so the
  // remedy it names is a real way out rather than a terminal state.
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [
      finalistEntry(1, "Back", 201),
      withdrawn(finalistEntry(2, "Also gone", 202)),
    ],
  });
  assert.equal(harness.requiredPlaces(), 1);
  // The station returns to the finished-heat instruction, which now names NFC
  // only and says what the page that tag opens will offer. QR is not mentioned
  // in the instruction a staffer is sent to act on; nothing about a QR tag that
  // resolves to the same permanent URL has changed.
  assert.equal(
    harness.finishMessage.textContent,
    harness.FINISH_WINNER_SCAN_INSTRUCTION + " Its inspection page will offer Mark Duck as Heat 2 Winner.",
  );
  assert.match(harness.finishMessage.textContent, /^Heat finished\. Scan the winning duck's permanent NFC tag/);
  assert.doesNotMatch(harness.finishMessage.textContent, /QR/);
});

test("a running round-one heat nobody can win keeps its finish button and still says so", () => {
  const harness = finishLineRenderHarness();
  const running = { ...roundOneHeat, status: "RUNNING" };
  harness.finishRender(roundOneEvent, {
    heat: running,
    roster: [
      withdrawn(finalistEntry(1, "Gone", 201)),
      withdrawn(finalistEntry(2, "Also gone", 202)),
    ],
  });

  // Those ducks are physically on the water, so the heat still has to be marked
  // finished. The staffer is simply told now rather than after they start
  // scanning refused duck after refused duck.
  assert.deepEqual(harness.finishAction.children.map((child) => child.textContent), ["Mark heat finished"]);
  assert.match(
    harness.finishMessage.textContent,
    /^When the race physically finishes, press the one finish button\. /,
  );
  assert.ok(harness.finishMessage.textContent.endsWith(NO_ELIGIBLE_MESSAGE));
});

// ---------------------------------------------------------------------------
// The finished-heat callout, its finalists bag reminder, and its last resort
//
// The instruction for recording a winner used to live only on the message line,
// which every scan, every refusal and every repaint overwrites — so the one
// sentence a result taker needs was the one sentence most likely to be gone by
// the time they looked. The callout is a region of its own for that reason, and
// these tests read it back rather than trusting that it was painted.
// ---------------------------------------------------------------------------

// Written out here rather than read back out of the shipped script, exactly
// like NO_ELIGIBLE_MESSAGE above, so a silent drift in the wording fails this
// file instead of quietly changing the instruction a staffer is given at the
// water's edge. This sentence is pinned by the issue that asked for it.
const WINNER_SCAN_INSTRUCTION = "Heat finished. Scan the winning duck's permanent NFC tag"
  + " to open its inspection page and select it as the winner.";
const FINALISTS_BAG_INSTRUCTION = "Then put the winning duck in the finalists bag.";
const MANUAL_LAST_RESORT_HEADING = "Last resort: only if the tag cannot be scanned";
const MANUAL_LAST_RESORT_NOTE = "Scanning the winning duck's own permanent NFC tag is how a winner"
  + " is recorded. Use this only when that duck's tag cannot be scanned at all.";

test("a finished round-one heat says the one instruction in its own region, word for word", () => {
  const harness = finishLineRenderHarness();
  assert.equal(harness.FINISH_WINNER_SCAN_INSTRUCTION, WINNER_SCAN_INSTRUCTION);
  assert.equal(harness.FINISH_FINALISTS_BAG_INSTRUCTION, FINALISTS_BAG_INSTRUCTION);
  assert.equal(harness.FINISH_MANUAL_LAST_RESORT_HEADING, MANUAL_LAST_RESORT_HEADING);
  assert.equal(harness.FINISH_MANUAL_LAST_RESORT_NOTE, MANUAL_LAST_RESORT_NOTE);

  // A heat that is still running has not finished, so it is never told to go
  // and scan a winner: it still has one button, and that button is the finish.
  harness.finishRender(roundOneEvent, {
    heat: { ...roundOneHeat, status: "RUNNING" },
    roster: [finalistEntry(1, "Active", 201), finalistEntry(2, "Racing", 202)],
  });
  assert.equal(harness.finishCallout.hidden, true);
  assert.equal(harness.finishCallout.children.length, 0);

  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [finalistEntry(1, "Active", 201), finalistEntry(2, "Racing", 202)],
  });
  const callout = calloutOf(harness);
  assert.equal(harness.finishCallout.hidden, false);
  // The primary instruction and the finalists bag are one workflow in one
  // block, in that order: scan the tag, then put the duck in the bag.
  assert.deepEqual(callout.lines, [WINNER_SCAN_INSTRUCTION, FINALISTS_BAG_INSTRUCTION]);
  // The instruction is emphatic without any styling, so it survives a
  // stylesheet that never loaded.
  assert.equal(harness.finishCallout.children[0].tagName, "STRONG");
  // QR is gone from this instruction and only from this instruction.
  assert.doesNotMatch(callout.lines.join(" "), /QR/);

  // A heat nobody can win has a different thing to say, and must never be sent
  // to scan a bag in which every duck is refused.
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [withdrawn(finalistEntry(1, "Gone", 201)), withdrawn(finalistEntry(2, "Also gone", 202))],
  });
  assert.equal(harness.finishCallout.hidden, true);
  assert.equal(harness.finishCallout.children.length, 0);
  assert.equal(harness.finishMessage.textContent, NO_ELIGIBLE_MESSAGE);

  // The final awards places through its own podium flow, so it never shows the
  // single-winner instruction.
  harness.finishRender(finalEvent, {
    heat: finalHeat,
    roster: [finalistEntry(1, "A", 101), finalistEntry(2, "B", 102), finalistEntry(3, "C", 103)],
  });
  assert.equal(harness.finishCallout.hidden, true);
});

test("the manual fallback names itself a last resort and offers only this heat's eligible racers", () => {
  const harness = finishLineRenderHarness();
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [
      finalistEntry(1, "Active", 201),
      withdrawn(finalistEntry(2, "Gone", 202)),
      {
        ...finalistEntry(3, "Barred", 203),
        eligible: false,
        participant: { firstName: "Racer", lastName: "Barred", registrationStatus: "DISQUALIFIED" },
      },
      finalistEntry(4, "Racing", 204),
      // Paired to nobody: there is no duck to record, so there is nothing to
      // offer, even though the racer themselves is perfectly eligible.
      { ...finalistEntry(5, "Unpaired", 205), duck: null },
    ],
  });

  const callout = calloutOf(harness);
  // The warning is words, not colour and not position: it survives a screen
  // reader, a narrow phone, and a stylesheet that never arrived.
  assert.ok(callout.fallback, "the fallback is rendered inside the callout");
  assert.equal(callout.fallback.children[0].tagName, "STRONG");
  assert.equal(callout.fallback.children[0].textContent, MANUAL_LAST_RESORT_HEADING);
  assert.match(callout.fallback.children[0].textContent, /Last resort/);
  assert.equal(callout.fallback.children[1].textContent, MANUAL_LAST_RESORT_NOTE);

  // The dropdown is labelled, describes itself with the warning, and leads with
  // a placeholder so no racer is preselected into an accidental publish.
  assert.equal(callout.select.getAttribute("aria-describedby"), "finish-manual-warning");
  assert.equal(callout.fallback.children[0].id, "finish-manual-warning");
  assert.equal(callout.fallback.children[2].tagName, "LABEL");
  assert.equal(callout.fallback.children[2].htmlFor, callout.select.id);
  assert.deepEqual(callout.options, [
    { value: "", label: "Choose the winning duck" },
    { value: "entry-1", label: "Duck #201 · Racer Active" },
    { value: "entry-4", label: "Duck #204 · Racer Racing" },
  ]);
  // Withdrawn, disqualified, and unpaired racers are simply not offerable.
  assert.equal(callout.options.some((option) => option.value === "entry-2"), false);
  assert.equal(callout.options.some((option) => option.value === "entry-3"), false);
  assert.equal(callout.options.some((option) => option.value === "entry-5"), false);

  // The action is explicit and separate from choosing: picking a name in the
  // dropdown publishes nothing by itself.
  assert.equal(callout.button.textContent, "Record selected duck as winner");
  assert.equal(callout.button.type, "button");
  assert.deepEqual(harness.manualWinnerCalls, []);
  callout.select.value = "entry-4";
  callout.button.dispatch("click");
  assert.deepEqual(harness.manualWinnerCalls.map((call) => call.raceEntryId), ["entry-4"]);
});

test("the fallback follows the roster, so it can never offer another heat or a racer who left", () => {
  const harness = finishLineRenderHarness();
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [finalistEntry(1, "Leaving", 201), finalistEntry(2, "Staying", 202)],
  });
  assert.deepEqual(calloutOf(harness).options.map((option) => option.value), ["", "entry-1", "entry-2"]);

  // A racer who withdraws while the control is on screen leaves the list
  // without a reload: the callout is rebuilt from the roster on every repaint.
  harness.finishRender(roundOneEvent, {
    heat: roundOneHeat,
    roster: [withdrawn(finalistEntry(1, "Leaving", 201)), finalistEntry(2, "Staying", 202)],
  });
  assert.deepEqual(calloutOf(harness).options.map((option) => option.value), ["", "entry-2"]);

  // Moving to the next heat replaces the options wholesale rather than adding
  // to them, so nobody from the heat just finished can be recorded against this
  // one. The server refuses a cross-heat race entry regardless; this is the
  // half that stops it ever being offered.
  harness.finishRender(roundOneEvent, {
    heat: { ...roundOneHeat, id: "heat-3", number: 3, revision: 1 },
    roster: [
      { ...finalistEntry(7, "Next", 301), raceEntryId: "entry-7" },
      { ...finalistEntry(8, "Also next", 302), raceEntryId: "entry-8" },
    ],
  });
  assert.deepEqual(calloutOf(harness).options.map((option) => option.value), ["", "entry-7", "entry-8"]);

  // The last eligible racer leaving takes the whole workflow with it: there is
  // no winner to record and no dropdown pretending otherwise.
  harness.finishRender(roundOneEvent, {
    heat: { ...roundOneHeat, id: "heat-3", number: 3, revision: 1 },
    roster: [
      withdrawn({ ...finalistEntry(7, "Next", 301), raceEntryId: "entry-7" }),
      withdrawn({ ...finalistEntry(8, "Also next", 302), raceEntryId: "entry-8" }),
    ],
  });
  assert.equal(harness.finishCallout.hidden, true);
  assert.equal(calloutOf(harness).fallback, undefined);
});

// The acknowledgement the duck's own inspection page sends a staffer back to.
// It reports what that page already committed; the current/next-heat state
// underneath it is re-fetched, never taken from the query string.
const finishRecordedHarness = (search) => {
  const document = new FakeDocument();
  const finishRecorded = document.createElement("section");
  finishRecorded.hidden = true;
  const replaced = [];
  const runtime = buildRuntime(
    [
      liftFrom(finishLineScript, "finishText", /const finishText = \(tag, value, className\) => \{[\s\S]*?\n\};/),
      liftFrom(
        finishLineScript,
        "FINISH_FINALISTS_BAG_INSTRUCTION",
        /const FINISH_FINALISTS_BAG_INSTRUCTION = [\s\S]*?;\n/,
      ),
      liftFrom(finishLineScript, "finishShowRecorded", /const finishShowRecorded = \(\) => \{[\s\S]*?\n\};/),
    ].join("\n").split("\n"),
    {
      document,
      finishRecorded,
      location: { search, pathname: "/staff/finish-line" },
      history: { replaceState: (state, title, url) => replaced.push(url) },
    },
    ["finishShowRecorded"],
  );
  runtime.finishShowRecorded();
  return { finishRecorded, replaced };
};

test("a winner recorded on the duck's page is acknowledged back at the finish line", () => {
  const good = finishRecordedHarness("?recorded=heat-winner&duck=117&heat=4");
  assert.equal(good.finishRecorded.hidden, false);
  assert.deepEqual(good.finishRecorded.children.map((child) => child.textContent), [
    "Official winner saved",
    "Duck #117 is the official Heat 4 winner. " + FINALISTS_BAG_INSTRUCTION,
  ]);
  // The bag reminder follows the winner wherever it is confirmed, because a
  // duck put back in its round-one bag is a duck nobody can produce for the
  // final.
  assert.match(good.finishRecorded.children[1].textContent, /finalists bag/);
  // The parameters are dropped either way, so a reload or a shared link can
  // never reassert an acknowledgement for a result this station did not take.
  assert.deepEqual(good.replaced, ["/staff/finish-line"]);

  // Nothing is claimed for a plain visit: no banner, and no history rewrite for
  // a URL that carried nothing to clean up.
  const plain = finishRecordedHarness("");
  assert.equal(plain.finishRecorded.hidden, true);
  assert.deepEqual(plain.replaced, []);

  // Both values are small integers already printed on the duck and shown on
  // every public board. A hand-edited or injected value is refused outright
  // rather than painted, and the parameters are still cleared.
  for (const search of [
    "?recorded=heat-winner&duck=<img src=x>&heat=4",
    "?recorded=heat-winner&duck=117&heat=four",
    "?recorded=heat-winner&duck=&heat=4",
    "?recorded=heat-winner&duck=1234567890&heat=4",
  ]) {
    const rejected = finishRecordedHarness(search);
    assert.equal(rejected.finishRecorded.hidden, true, search);
    assert.equal(rejected.finishRecorded.children.length, 0, search);
    assert.deepEqual(rejected.replaced, ["/staff/finish-line"], search);
  }

  // A failed or conflicted recording never reaches this page at all, so an
  // unrelated acknowledgement value cannot be made to claim success.
  const other = finishRecordedHarness("?recorded=something-else&duck=117&heat=4");
  assert.equal(other.finishRecorded.hidden, true);
  assert.deepEqual(other.replaced, []);
});
