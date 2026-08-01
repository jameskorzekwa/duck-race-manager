import { DUCK_NAME_ADJECTIVES, DUCK_NAME_NOUNS } from "./duck-name-suggestions.ts";
import { publicPhaseByStatus } from "./public-phase.ts";
import { publicHeatStatusLabels, publicOfficialResults } from "./race-status.ts";
import { DUCK_NAME_MAX_LENGTH } from "./registration.ts";

export const confirmationDialogScript = String.raw`
const appConfirmationQueue = [];
let appConfirmationActive = false;

const appConfirmationBackdrop = document.createElement("div");
appConfirmationBackdrop.className = "app-confirmation-backdrop";
appConfirmationBackdrop.hidden = true;

const appConfirmationDialog = document.createElement("dialog");
appConfirmationDialog.className = "app-confirmation";
appConfirmationDialog.setAttribute("role", "dialog");
appConfirmationDialog.setAttribute("aria-modal", "true");
appConfirmationDialog.setAttribute("aria-labelledby", "app-confirmation-title");
appConfirmationDialog.setAttribute("aria-describedby", "app-confirmation-message");
appConfirmationDialog.hidden = true;

const appConfirmationTitle = document.createElement("h2");
appConfirmationTitle.id = "app-confirmation-title";
appConfirmationTitle.textContent = "Confirm action";
const appConfirmationMessage = document.createElement("p");
appConfirmationMessage.id = "app-confirmation-message";
appConfirmationMessage.className = "app-confirmation-message";
const appConfirmationActions = document.createElement("div");
appConfirmationActions.className = "app-confirmation-actions";
const appConfirmationCancel = document.createElement("button");
appConfirmationCancel.type = "button";
appConfirmationCancel.className = "button secondary";
appConfirmationCancel.textContent = "Cancel";
const appConfirmationSubmit = document.createElement("button");
appConfirmationSubmit.type = "button";
appConfirmationSubmit.className = "button";
appConfirmationSubmit.textContent = "Confirm";
appConfirmationActions.append(appConfirmationCancel, appConfirmationSubmit);
appConfirmationDialog.append(appConfirmationTitle, appConfirmationMessage, appConfirmationActions);
document.body.append(appConfirmationBackdrop, appConfirmationDialog);

const appConfirmationShowNext = () => {
  if (appConfirmationActive || appConfirmationQueue.length === 0) return;
  appConfirmationActive = true;
  const request = appConfirmationQueue.shift();
  const returnFocus = document.activeElement;
  let settled = false;
  let nativeDialog = false;

  appConfirmationMessage.textContent = request.message;
  appConfirmationSubmit.textContent = request.confirmLabel;
  appConfirmationSubmit.className = request.danger ? "button danger" : "button";
  appConfirmationDialog.classList.toggle("danger-zone", request.danger);

  const finish = (confirmed) => {
    if (settled) return;
    settled = true;
    appConfirmationCancel.removeEventListener("click", handleCancel);
    appConfirmationSubmit.removeEventListener("click", handleConfirm);
    appConfirmationDialog.removeEventListener("cancel", handleCancel);
    appConfirmationDialog.removeEventListener("click", handleDialogClick);
    appConfirmationDialog.removeEventListener("keydown", handleKeydown);
    appConfirmationBackdrop.removeEventListener("click", handleCancel);
    document.removeEventListener("focusin", handleFocusIn);
    if (nativeDialog && appConfirmationDialog.open) appConfirmationDialog.close();
    appConfirmationDialog.removeAttribute("open");
    appConfirmationDialog.classList.remove("fallback");
    appConfirmationDialog.hidden = true;
    appConfirmationBackdrop.hidden = true;
    appConfirmationActive = false;
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
    request.resolve(confirmed);
    appConfirmationShowNext();
  };
  const handleCancel = (event) => {
    if (event) event.preventDefault();
    finish(false);
  };
  const handleConfirm = () => finish(true);
  const handleDialogClick = (event) => {
    if (nativeDialog && event.target === appConfirmationDialog) handleCancel(event);
  };
  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      handleCancel(event);
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    const controls = [appConfirmationCancel, appConfirmationSubmit];
    const current = controls.indexOf(document.activeElement);
    const direction = event.shiftKey ? -1 : 1;
    const next = current === -1 ? 0 : (current + direction + controls.length) % controls.length;
    controls[next].focus();
  };
  const handleFocusIn = (event) => {
    if (!appConfirmationDialog.contains(event.target)) appConfirmationCancel.focus();
  };

  appConfirmationCancel.addEventListener("click", handleCancel);
  appConfirmationSubmit.addEventListener("click", handleConfirm);
  appConfirmationDialog.addEventListener("cancel", handleCancel);
  appConfirmationDialog.addEventListener("click", handleDialogClick);
  appConfirmationDialog.addEventListener("keydown", handleKeydown);
  appConfirmationBackdrop.addEventListener("click", handleCancel);
  document.addEventListener("focusin", handleFocusIn);
  appConfirmationDialog.hidden = false;
  if (typeof appConfirmationDialog.showModal === "function") {
    try {
      appConfirmationDialog.showModal();
      nativeDialog = true;
    } catch {}
  }
  if (!nativeDialog) {
    appConfirmationDialog.classList.add("fallback");
    appConfirmationDialog.setAttribute("open", "");
    appConfirmationBackdrop.hidden = false;
  }
  appConfirmationCancel.focus();
};

const appConfirm = (message, options = {}) => new Promise((resolve) => {
  appConfirmationQueue.push({
    message: String(message),
    danger: options.danger === true,
    confirmLabel: typeof options.confirmLabel === "string" && options.confirmLabel ? options.confirmLabel : "Confirm",
    resolve,
  });
  appConfirmationShowNext();
});
`;

export const registrationHandoffHelpersScript = String.raw`
const registrationHandoffKey = "quickducks.registration-handoff";
const registrationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const registrationPrivatePathPattern = /^\/r\/[A-Za-z0-9_-]{43,128}$/;
const registrationCreateHandoff = (value) => {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || typeof value.registrationId !== "string" || !registrationIdPattern.test(value.registrationId)
    || typeof value.privateStatusPath !== "string" || !registrationPrivatePathPattern.test(value.privateStatusPath)
  ) return null;
  return { registrationId: value.registrationId, privateStatusPath: value.privateStatusPath };
};
const registrationStoreHandoff = (storage, value) => {
  const handoff = registrationCreateHandoff(value);
  if (handoff === null) return false;
  try {
    storage.setItem(registrationHandoffKey, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
};
`;

// Participant-specific ownership proof is retained outside the DOM and outside
// every URL. The HttpOnly collection cookie proves the browser collection; this
// per-registration proof prevents one card (or a followed card) from granting
// private access to another participant.
export const ownershipProofHelpersScript = String.raw`
const participantOwnershipProofStorageKey = "quickducks.participant-ownership.v1";
const participantOwnershipRegistrationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const participantOwnershipProofPattern = /^[A-Za-z0-9_-]{43,128}$/;
const participantOwnershipReadProof = (storage, registrationId) => {
  if (!participantOwnershipRegistrationIdPattern.test(registrationId)) return null;
  try {
    const parsed = JSON.parse(storage.getItem(participantOwnershipProofStorageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const proof = parsed[registrationId];
    return typeof proof === "string" && participantOwnershipProofPattern.test(proof) ? proof : null;
  } catch {
    return null;
  }
};
const participantOwnershipStoreProof = (storage, registrationId, proof) => {
  if (!participantOwnershipRegistrationIdPattern.test(registrationId) || !participantOwnershipProofPattern.test(proof)) return false;
  try {
    const current = JSON.parse(storage.getItem(participantOwnershipProofStorageKey) || "{}");
    const proofs = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    const safe = {};
    for (const [key, value] of Object.entries(proofs).slice(-99)) {
      if (participantOwnershipRegistrationIdPattern.test(key) && typeof value === "string" && participantOwnershipProofPattern.test(value)) {
        safe[key] = value;
      }
    }
    safe[registrationId] = proof;
    storage.setItem(participantOwnershipProofStorageKey, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
};
`;

export const registrationOwnershipProofHelpersScript = String.raw`
const registrationOwnershipProofStorageKey = "quickducks.participant-ownership.v1";
const registrationOwnershipIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const registrationOwnershipProofPattern = /^[A-Za-z0-9_-]{43,128}$/;
const registrationOwnershipStoreProof = (storage, registrationId, proof) => {
  if (!registrationOwnershipIdPattern.test(registrationId) || !registrationOwnershipProofPattern.test(proof)) return false;
  try {
    const current = JSON.parse(storage.getItem(registrationOwnershipProofStorageKey) || "{}");
    const proofs = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    const safe = {};
    for (const [key, value] of Object.entries(proofs).slice(-99)) {
      if (registrationOwnershipIdPattern.test(key) && typeof value === "string" && registrationOwnershipProofPattern.test(value)) {
        safe[key] = value;
      }
    }
    safe[registrationId] = proof;
    storage.setItem(registrationOwnershipProofStorageKey, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
};
`;

export const registrationScript = registrationHandoffHelpersScript + registrationOwnershipProofHelpersScript + String.raw`
const form = document.querySelector("[data-registration-form]");
const eventName = document.querySelector("[data-event-name]");
const eventDate = document.querySelector("[data-event-date]");
const formMessage = document.querySelector("[data-form-message]");
const submitButton = form.querySelector("button[type='submit']");
const emailInput = form.elements.email;
const emailLabel = document.querySelector("[data-email-label]");
const publicNamePolicy = document.querySelector("[data-public-name-policy]");
const firstNameInput = form.elements.first_name;
const lastNameInput = form.elements.last_name;
const protectionReady = form.dataset.protectionReady === "true";
let currentEvent = null;
let pendingCommand = null;
let registrationInFlight = false;

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const setMessage = (message, isError = false) => {
  formMessage.textContent = message;
  formMessage.classList.toggle("error-text", isError);
};

const clearFieldErrors = () => {
  for (const element of form.querySelectorAll("[data-field-error]")) element.textContent = "";
};

const showFieldErrors = (fields) => {
  for (const [name, message] of Object.entries(fields || {})) {
    const element = form.querySelector("[data-field-error='" + name + "']");
    if (element) element.textContent = String(message);
  }
};

const resetTurnstile = () => {
  if (globalThis.turnstile && typeof globalThis.turnstile.reset === "function") {
    globalThis.turnstile.reset();
  }
};

const updatePublicNamePolicy = () => {
  if (!currentEvent) return;
  const firstName = firstNameInput.value.trim().replace(/\s+/g, " ") || "Jamie";
  const lastName = lastNameInput.value.trim().replace(/\s+/g, " ") || "Rivera";
  const format = currentEvent.publicNamePolicy === "FULL_NAME"
    ? "full first and last name"
    : currentEvent.publicNamePolicy === "FIRST_NAME_ONLY"
      ? "first name only"
      : "first name and last initial";
  const example = currentEvent.publicNamePolicy === "FULL_NAME"
    ? firstName + " " + lastName
    : currentEvent.publicNamePolicy === "FIRST_NAME_ONLY"
      ? firstName
      : firstName + " " + lastName.slice(0, 1).toUpperCase() + ".";
  publicNamePolicy.textContent = "Your name will appear publicly as " + example + " (" + format + "). Your email and phone stay private.";
};

firstNameInput.addEventListener("input", updatePublicNamePolicy);
lastNameInput.addEventListener("input", updatePublicNamePolicy);

const loadRegistrationEvent = async () => {
  try {
    const response = await fetch("/api/v1/events/current", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const { event } = await response.json();
    currentEvent = event;
    if (!event) {
      eventName.textContent = "The next race is being prepared";
      eventDate.textContent = "Registration is not open yet.";
      setMessage("Registration is not open yet.");
      submitButton.disabled = true;
      return;
    }
    eventName.textContent = event.name;
    eventDate.textContent = event.eventDate
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(event.eventDate + "T12:00:00"))
      : "Race date to be announced";
    emailInput.required = event.emailRequired;
    emailLabel.textContent = event.emailRequired ? "Email" : "Email (optional)";
    updatePublicNamePolicy();
    if (event.status !== "REGISTRATION_OPEN") {
      setMessage("Registration is currently closed.");
      submitButton.disabled = true;
      return;
    }
    if (!protectionReady) {
      setMessage("Registration will open here after anti-bot protection is configured.");
      submitButton.disabled = true;
      return;
    }
    submitButton.disabled = false;
    setMessage("Ready when you are.");
  } catch {
    eventName.textContent = "Race details unavailable";
    eventDate.textContent = "Please refresh and try again.";
    submitButton.disabled = true;
  }
};

globalThis.quickDucksLive.subscribe({
  domains: ["event"],
  root: form,
  refresh: loadRegistrationEvent,
  isBlocked: () => registrationInFlight || pendingCommand !== null,
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors();
  if (!currentEvent || currentEvent.status !== "REGISTRATION_OPEN" || !protectionReady) return;

  const turnstileToken = form.querySelector("[name='cf-turnstile-response']")?.value || "";
  if (!turnstileToken) {
    setMessage("Complete the anti-bot check before registering.", true);
    return;
  }

  pendingCommand ??= {
    commandId: crypto.randomUUID(),
    privateToken: randomToken(),
  };
  const data = new FormData(form);
  const payload = {
    ...pendingCommand,
    eventId: currentEvent.id,
    firstName: data.get("first_name"),
    lastName: data.get("last_name"),
    email: data.get("email"),
    phone: data.get("phone"),
    emailNotificationsEnabled: false,
    turnstileToken,
    clientTimestamp: new Date().toISOString(),
  };

  submitButton.disabled = true;
  registrationInFlight = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  setMessage("Saving your registration…");
  try {
    const response = await fetch("/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      showFieldErrors(body.fields);
      setMessage(body.error || "Registration could not be saved.", true);
      if (response.status !== 409) pendingCommand = null;
      resetTurnstile();
      submitButton.disabled = false;
      return;
    }
    const handoff = registrationCreateHandoff(body);
    if (handoff === null) {
      setMessage("Registration was saved, but its private status details were invalid. Ask race staff for help before leaving this page.", true);
      return;
    }
    try { registrationStoreHandoff(globalThis.sessionStorage, handoff); } catch {}
    try { registrationOwnershipStoreProof(globalThis.localStorage, handoff.registrationId, pendingCommand.privateToken); } catch {}
    location.assign("/my-ducks?registered=" + encodeURIComponent(handoff.registrationId));
  } catch {
    setMessage("The network interrupted registration. Try again; the same request will be retried safely.", true);
    submitButton.disabled = false;
  } finally {
    registrationInFlight = false;
    endBusy();
  }
});
`;

export const participantHandoffHelpersScript = String.raw`
const participantHandoffKey = "quickducks.registration-handoff";
const participantRegistrationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const participantPrivatePathPattern = /^\/r\/[A-Za-z0-9_-]{43,128}$/;
const participantValidateHandoff = (value, expectedRegistrationId, appOrigin) => {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "registrationId") || !Object.hasOwn(value, "privateStatusPath")
    || typeof expectedRegistrationId !== "string" || !participantRegistrationIdPattern.test(expectedRegistrationId)
    || value.registrationId !== expectedRegistrationId
    || typeof value.privateStatusPath !== "string" || !participantPrivatePathPattern.test(value.privateStatusPath)
  ) return null;
  try {
    const configured = new URL(appOrigin);
    const privateUrl = new URL(value.privateStatusPath, configured.origin);
    if (
      configured.pathname !== "/" || configured.search || configured.hash
      || privateUrl.origin !== configured.origin || privateUrl.username || privateUrl.password
      || privateUrl.search || privateUrl.hash
      || privateUrl.pathname !== value.privateStatusPath
      || privateUrl.href !== configured.origin + value.privateStatusPath
    ) return null;
  } catch {
    return null;
  }
  return { registrationId: value.registrationId, privateStatusPath: value.privateStatusPath };
};
const participantConsumeHandoff = (storage, expectedRegistrationId, appOrigin) => {
  try {
    const serialized = storage.getItem(participantHandoffKey);
    if (serialized === null) return null;
    const handoff = participantValidateHandoff(JSON.parse(serialized), expectedRegistrationId, appOrigin);
    if (handoff === null) return null;
    storage.removeItem(participantHandoffKey);
    return handoff;
  } catch {
    return null;
  }
};
`;

export const participantScript = participantHandoffHelpersScript + ownershipProofHelpersScript + String.raw`
const participantNav = document.querySelector("[data-my-ducks-nav]");
const participantRoot = document.querySelector("[data-my-ducks-page]");
const participantError = document.querySelector("[data-my-ducks-error]");
const participantSuccess = document.querySelector("[data-registration-success]");
const participantSections = Array.from(document.querySelectorAll("[data-participant-section]"));
const participantEmpty = document.querySelector("[data-my-ducks-empty]");
const participantFlow = document.querySelector("[data-my-ducks-flow]");
const participantSearchLead = document.querySelector("[data-search-lead]");
let participantRegisteredId = participantRoot
  ? new URLSearchParams(location.search).get("registered")
  : null;
// Which registration the one-time success notice is talking about. It exists
// only so the notice — and the private status link inside it — disappears the
// moment that registration is deleted or leaves the collection. It never changes
// how a card is rendered.
let participantSuccessId = null;
let participantPrivateStatusPath = null;
let participantVersion = null;
// A collection read can already be in flight when an edit begins. Busy/dirty
// tracking prevents another read from starting, but it cannot cancel that old
// response. Incrementing this generation lets the mutation invalidate the old
// paint while the queued post-mutation read remains authoritative.
let participantRenderGeneration = 0;
const participantOwnershipProofs = new Map();
const participantOwnershipMints = new Map();

const participantText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

// Error-only line: it stays hidden while refreshes succeed and never reports a
// "current"/"updated" state. It exists so a hard load failure on this page is
// not silent, because My Ducks has no other message surface.
const participantShowError = (message) => {
  if (!participantError) return;
  participantError.textContent = message === null ? "" : message;
  participantError.hidden = message === null;
};

// Saved-registration presence still controls the page's empty/saved layout, but
// the navigation follows the public phase. Before registration opens the route
// redirects home, so revealing a saved-data link there would be a dead end.
const participantSetNavPresence = (hasRegistrations) => {
  if (!participantNav) return;
  participantNav.dataset.hasRegistrations = hasRegistrations ? "true" : "false";
  participantNav.hidden = participantNav.dataset.phaseVisible !== "true";
};

// The name search leads the page while nothing is saved on this device, and
// drops below the saved ducks once there is something to show.
const participantSetSearchPlacement = (hasRegistrations) => {
  if (participantFlow) participantFlow.dataset.myDucksFlow = hasRegistrations ? "saved" : "empty";
  if (participantSearchLead) participantSearchLead.hidden = hasRegistrations;
};

const participantHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase()
  .replace(/^./, (character) => character.toUpperCase());
const participantRoundLabel = (round) => round === "FINAL" ? "Final" : "Round one";
const participantHeatStatus = (status) => ({
  PLANNED: "Coming up",
  LOADING: "Ducks are being prepared",
  READY: "Ready to call",
  CALLING: "Heat has been announced",
  RUNNING: "Racing now",
  AWAITING_RESULT: "Race finished; checking the result",
  FINALIZED: "Result official",
  CANCELLED: "Not running",
})[status] || "Status being checked";

const participantAddFact = (container, label, value) => {
  const fact = participantText("div", "", "fact");
  fact.append(participantText("dt", label), participantText("dd", value));
  container.append(fact);
};

// Owned cards carry the editable value at the top level. Followed cards must not
// gain that owner-only field or its controls, but they do render the same public
// name every other visitor receives through the public race-status projection.
const participantDuckName = (registration) => {
  if (!registration) return null;
  const projected = registration.followed === true
    ? registration.raceStatus && registration.raceStatus.duckName
    : registration.duckName;
  const name = typeof projected === "string" ? projected.trim() : "";
  return name.length === 0 ? null : name;
};

// A paired card links its duck number to the public duck detail view. An
// awaiting card has no duck number, so it keeps plain text and no link. When
// the owner named this duck, the name replaces "Duck #N" as the link text and
// the number remains the link destination but no longer remains as a competing
// generic label.
//
// Naming belongs to this fact rather than to a block of its own: the duck is
// what is being named, so the control that renames it sits with the duck's
// identity and stays folded away until it is asked for.
const participantAddDuckFact = (facts, status, registration) => {
  // The collection's paired flag comes from the current open assignment in D1.
  // Fail closed on that authoritative field even if a separately projected
  // race status still contains a duck or heat from an older assignment.
  if (registration.paired !== true) {
    participantAddFact(facts, "Duck", "Waiting for duck assignment");
    return;
  }
  const duckName = participantDuckName(registration);
  const link = duckDetailLink(document, status.duck ? status.duck.visibleNumber : null, duckName);
  if (link === null) {
    participantAddFact(facts, "Duck", "Waiting for duck assignment");
    return;
  }
  const fact = participantText("div", "", "fact");
  const value = participantText("dd", "");
  value.append(link);
  fact.append(participantText("dt", "Duck"), value);
  if (participantCanName(registration)) value.append(...participantNameControls(registration));
  facts.append(fact);
};

const participantAddRaceFacts = (card, status, registration) => {
  if (!status) {
    if (registration.paired === true) {
      card.append(participantText("p", "Race status is not currently public.", "muted"));
    }
    return;
  }
  const facts = participantText("dl", "", "facts");
  participantAddDuckFact(facts, status, registration);
  if (registration.paired === true) {
    const assigned = status.assignedHeat.final || status.assignedHeat.roundOne;
    participantAddFact(facts, "Assigned heat", assigned
      ? (status.assignedHeat.final ? "Final" : "Round one") + " · Heat " + assigned.number
      : "Heat not assigned yet");
    participantAddFact(facts, "Race activity", status.currentHeat
      ? participantRoundLabel(status.currentHeat.round) + " · Heat " + status.currentHeat.number
        + " · " + participantHeatStatus(status.currentHeat.status)
      : "No heat is active right now");
    participantAddFact(facts, "Race status", participantHumanize(status.outcome));
  }
  card.append(facts);
};

// Followed entries were added from the public name search, so the server sends
// a policy-filtered display name and no lookup code for them.
const participantDisplayName = (registration) => {
  if (typeof registration.displayName === "string" && registration.displayName.length > 0) {
    return registration.displayName;
  }
  return [registration.firstName, registration.lastName].filter(Boolean).join(" ");
};

// Deleting is offered only for a registration this browser created and that the
// server still reports as removable: a followed entry belongs to someone else,
// and an entry that already has a duck or a heat place belongs to the race. The
// server recomputes both conditions inside its guarded write, so this flag is
// presentation only.
const participantCanDelete = (registration) =>
  registration.deletable === true && registration.followed !== true;

const participantDelete = async (registration, button, feedback) => {
  const confirmed = await appConfirm(
    "Delete the registration for " + participantDisplayName(registration)
    + "? It will be removed from the race and cannot be brought back.",
    { danger: true, confirmLabel: "Delete registration" },
  );
  if (!confirmed) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Deleting…";
  feedback.textContent = "";
  feedback.hidden = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    let deleted = false;
    try {
      const response = await fetch("/api/v1/registrations/mine/delete", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          registrationId: registration.registrationId,
        }),
      });
      deleted = response.ok;
    } catch {
      deleted = false;
    }
    if (!deleted) {
      button.disabled = false;
      button.textContent = label;
      feedback.textContent = "That registration could not be deleted. It may already have a duck. Try again, or ask race staff for help.";
      feedback.hidden = false;
      return;
    }
    if (participantSuccessId === registration.registrationId) {
      participantSuccessId = null;
      participantSuccess.hidden = true;
    }
    // The card disappears only when the authoritative collection says so, and
    // a failed refetch reports itself on the page's own error line rather than
    // being mistaken for a failed deletion.
    participantVersion = null;
    await participantRefreshWork();
  } finally {
    endBusy();
  }
};

const participantDeleteControls = (registration) => {
  const actions = participantText("div", "", "actions");
  const feedback = participantText("p", "", "message-line muted");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  const button = participantText("button", "Delete registration", "button danger small");
  button.type = "button";
  button.dataset.deleteRegistration = registration.registrationId;
  button.addEventListener("click", () => participantDelete(registration, button, feedback));
  actions.append(button);
  return [actions, feedback];
};

// Unfollowing is offered only for a followed link, and it removes only that
// link. The endpoint is separate from deletion on purpose: it can never reach
// the registration itself, which belongs to whoever created it.
const participantCanUnfollow = (registration) => registration.followed === true;

const participantUnfollow = async (registration, button, feedback) => {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Removing…";
  feedback.textContent = "";
  feedback.hidden = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    let removed = false;
    try {
      const response = await fetch("/api/v1/registrations/mine/unfollow", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          registrationId: registration.registrationId,
        }),
      });
      removed = response.ok;
    } catch {
      removed = false;
    }
    if (!removed) {
      button.disabled = false;
      button.textContent = label;
      feedback.textContent = "That participant could not be removed from My Ducks. Please try again.";
      feedback.hidden = false;
      return;
    }
    // The card disappears only when the authoritative collection says so.
    participantVersion = null;
    await participantRefreshWork();
  } finally {
    endBusy();
  }
};

const participantUnfollowControls = (registration) => {
  const actions = participantText("div", "", "actions");
  const feedback = participantText("p", "", "message-line muted");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  const button = participantText("button", "Stop following", "button secondary small");
  button.type = "button";
  button.dataset.unfollowRegistration = registration.registrationId;
  button.addEventListener("click", () => participantUnfollow(registration, button, feedback));
  actions.append(button);
  return [actions, feedback];
};

// Naming is offered only for a registration this browser created and that the
// server still reports as nameable, which means a duck is currently paired to
// it. The server recomputes both conditions inside its guarded write, so this
// flag is presentation only.
const participantCanName = (registration) =>
  Boolean(registration) && registration.followed !== true && registration.nameable === true;

const participantNameLimit = ${JSON.stringify(DUCK_NAME_MAX_LENGTH)};

const participantCleanName = (value) =>
  String(value == null ? "" : value).trim().replace(/\s+/g, " ");

// Suggestion word lists, serialized from src/duck-name-suggestions.ts.
// duck-name-suggestions.test.mjs proves every pairing of the two lists passes
// the same length, control-character, alphabet, and wordlist gates the write
// endpoint applies and the read-time projection repeats, so a participant who
// accepts a suggestion can never be told the name is unusable.
const participantNameAdjectives = ${JSON.stringify(DUCK_NAME_ADJECTIVES)};
const participantNameNouns = ${JSON.stringify(DUCK_NAME_NOUNS)};

const participantRandomIndex = (length) =>
  crypto.getRandomValues(new Uint32Array(1))[0] % length;

// Pressing the button again should visibly change something, so a suggestion
// that repeats the value already in the field is retried. The attempt count is
// bounded so a future one-word list could never spin here.
const participantSuggestName = (avoid) => {
  let suggestion = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    suggestion = participantNameAdjectives[participantRandomIndex(participantNameAdjectives.length)]
      + " " + participantNameNouns[participantRandomIndex(participantNameNouns.length)];
    if (suggestion !== avoid) return suggestion;
  }
  return suggestion;
};

// Which cards currently have their name editor open. A live refresh rebuilds
// the whole card, so this has to live outside the DOM: otherwise a background
// update would fold away an editor the participant is still using.
const participantOpenNameEditors = new Set();

const participantSaveName = async (registration, form, input, button, feedback) => {
  const duckName = participantCleanName(input.value);
  // The same bound the server and the schema enforce, checked here only so a
  // participant sees the problem without a round trip.
  if (duckName.length === 0 || duckName.length > participantNameLimit) {
    feedback.textContent = "Enter a duck name of 1 to " + participantNameLimit + " characters.";
    feedback.hidden = false;
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  feedback.textContent = "";
  feedback.hidden = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    let saved = false;
    // A 422 is the server refusing this particular name, not a failure to
    // reach it, so it gets its own message and no "try again". The rejected
    // text is never echoed by the server and is never repeated here.
    let refused = false;
    try {
      const response = await fetch("/api/v1/registrations/mine/duck-name", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          registrationId: registration.registrationId,
          duckName,
        }),
      });
      saved = response.ok;
      refused = response.status === 422;
    } catch {
      saved = false;
    }
    if (!saved) {
      button.disabled = false;
      button.textContent = label;
      feedback.textContent = refused
        ? "That name can’t be used on the public race board. Please choose another one."
        : "That duck name could not be saved. Please try again.";
      feedback.hidden = false;
      return;
    }
    // The saved name is read back from the authoritative collection, never from
    // this response, and the field is clean again so live refreshes resume.
    globalThis.quickDucksLive.markClean(form);
    participantOpenNameEditors.delete(registration.registrationId);
    participantVersion = null;
    await participantRefreshWork();
  } finally {
    endBusy();
  }
};

// The naming control is a button beside the duck's identity plus the field it
// reveals. Both are returned together because the button owns the field's
// visibility and the field's Cancel restores focus to the button.
const participantNameControls = (registration) => {
  const registrationId = registration.registrationId;
  const currentName = participantDuckName(registration);
  const named = currentName !== null;

  const toggle = participantText("button", named ? "Rename" : "Name this duck", "button secondary small duck-name-toggle");
  toggle.type = "button";
  toggle.dataset.duckNameToggle = registrationId;
  toggle.setAttribute("aria-controls", "duck-name-form-" + registrationId);

  const form = participantText("form", "", "duck-name-form");
  form.id = "duck-name-form-" + registrationId;
  form.dataset.duckNameForm = registrationId;
  const label = participantText("label", named ? "New duck name" : "Duck name");
  const input = document.createElement("input");
  input.name = "duckName";
  input.type = "text";
  input.maxLength = participantNameLimit;
  input.value = named ? currentName : "";
  input.placeholder = "Sir Quacks-a-Lot";
  label.append(input);
  const feedback = participantText("p", "", "message-line muted");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;

  const save = participantText("button", "Save name", "button small");
  save.type = "submit";
  const suggest = participantText("button", "Suggest a name", "button secondary small");
  suggest.type = "button";
  suggest.dataset.duckNameSuggest = registrationId;
  suggest.addEventListener("click", () => {
    input.value = participantSuggestName(participantCleanName(input.value));
    // A suggestion is an edit like any other, so it defers live refreshes the
    // same way typing does and cannot be wiped by a background repaint.
    input.dataset.liveDirty = "true";
    feedback.hidden = true;
    input.focus();
  });
  const cancel = participantText("button", "Cancel", "button secondary small");
  cancel.type = "button";
  const actions = participantText("div", "", "actions");
  actions.append(save, suggest, cancel);
  form.append(
    label,
    actions,
    participantText("p", "The name you choose replaces the generic duck number on public race status, the race board, and this duck’s page. Keep it friendly: race staff can remove a name that is not.", "muted"),
    feedback,
  );

  // Painting the initial state must not touch the live hub: this runs for every
  // card on every render, and marking clean asks every subscriber to refetch.
  const paint = (open) => {
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const setOpen = (open) => {
    if (open) participantOpenNameEditors.add(registrationId);
    else participantOpenNameEditors.delete(registrationId);
    paint(open);
    if (open) {
      input.focus();
      input.select();
      return;
    }
    // Closing discards the draft rather than keeping it: the field always
    // reopens showing the name the server currently holds.
    input.value = named ? currentName : "";
    feedback.hidden = true;
    globalThis.quickDucksLive.markClean(form);
    toggle.focus();
  };

  toggle.addEventListener("click", () => setOpen(form.hidden));
  cancel.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    return participantSaveName(registration, form, input, save, feedback);
  });
  paint(participantOpenNameEditors.has(registrationId));
  return [toggle, form];
};

const participantValidContact = (value, registrationId) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  const readKeys = "email,emailNotificationsEnabled,phone,registrationId,revision,smsNotificationsEnabled";
  const mutationKeys = "email,emailNotificationsEnabled,phone,registrationId,replayed,revision,smsNotificationsEnabled";
  return (keys === readKeys || keys === mutationKeys)
    && value.registrationId === registrationId
    && (value.email === null || typeof value.email === "string")
    && (value.phone === null || typeof value.phone === "string")
    && typeof value.emailNotificationsEnabled === "boolean"
    && typeof value.smsNotificationsEnabled === "boolean"
    && (keys === readKeys || typeof value.replayed === "boolean")
    && Number.isInteger(value.revision) && value.revision >= 0;
};

// PATCH responses additionally carry replayed; collection refreshes read the
// canonical shape without it. Keep the rendered registration and its version
// key in that canonical shape so the mandatory post-mutation refresh can verify
// the update without replacing an otherwise unchanged card under the caller.
const participantContactSnapshot = (value) => ({
  registrationId: value.registrationId,
  email: value.email,
  phone: value.phone,
  emailNotificationsEnabled: value.emailNotificationsEnabled,
  smsNotificationsEnabled: value.smsNotificationsEnabled,
  revision: value.revision,
});

const participantRememberContact = (registrationId, contact) => {
  if (participantVersion === null) return;
  try {
    const registrations = JSON.parse(participantVersion);
    if (!Array.isArray(registrations)) throw new Error("invalid participant version");
    const remembered = registrations.find((item) => item && item.registrationId === registrationId);
    if (!remembered) throw new Error("registration is no longer rendered");
    remembered.contact = contact;
    participantVersion = JSON.stringify(registrations);
  } catch {
    // A later authoritative refresh repairs an unexpected local version rather
    // than allowing an invalid optimization key to suppress a repaint.
    participantVersion = null;
  }
};

const participantEnsureOwnershipProof = async (registrationId) => {
  const remembered = participantOwnershipProofs.get(registrationId);
  if (remembered) return remembered;
  // Non-browser script harnesses intentionally provide no storage object. Real
  // browsers provide one even when access throws, in which case the guarded
  // mint below still gives this page an in-memory proof and fails closed on the
  // next load rather than widening authorization.
  if (!globalThis.localStorage) return null;
  let stored = null;
  try { stored = participantOwnershipReadProof(globalThis.localStorage, registrationId); } catch {}
  if (stored !== null) {
    participantOwnershipProofs.set(registrationId, stored);
    return stored;
  }
  let pending = participantOwnershipMints.get(registrationId);
  if (!pending) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    pending = {
      commandId: crypto.randomUUID(),
      proof: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    };
    participantOwnershipMints.set(registrationId, pending);
  }
  const response = await fetch("/api/v1/registrations/mine/contact-proof", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      commandId: pending.commandId,
      registrationId,
      ownershipProof: pending.proof,
    }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  if (
    !body || body.registrationId !== registrationId
    || body.ownershipProofAccepted !== true
    || typeof body.replayed !== "boolean"
  ) return null;
  participantOwnershipMints.delete(registrationId);
  participantOwnershipProofs.set(registrationId, pending.proof);
  try { participantOwnershipStoreProof(globalThis.localStorage, registrationId, pending.proof); } catch {}
  return pending.proof;
};

const participantLoadContact = async (registration) => {
  if (registration.followed === true) return { ...registration, contact: null };
  try {
    const proof = await participantEnsureOwnershipProof(registration.registrationId);
    if (proof === null) return { ...registration, contact: null };
    const response = await fetch(
      "/api/v1/registrations/mine/" + encodeURIComponent(registration.registrationId) + "/contact",
      {
        headers: {
          accept: "application/json",
          "x-quickducks-ownership-proof": proof,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return { ...registration, contact: null };
    const contact = await response.json();
    return participantValidContact(contact, registration.registrationId)
      ? { ...registration, contact }
      : { ...registration, contact: null };
  } catch {
    return { ...registration, contact: null };
  }
};

const participantContactLine = (label, value) =>
  participantText("p", label + ": " + value, "participant-contact-line");

const participantPaintContact = (panel, registration) => {
  const contact = registration.contact;
  if (!participantValidContact(contact, registration.registrationId)) {
    panel.replaceChildren(participantText(
      "p",
      "Private contact details are unavailable on this device.",
      "muted",
    ));
    return;
  }

  const summary = participantText("div", "", "participant-contact-summary");
  summary.dataset.contactSummary = registration.registrationId;
  summary.append(
    participantText("strong", "Contact and update preferences"),
    participantContactLine("Email", contact.email || "Not provided"),
    participantContactLine("Phone", contact.phone || "Not provided"),
    participantContactLine("Email updates", contact.emailNotificationsEnabled ? "Opted in" : "Not opted in"),
    participantContactLine("SMS updates", contact.smsNotificationsEnabled ? "Opted in" : "Not opted in"),
  );
  const edit = participantText("button", "Edit contact details", "button secondary small");
  edit.type = "button";
  edit.dataset.contactEdit = registration.registrationId;
  edit.setAttribute("aria-controls", "participant-contact-form-" + registration.registrationId);
  edit.setAttribute("aria-expanded", "false");

  const form = participantText("form", "", "participant-contact-form");
  form.id = "participant-contact-form-" + registration.registrationId;
  form.dataset.contactForm = registration.registrationId;
  form.hidden = true;
  const emailLabel = participantText("label", "Email");
  const emailInput = document.createElement("input");
  emailInput.type = "email";
  emailInput.name = "email";
  emailInput.maxLength = 254;
  emailInput.autocomplete = "email";
  emailInput.value = contact.email || "";
  emailLabel.append(emailInput);
  const phoneLabel = participantText("label", "Phone");
  const phoneInput = document.createElement("input");
  phoneInput.type = "tel";
  phoneInput.name = "phone";
  phoneInput.maxLength = 32;
  phoneInput.autocomplete = "tel";
  phoneInput.value = contact.phone || "";
  phoneLabel.append(phoneInput);
  const emailChoice = participantText("label", "", "check");
  const emailCheckbox = document.createElement("input");
  emailCheckbox.type = "checkbox";
  emailCheckbox.name = "emailNotificationsEnabled";
  emailCheckbox.checked = contact.emailNotificationsEnabled;
  emailChoice.append(emailCheckbox, participantText("span", "Send operational race updates by email"));
  const smsChoice = participantText("label", "", "check");
  const smsCheckbox = document.createElement("input");
  smsCheckbox.type = "checkbox";
  smsCheckbox.name = "smsNotificationsEnabled";
  smsCheckbox.checked = contact.smsNotificationsEnabled;
  smsChoice.append(smsCheckbox, participantText("span", "Send operational race updates by SMS"));
  const feedback = participantText("p", "", "message-line muted");
  feedback.dataset.contactFeedback = registration.registrationId;
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  const save = participantText("button", "Save changes", "button small");
  save.type = "submit";
  const cancel = participantText("button", "Cancel", "button secondary small");
  cancel.type = "button";
  const actions = participantText("div", "", "actions");
  actions.append(save, cancel);
  form.append(emailLabel, phoneLabel, emailChoice, smsChoice, actions, feedback);

  const setDirty = () => { form.dataset.liveDirty = "true"; };
  emailInput.addEventListener("input", setDirty);
  phoneInput.addEventListener("input", setDirty);
  emailCheckbox.addEventListener("change", setDirty);
  smsCheckbox.addEventListener("change", setDirty);
  edit.addEventListener("click", () => {
    summary.hidden = true;
    edit.hidden = true;
    edit.setAttribute("aria-expanded", "true");
    form.hidden = false;
    form.dataset.liveDirty = "true";
    emailInput.focus();
  });
  cancel.addEventListener("click", () => {
    form.hidden = true;
    summary.hidden = false;
    edit.hidden = false;
    edit.setAttribute("aria-expanded", "false");
    emailInput.value = contact.email || "";
    phoneInput.value = contact.phone || "";
    emailCheckbox.checked = contact.emailNotificationsEnabled;
    smsCheckbox.checked = contact.smsNotificationsEnabled;
    feedback.hidden = true;
    delete form.dataset.liveDirty;
    edit.focus();
    globalThis.quickDucksLive.markClean(form);
  });

  let pendingCommandId = null;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const proof = participantOwnershipProofs.get(registration.registrationId);
    if (!proof) {
      feedback.textContent = "Private contact access is unavailable. Refresh and try again.";
      feedback.hidden = false;
      return;
    }
    pendingCommandId ||= crypto.randomUUID();
    save.disabled = true;
    save.textContent = "Saving…";
    feedback.hidden = true;
    participantRenderGeneration += 1;
    const endBusy = globalThis.quickDucksLive.beginBusy();
    try {
      const response = await fetch(
        "/api/v1/registrations/mine/" + encodeURIComponent(registration.registrationId) + "/contact",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-quickducks-ownership-proof": proof,
          },
          body: JSON.stringify({
            commandId: pendingCommandId,
            expectedRevision: contact.revision,
            email: emailInput.value,
            phone: phoneInput.value,
            emailNotificationsEnabled: emailCheckbox.checked,
            smsNotificationsEnabled: smsCheckbox.checked,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok || !participantValidContact(body, registration.registrationId)) {
        feedback.textContent = body && typeof body.error === "string"
          ? body.error
          : "Contact details could not be saved. Please try again.";
        feedback.hidden = false;
        save.disabled = false;
        save.textContent = "Save changes";
        return;
      }
      const updatedContact = participantContactSnapshot(body);
      registration.contact = updatedContact;
      participantRememberContact(registration.registrationId, updatedContact);
      delete form.dataset.liveDirty;
      globalThis.quickDucksLive.markClean(form);
      participantPaintContact(panel, registration);
    } catch {
      feedback.textContent = "The network interrupted the update. Try again; the same update will be retried safely.";
      feedback.hidden = false;
      save.disabled = false;
      save.textContent = "Save changes";
    } finally {
      endBusy();
    }
  });

  panel.replaceChildren(summary, edit, form);
};

const participantContactPanel = (registration) => {
  const panel = participantText("section", "", "participant-contact");
  panel.dataset.contactPanel = registration.registrationId;
  participantPaintContact(panel, registration);
  return panel;
};

const participantQrNamespace = "http://www.w3.org/2000/svg";

// The server sends drawing geometry rather than markup, and this builds the
// symbol through namespaced DOM calls, so nothing from the response is ever
// parsed as HTML. The path guard keeps that true even if the projection ever
// changed shape: only the digits, spaces, signs, and Mhvz commands the encoder
// emits can reach the attribute, and anything else drops the QR instead of
// drawing it.
const participantQrPathPattern = /^[Mhvz0-9 -]+$/;

const participantQrFigure = (registration) => {
  const qr = registration.qr;
  if (!qr || typeof qr.path !== "string" || !participantQrPathPattern.test(qr.path)) return null;
  const size = Number(qr.size);
  if (!Number.isFinite(size) || size <= 0) return null;

  const svg = document.createElementNS(participantQrNamespace, "svg");
  svg.setAttribute("class", "participant-qr");
  svg.setAttribute("viewBox", "0 0 " + size + " " + size);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  // Named, because several cards can be on screen at once and an identical
  // label on each one tells a screen-reader user nothing about which is which.
  svg.setAttribute("aria-label", "QR code with the staff lookup code for " + participantDisplayName(registration));
  const background = document.createElementNS(participantQrNamespace, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  const modules = document.createElementNS(participantQrNamespace, "path");
  modules.setAttribute("fill", "#111827");
  modules.setAttribute("d", qr.path);
  svg.append(background, modules);

  const frame = participantText("div", "", "lookup-code-qr");
  frame.append(svg);
  return frame;
};

// Every card is rendered the same way, including the one this visitor has just
// registered: a card that was created a second ago and the same card on the next
// plain refresh must look identical. The one-time private status link lives in
// the page's own success notice instead, which is where it can be read once and
// then go away with the rest of the notice.
const participantCard = (registration) => {
  const card = participantText("article", "", "duck-card participant-card");
  card.dataset.registrationId = registration.registrationId;
  if (registration.followed) {
    card.append(participantText("span", "Following", "success-tag"));
  }
  card.append(participantText("h3", participantDisplayName(registration)));
  card.append(registration.followed
    ? participantText("p", "Followed from a duck tag, a duck page, or the race status search. Followed participants have no staff lookup code here.", "muted")
    : participantText("p", "Staff lookup code: " + registration.lookupCode));
  const qrFigure = registration.followed ? null : participantQrFigure(registration);
  if (qrFigure !== null) {
    card.append(qrFigure);
  }
  // The readable lookup code remains usable when QR geometry is unavailable,
  // so assignment guidance must not depend on drawing the optional QR. Once a
  // duck is paired there is nothing left to do at the registration table; the
  // QR caption instead explains what that code is still good for.
  if (!registration.followed && registration.paired !== true) {
    card.append(participantText("p", "Show this code to staff at registration table to get your duck!", "muted"));
  } else if (qrFigure !== null) {
    card.append(participantText("p", "Staff can scan this code, or type it, to pull up this registration.", "muted"));
  }
  card.append(participantText("p", "Registration: " + participantHumanize(registration.registrationStatus), "muted"));
  participantAddRaceFacts(card, registration.raceStatus, registration);
  if (!registration.followed) card.append(participantContactPanel(registration));
  if (participantCanDelete(registration)) card.append(...participantDeleteControls(registration));
  if (participantCanUnfollow(registration)) card.append(...participantUnfollowControls(registration));
  return card;
};

const participantUpdateControls = (section) => {
  const track = section.querySelector("[data-participant-track]");
  const previous = section.querySelector("[data-carousel-previous]");
  const next = section.querySelector("[data-carousel-next]");
  previous.disabled = track.scrollLeft <= 4;
  next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 4;
};

const participantMove = (section, direction) => {
  const track = section.querySelector("[data-participant-track]");
  const cards = Array.from(track.children);
  if (cards.length === 0) return;
  let closest = 0;
  let distance = Infinity;
  for (const [index, card] of cards.entries()) {
    const nextDistance = Math.abs(card.offsetLeft - track.scrollLeft);
    if (nextDistance < distance) {
      closest = index;
      distance = nextDistance;
    }
  }
  const target = cards[Math.max(0, Math.min(cards.length - 1, closest + direction))];
  target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
};

for (const section of participantSections) {
  const track = section.querySelector("[data-participant-track]");
  section.querySelector("[data-carousel-previous]").addEventListener("click", () => participantMove(section, -1));
  section.querySelector("[data-carousel-next]").addEventListener("click", () => participantMove(section, 1));
  track.addEventListener("scroll", () => participantUpdateControls(section), { passive: true });
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      participantMove(section, event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const cards = Array.from(track.children);
      const target = event.key === "Home" ? cards[0] : cards.at(-1);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
    }
  });
}
window.addEventListener("resize", () => {
  for (const section of participantSections) participantUpdateControls(section);
});

// Empty groups normally hide their whole section rather than showing an empty
// card. During open registration the awaiting heading stays visible because it
// owns the Register another participant action; its empty track and carousel
// controls remain hidden. Every section still starts hidden until the first
// successful full collection response, so nothing flashes before data loads.
const participantRenderSection = (kind, registrations) => {
  const section = participantSections.find((item) => item.dataset.participantSection === kind);
  if (!section) return;
  const track = section.querySelector("[data-participant-track]");
  const controls = section.querySelector("[data-carousel-controls]");
  track.replaceChildren(...registrations.map(participantCard));
  const hasRegistrations = registrations.length > 0;
  section.hidden = !hasRegistrations && section.dataset.keepEmpty !== "true";
  track.hidden = !hasRegistrations;
  controls.hidden = !hasRegistrations;
  if (hasRegistrations) requestAnimationFrame(() => participantUpdateControls(section));
};

const participantCleanRegisteredQuery = () => {
  history.replaceState(history.state, "", location.pathname + location.hash);
};

const participantRender = (registrations) => {
  const version = JSON.stringify(registrations);
  const justRegistered = participantRegisteredId
    ? registrations.find((registration) => registration.registrationId === participantRegisteredId)
    : null;
  if (justRegistered) {
    participantSuccessId = justRegistered.registrationId;
    if (participantPrivateStatusPath === null) {
      let handoff = null;
      try {
        handoff = participantConsumeHandoff(globalThis.sessionStorage, justRegistered.registrationId, location.origin);
      } catch {}
      if (handoff !== null) participantPrivateStatusPath = handoff.privateStatusPath;
    }
  }
  if (participantSuccessId && !registrations.some((registration) => registration.registrationId === participantSuccessId)) {
    participantSuccessId = null;
    participantSuccess.hidden = true;
  }
  if (version !== participantVersion || justRegistered) {
    participantVersion = version;
    // Three groups, one rule: a participant registered on this device is
    // "mine" and keeps its full detail, and everything else is a followed
    // duck with the public projection only. A malformed or missing paired value
    // fails closed into awaiting rather than revealing assignment-only detail.
    const owned = registrations.filter((registration) => registration.followed !== true);
    participantRenderSection("awaiting", owned.filter((registration) => registration.paired !== true));
    participantRenderSection("paired", owned.filter((registration) => registration.paired === true));
    participantRenderSection(
      "followed",
      registrations.filter((registration) => registration.followed === true),
    );
    // Both sections can be hidden, so keep one guidance message instead of an
    // otherwise blank page.
    if (participantEmpty) participantEmpty.hidden = registrations.length > 0;
  }
  if (!justRegistered) return;

  // The notice is this visitor's only chance to open and bookmark the private
  // status link, so it names the participant it belongs to. It stays an ordinary
  // polite notice: the card itself is not marked, decorated, or focused.
  participantSuccess.replaceChildren(
    participantText("strong", "Registration saved. "),
    participantText("span", participantDisplayName(justRegistered) + "."),
  );
  if (participantPrivateStatusPath !== null) {
    const privateLink = participantText("a", "Open private status", "card-link");
    privateLink.href = participantPrivateStatusPath;
    participantSuccess.append(participantText("span", " "), privateLink);
  }
  participantSuccess.hidden = false;
  participantRegisteredId = null;
  // Scrolling the new card into view is orientation, not emphasis: the card is
  // in a horizontal track that may already have scrolled past it. Focus is
  // deliberately left alone: the notice is a polite live region above the
  // sections, so assistive technology already announces the result and the
  // private link is the next thing in the tab order.
  const card = Array.from(document.querySelectorAll("[data-registration-id]"))
    .find((item) => item.dataset.registrationId === justRegistered.registrationId);
  if (card) requestAnimationFrame(() => {
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    participantCleanRegisteredQuery();
  });
  else participantCleanRegisteredQuery();
};

// ---------------------------------------------------------------------------
// Duck-page follow control
//
// The two public duck pages (/t/<tag> and /duck/<number>) carry one optional
// control: adding the participant this duck belongs to into this browser's My
// Ducks list. It lives in this client, not in the board client, because this is
// the browser-collection client: it already owns the collection endpoints and
// the My Ducks nav presence rule.
//
// The server paints the control's state, and the authoritative duck response
// repaints it, so a control is offered only while the follow endpoint would
// actually accept it.
// ---------------------------------------------------------------------------
const participantFollowRoot = document.querySelector("[data-duck-follow]");
const participantFollowMessage = document.querySelector("[data-follow-message]");
let participantFollowBusy = false;

// The duck page addresses itself by tag token or by visible number, and the
// follow signals come from that same public endpoint.
const participantDuckStatusPath = () => {
  const parts = location.pathname.split("/");
  if (parts.length !== 3 || parts[2].length === 0) return null;
  if (parts[1] === "t") return "/api/v1/ducks/" + encodeURIComponent(parts[2]);
  if (parts[1] === "duck") return "/api/v1/ducks/number/" + encodeURIComponent(parts[2]);
  return null;
};

const participantShowFollowMessage = (message) => {
  if (!participantFollowMessage) return;
  participantFollowMessage.textContent = message === null ? "" : message;
  participantFollowMessage.hidden = message === null;
};

const participantFollowAdded = () => {
  const tag = participantText("span", "In My Ducks", "success-tag");
  tag.dataset.followAdded = "";
  const link = participantText("a", "Open My Ducks", "button secondary small");
  link.href = "/my-ducks";
  return [tag, link];
};

const participantFollow = async (followId, button) => {
  participantFollowBusy = true;
  button.disabled = true;
  button.textContent = "Adding…";
  participantShowFollowMessage(null);
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    let followed = false;
    try {
      const response = await fetch("/api/v1/registrations/mine/follow", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ followId }),
      });
      followed = response.ok;
    } catch {
      followed = false;
    }
    if (!followed) {
      button.disabled = false;
      button.textContent = "Follow this duck";
      participantShowFollowMessage("That participant could not be added to My Ducks. Please try again.");
      return;
    }
    participantFollowRoot.replaceChildren(...participantFollowAdded());
    // This device now holds a saved entry, so record the presence half of the
    // My Ducks nav rule and reveal the link immediately.
    participantSetNavPresence(true);
  } finally {
    participantFollowBusy = false;
    endBusy();
  }
};

// A followId is present only while this participant is genuinely followable, so
// its absence removes the control instead of rendering a dead button.
const participantRenderFollow = (status) => {
  if (!participantFollowRoot || participantFollowBusy) return;
  if (!status || typeof status.followId !== "string") {
    participantFollowRoot.replaceChildren();
    participantFollowRoot.hidden = true;
    participantShowFollowMessage(null);
    return;
  }
  participantFollowRoot.hidden = false;
  participantFollowRoot.dataset.followId = status.followId;
  if (status.inMyDucks === true) {
    participantFollowRoot.replaceChildren(...participantFollowAdded());
    return;
  }
  const button = participantText("button", "Follow this duck", "button");
  button.type = "button";
  button.dataset.followButton = "";
  button.addEventListener("click", () => participantFollow(status.followId, button));
  participantFollowRoot.replaceChildren(button);
};

const participantRefreshFollow = async () => {
  const path = participantDuckStatusPath();
  if (path === null) return;
  const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  // A duck that stopped being public is handled by the board client's own
  // reload path; this control simply keeps whatever the server painted.
  if (!response.ok) return;
  const body = await response.json();
  if (document.hidden) return;
  participantRenderFollow(body.raceStatus);
};

const participantFetch = async () => {
  const renderGeneration = participantRenderGeneration;
  const response = await fetch(participantRoot
    ? "/api/v1/registrations/mine"
    : "/api/v1/registrations/mine/presence", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("refresh failed");
  const body = await response.json();
  if (!participantRoot) {
    if (!body || typeof body.hasRegistrations !== "boolean") throw new Error("invalid presence response");
    participantSetNavPresence(body.hasRegistrations);
    return;
  }
  if (!body || !Array.isArray(body.registrations)) throw new Error("invalid collection response");
  const registrations = await Promise.all(body.registrations.map(participantLoadContact));
  participantSetNavPresence(registrations.length > 0);
  participantSetSearchPlacement(registrations.length > 0);
  // The hub checks dirty state before starting a refresh. Check it again before
  // painting because a previously started request can finish after the visitor
  // opens or changes an editor; that response must not detach the active form.
  const editStartedDuringFetch = globalThis.quickDucksLive.isDirty?.(participantRoot) === true;
  if (
    !document.hidden
    && !editStartedDuringFetch
    && renderGeneration === participantRenderGeneration
  ) participantRender(registrations);
};

const participantRefreshWork = async () => {
  try {
    await participantFetch();
    participantShowError(null);
  } catch {
    participantShowError("Saved registrations could not be loaded. This page keeps trying automatically.");
  }
};

if (participantRoot) {
  if (participantRegisteredId && !participantRegistrationIdPattern.test(participantRegisteredId)) {
    participantRegisteredId = null;
    participantCleanRegisteredQuery();
  }
  globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: participantRoot,
    refresh: participantRefreshWork,
  });
} else {
  participantFetch().catch(() => {});
}

// The server-rendered button is wired immediately so the control works before
// any refetch, and the duck page then keeps it in step with the authoritative
// duck response. Every other page has no follow container and subscribes
// nothing here, so it still holds no live connection of its own.
if (participantFollowRoot) {
  const participantServerFollow = participantFollowRoot.querySelector("[data-follow-button]");
  if (participantServerFollow) {
    participantServerFollow.addEventListener("click", () => participantFollow(
      participantFollowRoot.dataset.followId,
      participantServerFollow,
    ));
  }
  globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks"],
    root: participantFollowRoot,
    refresh: async () => {
      try {
        await participantRefreshFollow();
      } catch {}
    },
    isBlocked: () => participantFollowBusy,
  });
}
`;

export const liveRuntimeHelpersScript = String.raw`
const liveAllowedDomains = new Set(["all", "event", "participants", "ducks", "heats", "staff", "support"]);
const livePollDelay = (connected) => connected ? 30000 : 5000;
const liveDirtyDeferralMs = 300000;
const liveReconnectDelay = (attempt, randomValue = Math.random()) => {
  const base = Math.min(1000 * (2 ** attempt), 15000);
  return Math.round(Math.min(15000, base * (0.8 + (0.4 * randomValue))));
};
const liveParseRefreshSignal = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  try {
    const signal = JSON.parse(value);
    if (!signal || Array.isArray(signal) || typeof signal !== "object") return null;
    if (Object.keys(signal).sort().join(",") !== "domains,type,version") return null;
    if (signal.type !== "refresh" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(signal.version)) return null;
    if (!Array.isArray(signal.domains) || signal.domains.length === 0 || signal.domains.length > liveAllowedDomains.size) return null;
    if (signal.domains.some((domain) => typeof domain !== "string" || !liveAllowedDomains.has(domain))) return null;
    if (new Set(signal.domains).size !== signal.domains.length) return null;
    if (signal.domains.includes("all") && signal.domains.length !== 1) return null;
    return signal;
  } catch {
    return null;
  }
};
const liveSignalMatches = (signal, domains) => signal.domains.includes("all")
  || domains.some((domain) => signal.domains.includes(domain));
const liveCreateRefreshQueue = (work, isBlocked) => {
  let running = null;
  let queued = false;
  const refresh = () => {
    queued = true;
    if (isBlocked()) return Promise.resolve(false);
    if (running) {
      return running;
    }
    running = (async () => {
      try {
        while (queued && !isBlocked()) {
          queued = false;
          await work();
        }
        return true;
      } finally {
        running = null;
      }
    })();
    return running;
  };
  refresh.hasQueued = () => queued;
  return refresh;
};
const liveCreatePollScheduler = (work, isHidden, setTimer = setTimeout, clearTimer = clearTimeout) => {
  let timer = null;
  let connected = false;
  const pause = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (nextConnected = connected) => {
    connected = nextConnected;
    pause();
    if (isHidden()) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        if (!isHidden()) await work();
      } finally {
        schedule();
      }
    }, livePollDelay(connected));
  };
  return { pause, schedule };
};
const liveCreateHub = ({
  WebSocketClass = globalThis.WebSocket,
  documentObject = document,
  locationObject = location,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) => {
  const subscribers = new Set();
  let socket = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let busyCount = 0;
  let pendingAccessReload = false;
  let accessCheck = null;
  let startRequested = false;
  let active = false;

  const isDirty = (root = documentObject) => Boolean(root.querySelector?.("[data-live-dirty='true']"));
  const pageBlocked = () => busyCount > 0 || isDirty();
  // Dirty tracking is scoped to each subscriber's root and bounded: an edit
  // abandoned in one root defers only that subscriber's refreshes, and after
  // five minutes the authoritative refetch proceeds anyway.
  const dirtyDeferred = (subscriber) => {
    if (!isDirty(subscriber.root)) {
      subscriber.dirtySince = null;
      return false;
    }
    if (subscriber.dirtySince === null) subscriber.dirtySince = now();
    return now() - subscriber.dirtySince < liveDirtyDeferralMs;
  };
  const clearPrivatePage = () => {
    const main = documentObject.querySelector?.("main");
    if (main) main.replaceChildren();
  };
  const tryPendingAccessReload = () => {
    if (!pendingAccessReload || pageBlocked()) return;
    pendingAccessReload = false;
    locationObject.reload();
  };
  const markClean = (root) => {
    if (!root) return;
    delete root.dataset.liveDirty;
    for (const control of root.querySelectorAll?.("[data-live-dirty='true']") || []) delete control.dataset.liveDirty;
    tryPendingAccessReload();
    for (const subscriber of subscribers) subscriber.queue();
  };
  const beginBusy = () => {
    busyCount += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      busyCount = Math.max(0, busyCount - 1);
      tryPendingAccessReload();
      for (const subscriber of subscribers) subscriber.queue();
    };
  };
  const refreshAll = () => {
    for (const subscriber of subscribers) subscriber.queue();
  };
  const verifyStaffAccess = () => {
    const root = documentObject.querySelector?.("[data-live-staff]");
    if (!root) return Promise.resolve(true);
    if (accessCheck) return accessCheck;
    accessCheck = (async () => {
      let response;
      try {
        response = await fetch("/api/v1/staff/session", { headers: { accept: "application/json" }, cache: "no-store" });
      } catch {
        return true;
      }
      if (response.status === 401) {
        clearPrivatePage();
        locationObject.replace("/staff");
        return false;
      }
      if (!response.ok) return true;
      let body;
      try { body = await response.json(); } catch { return true; }
      const access = body && body.access;
      if (!access || typeof access.isSystemAdmin !== "boolean" || !Array.isArray(access.roles)) return true;
      const previousAdmin = root.dataset.systemAdmin === "true";
      const previousRoles = new Set((root.dataset.roles || "").split(",").filter(Boolean));
      const currentRoles = new Set(access.roles.filter((role) => typeof role === "string"));
      const unchanged = previousAdmin === access.isSystemAdmin
        && previousRoles.size === currentRoles.size
        && [...previousRoles].every((role) => currentRoles.has(role));
      if (unchanged) return true;
      const reduced = (previousAdmin && !access.isSystemAdmin)
        || [...previousRoles].some((role) => !currentRoles.has(role));
      if (reduced) {
        clearPrivatePage();
        locationObject.reload();
        return false;
      }
      pendingAccessReload = true;
      tryPendingAccessReload();
      return false;
    })().finally(() => { accessCheck = null; });
    return accessCheck;
  };
  const emit = async (signal) => {
    if (signal.domains.includes("all")) {
      clearPrivatePage();
      locationObject.reload();
      return;
    }
    if (signal.domains.includes("staff") && !await verifyStaffAccess()) return;
    for (const subscriber of subscribers) {
      if (!liveSignalMatches(signal, subscriber.domains)) continue;
      if (subscriber.signal?.(signal) === false) continue;
      subscriber.queue();
    }
  };
  const poller = liveCreatePollScheduler(refreshAll, () => documentObject.hidden, setTimer, clearTimer);
  const connect = () => {
    if (typeof WebSocketClass !== "function" || documentObject.hidden) {
      poller.schedule(false);
      return;
    }
    const protocol = locationObject.protocol === "https:" ? "wss:" : "ws:";
    const candidate = new WebSocketClass(protocol + "//" + locationObject.host + "/api/v1/live");
    socket = candidate;
    candidate.addEventListener("open", () => {
      if (socket !== candidate) return;
      reconnectAttempt = 0;
      poller.schedule(true);
      refreshAll();
    });
    candidate.addEventListener("message", (event) => {
      const signal = liveParseRefreshSignal(event.data);
      if (signal !== null) void emit(signal);
    });
    candidate.addEventListener("close", () => {
      if (socket !== candidate) return;
      socket = null;
      poller.schedule(false);
      const delay = liveReconnectDelay(reconnectAttempt);
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      clearTimer(reconnectTimer);
      if (!documentObject.hidden) reconnectTimer = setTimer(connect, delay);
    });
    candidate.addEventListener("error", () => { candidate.close(); });
  };
  documentObject.addEventListener("input", (event) => {
    if (event.target?.matches?.("input, select, textarea")) event.target.dataset.liveDirty = "true";
  });
  documentObject.addEventListener("change", (event) => {
    if (event.target?.matches?.("input, select, textarea")) event.target.dataset.liveDirty = "true";
  });
  documentObject.addEventListener("visibilitychange", () => {
    if (documentObject.hidden) {
      poller.pause();
      clearTimer(reconnectTimer);
      return;
    }
    if (!active) return;
    refreshAll();
    poller.schedule(socket !== null);
    if (socket === null) connect();
  });
  // The socket and polling scheduler start lazily on the first subscriber:
  // pages without live subscribers open no connection and schedule no polls.
  // The RaceUpdates object admits a bounded number of sockets, so purely
  // informational pages must not spend one. Every subscriber, including the
  // phase-driven navigation subscriber, is registered conditionally to keep
  // that guarantee.
  const activate = () => {
    if (active || !startRequested || subscribers.size === 0) return;
    active = true;
    poller.schedule(false);
    connect();
  };
  return {
    beginBusy,
    isDirty,
    markClean,
    start() {
      startRequested = true;
      activate();
    },
    subscribe({ domains, refresh, isBlocked = () => false, signal, root }) {
      const subscriber = {
        domains,
        signal,
        root: root ?? documentObject,
        dirtySince: null,
      };
      subscriber.queue = liveCreateRefreshQueue(
        refresh,
        () => documentObject.hidden || busyCount > 0 || dirtyDeferred(subscriber) || isBlocked(),
      );
      subscribers.add(subscriber);
      activate();
      subscriber.queue();
      return {
        refresh: subscriber.queue,
        resume: subscriber.queue,
        unsubscribe() { subscribers.delete(subscriber); },
      };
    },
  };
};
`;

// Shared public duck-detail helpers. They are declared once, in the runtime
// every rendered page already loads, so live.js and participant.js can both
// build the same link without redeclaring a global in the shared classic scope.
// The label maps are serialized from the server projection so browser wording
// can never drift from the server-rendered page.
export const duckDetailHelpersScript = String.raw`
const duckHeatStatusLabels = ${JSON.stringify(publicHeatStatusLabels)};
const duckHeatStatusLabel = (status) => Object.prototype.hasOwnProperty.call(duckHeatStatusLabels, status)
  ? duckHeatStatusLabels[status]
  : "Status being checked";
const duckOfficialResults = ${JSON.stringify(publicOfficialResults)};
const duckOfficialResult = (outcome) => Object.prototype.hasOwnProperty.call(duckOfficialResults, outcome)
  ? duckOfficialResults[outcome]
  : null;
const duckDetailPath = (duckNumber) => "/duck/" + encodeURIComponent(String(duckNumber));
// Returns null unless a real duck number is assigned, so an unpaired entry
// renders plain text and never an empty or misleading link. The node is built
// with safe DOM APIs and is a plain navigation with no script behaviour.
// The optional public name replaces only the visible text, never the numbered
// destination. Every public surface uses the same helper so named and unnamed
// ducks cannot drift into different link rules.
const duckDetailLink = (documentObject, duckNumber, label) => {
  if (typeof duckNumber !== "number" || !Number.isInteger(duckNumber) || duckNumber <= 0) return null;
  const link = documentObject.createElement("a");
  link.className = "duck-number-link";
  link.href = duckDetailPath(duckNumber);
  link.textContent = typeof label === "string" && label.length > 0 ? label : "Duck #" + duckNumber;
  return link;
};
`;

// Public navigation is phase-driven. The server paints the correct nav from one
// lightweight current-event query, and this client keeps it correct without a
// refresh by re-reading the same authoritative projection whenever the live hub
// signals an event change. The phase map is serialized from the server module so
// the two can never drift.
//
// Register and Race Status strictly swap: exactly one of them is in the nav for
// every post-DRAFT phase, and neither is present while a race is being prepared.
//
// This runtime ships inside `live-ui.js`, which every rendered page loads, so it
// must not subscribe unconditionally: a subscriber is what makes the lazy hub
// open its socket and start its pollers. The server marks public content pages
// with `data-live-nav` on the nav, and only those pages register the subscriber.
// A staff sign-in page, a not-found page, an unsupported-device page, or a staff
// error page therefore keeps its server-rendered nav and holds no connection.
export const sitePhaseNavScript = String.raw`
const navPhaseByStatus = ${JSON.stringify(publicPhaseByStatus)};
const navPhaseForStatus = (status) => Object.prototype.hasOwnProperty.call(navPhaseByStatus, status)
  ? navPhaseByStatus[status]
  : "PREPARING";
const navRoot = document.querySelector("[data-site-nav]");
// Admission marker, server-rendered on public content pages only. Its absence
// means this page has no live need, so it must not subscribe and must stay
// socket-free.
const navIsLive = navRoot !== null && navRoot.dataset.liveNav !== undefined;
const navMyDucks = document.querySelector("[data-my-ducks-nav]");
const navBuildLink = (href, label, marker) => {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;
  link.dataset[marker] = "";
  return link;
};
const navSwapLink = (phase) => {
  if (phase === "REGISTRATION") {
    return navRoot.querySelector("[data-nav-register]") || navBuildLink("/register", "Register", "navRegister");
  }
  if (phase === "PREPARING") return null;
  return navRoot.querySelector("[data-nav-race]") || navBuildLink("/race", "Race Status", "navRace");
};
// My Ducks follows the phase because the route redirects home during Preparing.
// Saved-registration presence still controls the page layout after it opens.
const navApplyMyDucks = (phase) => {
  if (!navMyDucks) return;
  navMyDucks.dataset.phaseVisible = phase === "PREPARING" ? "false" : "true";
  navMyDucks.hidden = navMyDucks.dataset.phaseVisible !== "true";
};
const navRender = (phase) => {
  if (!navRoot) return;
  navRoot.dataset.phase = phase;
  const links = [];
  const home = navRoot.querySelector("[data-nav-home]");
  if (home) links.push(home);
  const swap = navSwapLink(phase);
  if (swap) links.push(swap);
  navApplyMyDucks(phase);
  if (navMyDucks) links.push(navMyDucks);
  const staff = navRoot.querySelector("[data-nav-staff]");
  if (staff) links.push(staff);
  navRoot.replaceChildren(...links);
};
const navRefresh = async () => {
  try {
    const response = await fetch("/api/v1/events/current", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const body = await response.json();
    navRender(navPhaseForStatus(body && body.event ? body.event.status : null));
  } catch {}
};
if (navIsLive) {
  globalThis.quickDucksLive.subscribe({ domains: ["event"], root: navRoot, refresh: navRefresh });
}
`;

// `live-ui.js` is the one bundle every page loads, and it loads first because it
// is the only deferred head script. The shared confirmation dialog therefore
// ships here rather than in each page client: page clients are classic scripts
// sharing one global scope, and `participant.js` rides on every page too, so a
// second copy of the dialog in any page client would redeclare these bindings
// and break the whole scope.
export const liveUiScript = confirmationDialogScript + liveRuntimeHelpersScript + duckDetailHelpersScript + String.raw`
globalThis.quickDucksLive = liveCreateHub();
globalThis.quickDucksLive.start();
` + sitePhaseNavScript;

// Staff rosters keep a withdrawn or disqualified racer forever. Their duck was
// sealed into the numbered heat bag when they were paired, nobody digs through a
// bag on the bank, so it stays in its slot and still floats down the river. The
// only thing that changed is that it can never be recorded as a winner. Staff
// therefore see the entry — they have to reconcile what is physically in each
// bag — with a loud marker naming the real status word. Only public surfaces
// hide these racers.
//
// `eligible === false` is the single trigger, exactly as the staff projections
// state it. A projection that does not carry the field renders precisely as it
// did before, and nothing here can throw on a missing entry, a missing
// participant, or an unknown status: one throw inside a render silently kills
// every control after it.
export const rosterEligibilityHelpersScript = String.raw`
const rosterStatusWord = (status) => {
  if (status === "WITHDRAWN") return "Withdrawn";
  if (status === "DISQUALIFIED") return "Disqualified";
  const plain = String(status == null ? "" : status).replaceAll("_", " ").trim().toLowerCase();
  return plain === "" ? "Not eligible" : plain.replace(/^./, (character) => character.toUpperCase());
};
const ROSTER_INELIGIBLE_NOTE = "The duck stays in its heat bag and still races, but cannot be recorded as a winner.";
const rosterIneligibleMarker = (entry, lead) => {
  if (!entry || entry.eligible !== false) return null;
  const status = rosterStatusWord(entry.registrationStatus == null && entry.participant
    ? entry.participant.registrationStatus
    : entry.registrationStatus);
  return { status, flag: lead + " · " + status, note: ROSTER_INELIGIBLE_NOTE };
};
// Adds the marker to an already-built row or card, whatever element factory the
// surface uses. Returns whether it marked, so a caller can assert on it.
const rosterMarkIneligible = (container, entry, lead, text) => {
  const marker = rosterIneligibleMarker(entry, lead);
  if (marker === null) return false;
  container.className = container.className ? container.className + " ineligible" : "ineligible";
  container.append(text("strong", marker.flag, "roster-flag"), text("p", marker.note, "roster-flag-note"));
  return true;
};
// "Can this entry still be recorded as a winner?" — the single question every
// surface that counts, offers, or requires a place must ask, stated once.
//
// It is the exact complement of the marker above: only an explicit
// eligible:false is ineligible. A projection served before the field existed
// reports undefined and is treated as eligible, which keeps such a response
// behaving exactly as it did before rather than silently shrinking a podium to
// zero places and stranding an event that has no other way out.
const rosterEntryEligible = (entry) => !entry || entry.eligible !== false;
const rosterEligibleEntries = (roster) => (Array.isArray(roster) ? roster : []).filter(rosterEntryEligible);
// A locked roster cannot gain or lose an entry, but a racer on it can withdraw
// or be disqualified at any heat state, and that changes nothing the heat itself
// records — not its status and not its revision. A station that keys its render
// on the heat alone would throw the repaint away and keep showing an unmarked
// racer whose duck can no longer win, and keep demanding a place nobody is
// allowed to fill. Every station roster therefore folds this into its key.
const rosterEligibilityKey = (roster) => (Array.isArray(roster) ? roster : [])
  .map((entry) => (entry && entry.raceEntryId) + (rosterEntryEligible(entry) ? ":1" : ":0"))
  .join(",");
`;

// The final's podium is built by scanning one duck at a time and choosing where
// it finished, so two separate surfaces name the same three places: the duck
// inspection page, which is where a place is actually chosen, and the
// finish-line station, which shows the podium filling up. They share these words
// so a staffer reading "2nd place" on one screen and "2nd place" on the other is
// certainly reading about the same place.
export const podiumPlaceHelpersScript = String.raw`
const PODIUM_PLACE_LABELS = { 1: "1st place", 2: "2nd place", 3: "3rd place" };
const podiumPlaceLabel = (place) => Object.prototype.hasOwnProperty.call(PODIUM_PLACE_LABELS, place)
  ? PODIUM_PLACE_LABELS[place]
  : "Place " + place;
// Only ever what the server said is open. The list is deliberately not derived
// from "1 to requiredPlaces minus the ones I can see": a place another station
// took a second ago is not on screen yet, and offering it would send a staffer
// into a refusal instead of to the next duck.
const podiumOpenPlaces = (podium) => !podium || !Array.isArray(podium.availablePlaces)
  ? []
  : podium.availablePlaces.filter((place) => Number.isSafeInteger(place) && place >= 1 && place <= 3);
const podiumTakenPlacements = (podium) => !podium || !Array.isArray(podium.placements)
  ? []
  : podium.placements.slice().sort((left, right) => left.place - right.place);
`;

export const stationStateHelpersScript = String.raw`
const startPickHeat = (heats, round) => {
  const active = heats.filter((heat) => heat.round === round && heat.status !== "FINALIZED" && heat.status !== "CANCELLED");
  return active.find((heat) => heat.status === "AWAITING_RESULT")
    || active.find((heat) => heat.status === "RUNNING")
    || active.find((heat) => ["PLANNED", "LOADING", "READY", "CALLING"].includes(heat.status))
    || null;
};
const finishPickHeat = (heats, round) => heats.find((heat) => heat.round === round && heat.status === "AWAITING_RESULT")
  || heats.find((heat) => heat.round === round && heat.status === "RUNNING")
  || null;
const stationHeatRenderKey = (event, detail) => [
  event.id,
  detail.heat.id,
  detail.heat.revision,
  detail.heat.status,
].join(":");
`;

// Every event lifecycle status maps to plain race-day language. The public
// board projection publishes REGISTRATION_OPEN through COMPLETED; DRAFT is
// mapped too so the board never falls back to raw enum text.
export const liveBoardStageScript = String.raw`
const liveEventStages = {
  DRAFT: ["Race being prepared", "Race staff are still preparing this race."],
  REGISTRATION_OPEN: ["Participant registration open", "Registration is open. Sign up to put a duck in this race."],
  REGISTRATION_CLOSED: ["Registration closed", "Registration is closed while staff finalize the heats."],
  ROUND_ONE: ["Round one under way", "Round one is under way."],
  FINAL: ["Final under way", "The final is under way."],
  COMPLETED: ["Results official", "Every heat is finished and the results are final."],
};
const liveEventStage = (status) => {
  const stage = liveEventStages[Object.prototype.hasOwnProperty.call(liveEventStages, status) ? status : ""];
  return stage === undefined
    ? { label: "Race stage updating", summary: "The race stage is being confirmed." }
    : { label: stage[0], summary: stage[1] };
};
const liveStageSummary = (status, heatDetail, hasHeats) => {
  const stage = liveEventStage(status);
  if (heatDetail) return stage.summary + " Running now: " + heatDetail + ".";
  if (!hasHeats) return stage.summary + " Heats have not been posted yet.";
  return stage.summary + " The latest official heats and results are below.";
};
`;

export const liveScript = liveBoardStageScript + String.raw`
const liveBoardRoot = document.querySelector("[data-live-board]");
const liveBoardStageChip = document.querySelector("[data-live-board-stage]");
const liveBoardTitle = document.querySelector("[data-live-board-title]");
const liveBoardSummary = document.querySelector("[data-live-board-summary]");
const liveBoardContent = document.querySelector("[data-live-board-content]");
// The board and the compact home summary each own one error-only line, and
// exactly one of them is on any given page.
const liveBoardError = document.querySelector("[data-live-board-error]")
  || document.querySelector("[data-live-summary-error]");
const liveSummaryRoot = document.querySelector("[data-live-summary]");
const liveSummaryStage = document.querySelector("[data-live-summary-stage]");
const liveSummaryTitle = document.querySelector("[data-live-summary-title]");
const liveSummaryLine = document.querySelector("[data-live-summary-line]");
let liveBoardVersion = null;
let liveSummaryVersion = null;

// Error-only line: hidden while the board loads, shown only when the
// authoritative board request fails, and cleared on the next success. It never
// reports a "current"/"updated" state.
const liveShowBoardError = (message) => {
  if (!liveBoardError) return;
  liveBoardError.textContent = message === null ? "" : message;
  liveBoardError.hidden = message === null;
};

const liveText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

const liveHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase()
  .replace(/^./, (character) => character.toUpperCase());

const liveRoundLabel = (round) => round === "FINAL" ? "Final" : "Round one";
const livePlaceLabel = (place) => place === 1 ? "1st" : place === 2 ? "2nd" : "3rd";
// The Winners finale states each rank in words. A final can be configured
// deeper than three, so the ordinal is derived rather than picked from a
// three-entry table that would call 4th place "3rd".
const liveOrdinal = (place) => {
  const tens = place % 100;
  const ones = place % 10;
  const suffix = tens >= 11 && tens <= 13 ? "th"
    : ones === 1 ? "st"
    : ones === 2 ? "nd"
    : ones === 3 ? "rd"
    : "th";
  return place + suffix;
};
// Gold, silver, bronze — and nothing at all below third, because a medal is
// never invented for a place that does not have one. The medal name is rendered
// as text beside the ordinal, so rank never depends on colour, on the medal
// disc, or on the stylesheet loading at all.
const liveMedals = { 1: "Gold", 2: "Silver", 3: "Bronze" };
const liveMedalName = (place) => Object.prototype.hasOwnProperty.call(liveMedals, place)
  ? liveMedals[place]
  : null;
const liveHeatStatus = (status) => ({
  PLANNED: "Coming up",
  LOADING: "Ducks are being prepared",
  READY: "Ready to call",
  CALLING: "Heat has been announced",
  RUNNING: "Racing now",
  AWAITING_RESULT: "Race finished; checking the result",
  FINALIZED: "Result official",
  CANCELLED: "Not running",
})[status] || "Status being checked";

const liveAddFact = (container, label, value) => {
  const fact = liveText("div", "", "fact");
  fact.append(liveText("dt", label), liveText("dd", value));
  container.append(fact);
};

// Mirrors the server's duck identity exactly: a filtered participant-chosen
// name replaces the generic numbered label, and an unnamed duck falls back.
const liveDuckIdentity = (status) => {
  if (!status.duck) return "Waiting for duck assignment";
  return typeof status.duckName === "string" && status.duckName.length > 0
    ? status.duckName
    : "Duck #" + status.duck.visibleNumber;
};

const liveRaceFacts = (container, status, includeParticipant) => {
  if (!status) {
    container.append(liveText("p", "Race status is not currently public.", "muted"));
    return;
  }
  const facts = liveText("dl", "", "facts");
  if (includeParticipant) liveAddFact(facts, "Participant", status.participantDisplayName);
  liveAddFact(facts, "Duck", liveDuckIdentity(status));
  const assigned = status.assignedHeat.final || status.assignedHeat.roundOne;
  liveAddFact(facts, "Assigned heat", assigned
    ? (status.assignedHeat.final ? "Final" : "Round one") + " · Heat " + assigned.number
    : "Heat not assigned yet");
  liveAddFact(facts, "Race activity", status.currentHeat
    ? liveRoundLabel(status.currentHeat.round) + " · Heat " + status.currentHeat.number + " · " + liveHeatStatus(status.currentHeat.status)
    : "No heat is active right now");
  liveAddFact(facts, "Race status", liveHumanize(status.outcome));
  container.append(facts);
};

// A board entry links to the public duck detail view whenever it actually shows
// a duck number. Entries still waiting for a duck keep plain pending text.
//
const liveBoardDuckName = (entry) =>
  typeof entry.duckName === "string" && entry.duckName.length > 0 ? entry.duckName : null;

const liveBoardDuckCell = (entry) => {
  const cell = liveText("span", "");
  const link = duckDetailLink(document, entry.duckNumber, liveBoardDuckName(entry));
  if (link === null) cell.textContent = "Duck number pending";
  else cell.append(link);
  if (entry.place !== null) {
    cell.append(liveText("span", " · " + livePlaceLabel(entry.place) + " place"));
  }
  return cell;
};

// Mirrors the server-rendered duck detail facts exactly, so an authoritative
// refetch never rewrites the page into a different shape or wording.
const liveDuckDetailFacts = (container, status) => {
  if (!status) {
    container.append(liveText("p", "Race status is not currently public.", "muted"));
    return;
  }
  const facts = liveText("dl", "", "facts");
  liveAddFact(facts, "Participant", status.participantDisplayName);
  liveAddFact(facts, "Duck", liveDuckIdentity(status));
  liveAddFact(facts, "Round one heat", status.assignedHeat.roundOne
    ? "Heat " + status.assignedHeat.roundOne.number + " · " + duckHeatStatusLabel(status.assignedHeat.roundOne.status)
    : "Not assigned yet");
  liveAddFact(facts, "Final heat", status.assignedHeat.final
    ? "Heat " + status.assignedHeat.final.number + " · " + duckHeatStatusLabel(status.assignedHeat.final.status)
    : "Not in the final");
  liveAddFact(facts, "Currently running", status.currentHeat
    ? liveRoundLabel(status.currentHeat.round) + " · Heat " + status.currentHeat.number
      + " · " + duckHeatStatusLabel(status.currentHeat.status)
    : "No heat is running right now");
  liveAddFact(facts, "Race status", liveHumanize(status.outcome));
  const official = duckOfficialResult(status.outcome);
  if (official !== null) liveAddFact(facts, "Official result", official);
  container.append(facts);
};

const liveHeatCard = (heat, currentHeat) => {
  const isCurrent = currentHeat && currentHeat.round === heat.round && currentHeat.number === heat.number;
  const card = liveText("article", "", "board-heat" + (isCurrent ? " current" : ""));
  card.append(
    liveText("h4", liveRoundLabel(heat.round) + " · Heat " + heat.number),
    liveText("p", liveHeatStatus(heat.status), isCurrent ? "status-chip ready" : "status-chip"),
  );
  if (heat.roster.length === 0) {
    card.append(liveText("p", "Roster not posted yet.", "muted"));
  } else {
    for (const entry of heat.roster) {
      const row = liveText("p", "", "board-entry");
      const participant = liveText("span", "", "board-participant");
      participant.append(liveText("span", entry.participantDisplayName));
      if (entry.place === 1) participant.append(liveText("span", "Winner", "winner-ribbon"));
      row.append(participant, liveBoardDuckCell(entry));
      card.append(row);
    }
  }
  return card;
};

const liveRound = (label, heats, currentHeat) => {
  const section = liveText("section", "", "board-round");
  section.append(liveText("h3", label));
  const grid = liveText("div", "", "board-grid");
  for (const heat of heats) grid.append(liveHeatCard(heat, currentHeat));
  section.append(grid);
  return section;
};

const liveRenderBoard = (board) => {
  const version = JSON.stringify(board);
  if (version === liveBoardVersion) return;
  liveBoardVersion = version;
  liveBoardContent.replaceChildren();
  if (!board.event) {
    liveBoardStageChip.textContent = "No race scheduled";
    liveBoardTitle.textContent = "No race is live right now.";
    liveBoardSummary.textContent = "The board will be ready when registration opens for the next event.";
    liveBoardContent.append(liveText("p", "There are no race heats to show yet.", "empty-state"));
    return;
  }
  const event = board.event;
  const heatDetail = event.currentHeat
    ? liveRoundLabel(event.currentHeat.round) + " · Heat " + event.currentHeat.number
      + " · " + liveHeatStatus(event.currentHeat.status)
    : null;
  liveBoardStageChip.textContent = liveEventStage(event.status).label;
  liveBoardTitle.textContent = event.name;
  liveBoardSummary.textContent = liveStageSummary(
    event.status,
    heatDetail,
    event.roundOneHeats.length + event.finalHeats.length > 0,
  );
  // The finale. Only places the server actually published are drawn, in the
  // order it published them, so a final that produced fewer than three valid
  // places simply shows fewer winners and never invents one to fill a step.
  if (event.podium.length > 0) {
    const winners = liveText("section", "", "board-round winners");
    winners.append(liveText("h3", "Winners", "winners-title"));
    winners.append(liveText(
      "p",
      "The official finish of the final, straight from the finish line.",
      "winners-note",
    ));
    const places = liveText("ol", "", "podium");
    for (const entry of event.podium) {
      const medal = liveMedalName(entry.place);
      const place = liveText(
        "li",
        "",
        "podium-place" + (medal === null ? "" : " podium-" + medal.toLowerCase()),
      );
      // Decorative only: the same rank is spelled out in the text beside it.
      const disc = liveText("span", String(entry.place), "podium-medal");
      disc.setAttribute("aria-hidden", "true");
      const detail = liveText("span", "", "podium-detail");
      detail.append(
        liveText("span", medal === null
          ? liveOrdinal(entry.place) + " place"
          : medal + " medal · " + liveOrdinal(entry.place) + " place", "podium-rank"),
        liveText("strong", entry.participantDisplayName, "podium-name"),
      );
      const duck = liveText("span", "", "podium-duck");
      const link = duckDetailLink(document, entry.duckNumber, liveBoardDuckName(entry));
      if (link === null) duck.textContent = "Duck number pending";
      else duck.append(link);
      detail.append(duck);
      place.append(disc, detail);
      places.append(place);
    }
    winners.append(places);
    liveBoardContent.append(winners);
  }
  if (event.roundOneHeats.length > 0) liveBoardContent.append(liveRound("Round one", event.roundOneHeats, event.currentHeat));
  if (event.finalHeats.length > 0) liveBoardContent.append(liveRound("Final", event.finalHeats, event.currentHeat));
  if (event.roundOneHeats.length === 0 && event.finalHeats.length === 0) {
    liveBoardContent.append(liveText("p", "Participants can still use this page before heats are made.", "empty-state"));
  }
};

// The home page carries this compact summary instead of the full board: one
// stage chip and one current-heat line, with the detail a link away at /race.
const liveRenderSummary = (board) => {
  if (!liveSummaryRoot) return;
  const version = JSON.stringify(board);
  if (version === liveSummaryVersion) return;
  liveSummaryVersion = version;
  if (!board.event) {
    liveSummaryStage.textContent = "No race scheduled";
    liveSummaryTitle.textContent = "No race is live right now.";
    liveSummaryLine.textContent = "The next race will appear here when registration opens.";
    return;
  }
  const event = board.event;
  liveSummaryStage.textContent = liveEventStage(event.status).label;
  liveSummaryTitle.textContent = event.name;
  liveSummaryLine.textContent = event.currentHeat
    ? "Running now: " + liveRoundLabel(event.currentHeat.round) + " · Heat " + event.currentHeat.number
      + " · " + liveHeatStatus(event.currentHeat.status) + "."
    : liveEventStage(event.status).summary;
};

const liveFetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    const error = new Error("refresh failed");
    error.status = response.status;
    throw error;
  }
  return response.json();
};

// A public duck page's heading and document title are part of the same live
// view as its facts. Updating all three from the refetched status prevents an
// old generic label from surviving a prompt rename signal.
const liveUpdateDuckHeading = (status) => {
  const heading = document.querySelector("[data-duck-heading]");
  if (!heading || !status || !status.duck) return;
  const identity = liveDuckIdentity(status);
  heading.textContent = identity;
  document.title = identity + " · QuickDucks";
};

const liveRefreshPersonal = async () => {
  const personal = document.querySelector("[data-live-personal]");
  if (!personal) return;
  const pathParts = location.pathname.split("/");
  const token = pathParts.length === 3 ? pathParts[2] : "";
  if (!token) return;
  try {
    if (personal.dataset.livePersonal === "private") {
      const body = await liveFetchJson("/api/v1/registrations/" + encodeURIComponent(token));
      if (document.hidden) return;
      personal.replaceChildren();
      const facts = liveText("dl", "", "facts");
      liveAddFact(facts, "Participant", body.firstName + " " + body.lastName);
      liveAddFact(facts, "Registration", liveHumanize(body.status));
      liveAddFact(facts, "Race date", body.eventDate || "To be announced");
      personal.append(facts);
      liveRaceFacts(personal, body.raceStatus, false);
      const heading = document.querySelector("[data-private-status-heading]");
      const event = document.querySelector("[data-private-status-event]");
      if (heading) heading.textContent = body.status === "ACTIVE"
        ? "Your duck is assigned, " + body.firstName + "."
        : body.status === "WITHDRAWN"
          ? "Registration withdrawn, " + body.firstName + "."
          : body.status === "DISQUALIFIED"
            ? "Race status updated, " + body.firstName + "."
            : "You’re in the queue, " + body.firstName + ".";
      if (event) event.textContent = "Keep this page private. This is your status link for " + body.eventName + ".";
      return;
    }
    // The public duck detail view is addressed by the visible number, so its
    // authoritative refetch uses the number endpoint. A 404 is handled by the
    // shared catch below, which reloads into the friendly not-found page.
    if (personal.dataset.livePersonal === "number") {
      const body = await liveFetchJson("/api/v1/ducks/number/" + encodeURIComponent(token));
      if (document.hidden) return;
      personal.replaceChildren();
      liveDuckDetailFacts(personal, body.raceStatus);
      liveUpdateDuckHeading(body.raceStatus);
      return;
    }
    const body = await liveFetchJson("/api/v1/ducks/" + encodeURIComponent(token));
    if (document.hidden) return;
    personal.replaceChildren();
    if (body.destination === "RACE_STATUS") {
      liveRaceFacts(personal, body.raceStatus, true);
      liveUpdateDuckHeading(body.raceStatus);
    } else {
      document.querySelector("main")?.replaceChildren();
      location.replace("/");
    }
  } catch (error) {
    if (error.status === 404) {
      document.querySelector("main")?.replaceChildren();
      location.reload();
    }
    throw error;
  }
};

const liveRefreshWork = async () => {
  try {
    const board = await liveFetchJson("/api/v1/race-board");
    await Promise.allSettled([
      liveRefreshPersonal(),
    ]);
    if (document.hidden) return;
    if (liveBoardRoot) liveRenderBoard(board);
    liveRenderSummary(board);
    liveShowBoardError(null);
  } catch {
    liveShowBoardError("The race board could not be loaded. This page keeps trying automatically.");
  }
};
if (liveBoardRoot || liveSummaryRoot) {
  globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: liveBoardRoot || liveSummaryRoot,
    refresh: liveRefreshWork,
  });
}
`;

// `appConfirm` is defined once by `live-ui.js`, which every page loads first.
export const startLineScript = rosterEligibilityHelpersScript + stationStateHelpersScript + String.raw`
const startRoot = document.querySelector("[data-start-line]");
const startEvent = document.querySelector("[data-station-event]");
const startHeatTitle = document.querySelector("[data-station-heat]");
const startFacts = document.querySelector("[data-station-facts]");
const startRoster = document.querySelector("[data-station-roster]");
const startAction = document.querySelector("[data-station-action]");
const startMessage = document.querySelector("[data-station-message]");
let startRenderKey = null;
let startCommandBusy = false;
let startSubscription = null;

const startText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};
const startHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
const startApi = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The race could not be refreshed.");
  return body;
};
const startAddFact = (label, value) => {
  const fact = startText("div", "", "fact");
  fact.append(startText("dt", label), startText("dd", value));
  startFacts.append(fact);
};
const startCommand = async (path, revision) => {
  startCommandBusy = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    return await startApi(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), revision }),
    });
  } finally {
    startCommandBusy = false;
    endBusy();
    startSubscription?.resume();
  }
};
// This station already subscribes to the "participants" domain, so it is told
// when a racer on its locked roster leaves; the shared eligibility key is what
// stops that repaint from being discarded as an unchanged heat.
const startRender = (event, detail) => {
  const renderKey = stationHeatRenderKey(event, detail) + "|" + rosterEligibilityKey(detail.roster);
  if (renderKey === startRenderKey) return;
  startRenderKey = renderKey;
  const restoreActionFocus = startAction.contains(document.activeElement);
  startEvent.textContent = event.name + " · " + startHumanize(event.status);
  startHeatTitle.textContent = (detail.heat.round === "FINAL" ? "Final" : "Round one") + " · Heat " + detail.heat.number;
  startFacts.replaceChildren();
  startAddFact("Heat status", startHumanize(detail.heat.status));
  startAddFact("Roster count", detail.roster.length);
  startRoster.replaceChildren();
  for (const entry of detail.roster) {
    const item = startText("li", "Slot " + entry.slotNumber + " · " + entry.participant.firstName + " " + entry.participant.lastName
      + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · Duck not assigned"));
    // The bag still holds this duck, so the row stays where it is and says so.
    rosterMarkIneligible(item, entry, "Racer out", startText);
    startRoster.append(item);
  }
  if (detail.roster.length === 0) startRoster.append(startText("li", "This heat has no roster entries."));
  startAction.replaceChildren();
  // Rosters lock automatically when the round starts, so this station never
  // offers a lock action and a still-planned heat is simply waiting.
  const transition = {
    LOADING: ["ready", "Mark Heat Ready"],
    READY: ["call", "Heat Has Been Announced"],
    CALLING: ["start", "Start This Heat"],
  }[detail.heat.status];
  if (!transition) {
    startMessage.textContent = detail.heat.status === "PLANNED"
      ? "This roster locks by itself when the race director starts the round."
      : detail.heat.status === "AWAITING_RESULT"
      ? "This heat is awaiting its official result. No other heat may start until the finish line publishes it."
      : detail.heat.status === "RUNNING"
      ? "This heat is running. The finish line must mark it finished."
      : "The finish line is recording this heat. This station cannot finish races or enter results.";
    return;
  }
  const button = startText("button", transition[1], "button station-control");
  button.type = "button";
  button.addEventListener("click", async () => {
    if (transition[0] === "start") {
      const round = detail.heat.round === "FINAL" ? "Final" : "Round one";
      const readback = "Start " + round + " Heat " + detail.heat.number + " now? Read back: "
        + detail.roster.length + " racer" + (detail.roster.length === 1 ? "" : "s")
        + " in this heat. No next heat can start until its official result is published.";
      if (!await appConfirm(readback, { danger: true })) return;
    }
    button.disabled = true;
    startMessage.textContent = transition[1] + "…";
    try {
      await startCommand("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats/" + encodeURIComponent(detail.heat.id) + "/" + transition[0], detail.heat.revision);
      startMessage.textContent = "Saved. Loading the current heat.";
      await startLoad();
    } catch (error) {
      if (error.message !== "signed-out") startMessage.textContent = error.message;
      button.disabled = false;
    }
  });
  startAction.append(button);
  if (restoreActionFocus) button.focus();
  startMessage.textContent = "Review the roster, then use the one available legal action.";
};
const startEmpty = (message) => {
  startRenderKey = null;
  startEvent.textContent = message;
  startHeatTitle.textContent = "No heat needs the start line";
  startFacts.replaceChildren();
  startRoster.replaceChildren(startText("li", "The roster will appear when a heat is ready."));
  startAction.replaceChildren();
  startMessage.textContent = "This page will keep checking for the next heat.";
};
const startLoadWork = async () => {
  try {
    const events = await startApi("/api/v1/staff/events");
    if (document.hidden) return;
    const event = events.events.find((item) => ["ROUND_ONE", "FINAL"].includes(item.status));
    if (!event) {
      startEmpty("No race round is active right now.");
      return;
    }
    const listed = await startApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats");
    if (document.hidden) return;
    const heat = startPickHeat(listed.heats, event.status === "FINAL" ? "FINAL" : "ROUND_ONE");
    if (!heat) {
      startEmpty(event.name + " has no unfinished heat in this round.");
      return;
    }
    const detail = await startApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats/" + encodeURIComponent(heat.id));
    if (document.hidden) return;
    startRender(event, detail);
  } catch (error) {
    // The station message line remains the actionable operational error surface.
    if (error.message !== "signed-out") startMessage.textContent = error.message;
  }
};
const startLoad = startLoadWork;
if (startRoot) {
  startSubscription = globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: startRoot,
    refresh: startLoadWork,
    isBlocked: () => startCommandBusy,
  });
}
`;

// Pure wording and selection helpers for the announcer station, split out so the
// shipped decisions are exercised directly rather than through a copy of them.
export const announcerHelpersScript = String.raw`
// The announcer follows the race itself, so this station reads the event that is
// actually racing. A completed race still needs its podium read out, so it is
// the fallback rather than nothing.
const announcerPickEvent = (events) => (Array.isArray(events) ? events : []).find(
  (item) => item.status === "ROUND_ONE" || item.status === "FINAL",
) || (Array.isArray(events) ? events : []).find((item) => item.status === "COMPLETED") || null;
const announcerHeatLabel = (heat) => heat.round === "FINAL" ? "The final" : "Round one · Heat " + heat.number;
// One plain sentence telling the person holding the microphone what to do now.
const announcerCues = {
  PLANNED: "Coming up next. Read these racers out now.",
  LOADING: "Ducks are going in. Read these racers out now.",
  READY: "Ready to race. Announce these racers now.",
  CALLING: "Heat announced. Racers are heading to the water.",
  RUNNING: "Racing now. Call the race.",
  AWAITING_RESULT: "Finished. Hold for the official result from the finish line.",
};
const announcerCue = (status) => Object.prototype.hasOwnProperty.call(announcerCues, status)
  ? announcerCues[status]
  : "Waiting for this heat to be confirmed.";
const announcerPlaceLabel = (place) => place === 1 ? "First place"
  : place === 2 ? "Second place"
  : place === 3 ? "Third place"
  : "Place " + place;
const announcerDuckLine = (duckNumber) => typeof duckNumber === "number" && duckNumber > 0
  ? "Duck #" + duckNumber
  : "Duck not assigned";
// Announcers say the whole name, so both parts are always read out together.
const announcerFullName = (participant) => participant
  ? (String(participant.firstName || "") + " " + String(participant.lastName || "")).trim()
  : "";
`;

// The announcer holds a microphone, so this station is a read-only script. Every
// request it makes is a GET and it never sends a command, a revision, or a
// command ID: the start line and the finish line own every transition.
export const announcerScript = rosterEligibilityHelpersScript + stationStateHelpersScript + announcerHelpersScript + String.raw`
const announcerRoot = document.querySelector("[data-announcer]");
const announcerEventLine = document.querySelector("[data-station-event]");
const announcerHeatTitle = document.querySelector("[data-announcer-heat]");
const announcerCueLine = document.querySelector("[data-announcer-cue]");
const announcerRosterList = document.querySelector("[data-announcer-roster]");
const announcerPodium = document.querySelector("[data-announcer-podium]");
const announcerPodiumList = document.querySelector("[data-announcer-podium-list]");
const announcerProgress = document.querySelector("[data-announcer-progress]");
const announcerResultsList = document.querySelector("[data-announcer-results]");
const announcerResultsEmpty = document.querySelector("[data-announcer-results-empty]");
const announcerMessage = document.querySelector("[data-station-message]");
// A finalized heat only changes when a race director corrects it, which bumps
// the heat revision. Keying this cache on the revision and the published count
// means each decided heat is read once, a correction is picked up immediately,
// and a live signal never refetches the whole race.
const announcerResultCache = new Map();
let announcerRenderKey = null;

const announcerText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};
const announcerHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
const announcerApi = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body && body.error ? body.error : "The race could not be refreshed.");
  return body;
};
const announcerLine = (label, name, duckNumber, className) => {
  const item = document.createElement("li");
  if (className) item.className = className;
  item.append(
    announcerText("span", label, "announcer-label"),
    announcerText("strong", name, "announcer-name"),
    announcerText("span", announcerDuckLine(duckNumber), "announcer-duck"),
  );
  return item;
};
const announcerRenderCurrent = (event, current) => {
  if (!current) {
    announcerHeatTitle.textContent = "No heat is up right now";
    announcerCueLine.textContent = event.status === "COMPLETED"
      ? "Every heat has been decided. Read the official podium below."
      : "Nothing to read out yet. The next heat appears here on its own.";
    announcerRosterList.replaceChildren(announcerText("li", "The racers to announce will appear here."));
    return;
  }
  announcerHeatTitle.textContent = announcerHeatLabel(current.heat);
  announcerCueLine.textContent = announcerCue(current.heat.status);
  announcerRosterList.replaceChildren();
  for (const entry of current.roster) {
    const item = announcerLine("Slot " + entry.slotNumber, entry.displayName, entry.duckNumber);
    // Still on the roster because the duck is still in the bag and still races,
    // but this name must never be called as a winner.
    rosterMarkIneligible(item, entry, "Do not announce", announcerText);
    announcerRosterList.append(item);
  }
  if (current.roster.length === 0) {
    announcerRosterList.append(announcerText("li", "This heat has no racers on its roster yet."));
  }
};
const announcerRenderDecided = (decided) => {
  announcerResultsList.replaceChildren();
  announcerPodiumList.replaceChildren();
  let podium = false;
  for (const entry of decided) {
    const winner = entry.results.find((row) => row.place === 1);
    const heatLabel = announcerHeatLabel(entry.heat);
    announcerResultsList.append(winner
      ? announcerLine(
        heatLabel,
        "Winner: " + announcerFullName(winner.participant),
        winner.duck ? winner.duck.visibleNumber : null,
        entry.heat.round === "FINAL" ? "final-heat" : "",
      )
      : announcerText("li", heatLabel + " · Winner not recorded yet"));
    // The final is announced as a full podium, not just its winner.
    if (entry.heat.round !== "FINAL" || entry.results.length === 0) continue;
    for (const row of entry.results) {
      announcerPodiumList.append(announcerLine(
        announcerPlaceLabel(row.place),
        announcerFullName(row.participant),
        row.duck ? row.duck.visibleNumber : null,
        "podium-place",
      ));
    }
    podium = true;
  }
  announcerPodium.hidden = !podium;
  announcerResultsEmpty.hidden = decided.length > 0;
};
const announcerRender = (event, heats, current, decided) => {
  const renderKey = JSON.stringify([event.id, event.name, event.status, current, decided]);
  if (renderKey === announcerRenderKey) return;
  announcerRenderKey = renderKey;
  announcerEventLine.textContent = event.name + " · " + announcerHumanize(event.status);
  announcerRenderCurrent(event, current);
  announcerRenderDecided(decided);
  const raceable = heats.filter((heat) => heat.status !== "CANCELLED").length;
  announcerProgress.textContent = decided.length === 0
    ? "No heat has an official result yet."
    : decided.length + " of " + raceable + " heat" + (raceable === 1 ? "" : "s") + " decided.";
};
const announcerEmpty = (message) => {
  announcerRenderKey = null;
  announcerEventLine.textContent = message;
  announcerHeatTitle.textContent = "No heat is up yet";
  announcerCueLine.textContent = "The racers to announce will appear here.";
  announcerRosterList.replaceChildren(announcerText("li", "Waiting for the official roster."));
  announcerPodium.hidden = true;
  announcerPodiumList.replaceChildren();
  announcerResultsList.replaceChildren();
  announcerResultsEmpty.hidden = false;
  announcerProgress.textContent = "Waiting for the first official result.";
};
const announcerLoadWork = async () => {
  try {
    const events = await announcerApi("/api/v1/staff/events");
    if (document.hidden) return;
    const event = announcerPickEvent(events.events);
    if (!event) {
      announcerEmpty("No race is on the water right now.");
      return;
    }
    const eventPath = "/api/v1/staff/events/" + encodeURIComponent(event.id);
    const listed = await announcerApi(eventPath + "/heats");
    if (document.hidden) return;
    const upcoming = startPickHeat(listed.heats, event.status === "FINAL" ? "FINAL" : "ROUND_ONE");
    // The announcer roster projection is exactly slot, full name, and duck
    // number, which is exactly what gets said out loud and nothing more.
    const current = upcoming === null
      ? null
      : await announcerApi(eventPath + "/heats/" + encodeURIComponent(upcoming.id) + "/announcer-roster");
    if (document.hidden) return;
    const decided = [];
    for (const heat of listed.heats) {
      if (!(heat.publishedResultCount > 0)) continue;
      const key = heat.revision + ":" + heat.publishedResultCount;
      const cached = announcerResultCache.get(heat.id);
      if (cached && cached.key === key) {
        decided.push({ heat, results: cached.results });
        continue;
      }
      const detail = await announcerApi(eventPath + "/heats/" + encodeURIComponent(heat.id));
      const results = Array.isArray(detail.results) ? detail.results : [];
      announcerResultCache.set(heat.id, { key, results });
      decided.push({ heat, results });
    }
    if (document.hidden) return;
    announcerRender(event, listed.heats, current, decided);
    announcerMessage.textContent = "This station only reads. It never changes the race.";
  } catch (error) {
    // The station message line remains the actionable operational error surface.
    if (error.message !== "signed-out") announcerMessage.textContent = error.message;
  }
};
if (announcerRoot) {
  globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: announcerRoot,
    refresh: announcerLoadWork,
  });
}
`;

export const finishSelectionValidationScript = String.raw`
const finishSelectionProblem = (selected, roster, raceEntryId) => {
  if (selected.some((item) => item.raceEntryId === raceEntryId)) return "duplicate";
  if (!roster.some((entry) => entry.raceEntryId === raceEntryId)) return "wrong-heat";
  return null;
};
// A withdrawn or disqualified racer's duck was already in this heat's bag when
// they left the race, and nobody empties a bag on the bank to fish one duck out,
// so it is still in the water and can still cross the line first. That is an
// expected race-day outcome, not a failure: name the duck, name its real status,
// and send the staffer straight back to scanning.
//
// Only the two statuses that mean "this racer left the race" are named, mirroring
// the server. Any other status still cannot be recorded — every result path
// requires ACTIVE — but announcing it as, say, "Submitted" would put a word in
// front of a staffer that describes something else entirely, so the headline
// drops the claim rather than inventing one.
const finishIneligibleStatusLabel = (status) => status === "WITHDRAWN"
  ? "Withdrawn"
  : status === "DISQUALIFIED"
    ? "Disqualified"
    : null;
const finishIneligibleLines = (duck) => {
  if (!duck) {
    return [
      "That duck cannot be recorded",
      "Scan the next duck to pass the finish line.",
    ];
  }
  const label = finishIneligibleStatusLabel(duck.registrationStatus);
  return [
    label === null
      ? "Duck #" + duck.visibleNumber + " cannot be recorded"
      : "Duck #" + duck.visibleNumber + " is " + label,
    duck.participantDisplayName + " cannot be recorded as a winner, and this duck stays in its heat.",
    "Scan the next duck to pass the finish line.",
  ];
};
`;

export const finishScanSerializationScript = String.raw`
const finishSameScanContext = (left, right) => Boolean(left && right
  && left.eventId === right.eventId
  && left.heatId === right.heatId
  && left.revision === right.revision
  && left.intendedPlace === right.intendedPlace);
const finishCreateSerializedSelector = ({ readContext, setBusy, lookup, accept, stale }) => {
  let inFlight = false;
  return async (value) => {
    if (inFlight) return { accepted: false, reason: "busy" };
    const captured = readContext();
    if (!captured) return { accepted: false, reason: "unavailable" };
    inFlight = true;
    setBusy(true);
    try {
      const selection = await lookup(value, captured);
      if (!finishSameScanContext(captured, readContext())) {
        stale();
        return { accepted: false, reason: "stale" };
      }
      const accepted = await accept(selection, captured);
      if (accepted === false) return { accepted: false, reason: "rejected" };
      return { accepted: true, place: captured.intendedPlace };
    } finally {
      inFlight = false;
      setBusy(false);
    }
  };
};
`;

export const finishNfcHelpersScript = String.raw`
const finishCreateNfcScanner = ({ createReader, createController, decode, onValue, onUnsupported, onReadingError, onStartError, setActive }) => {
  let active = false;
  return async () => {
    if (active) return false;
    active = true;
    setActive(true);
    const reader = createReader();
    const controller = createController();
    let settled = false;
    const cleanup = () => {
      reader.removeEventListener("reading", handleReading);
      reader.removeEventListener("readingerror", handleReadingError);
      controller.abort();
      active = false;
      setActive(false);
    };
    const handleReading = async (event) => {
      if (settled) return;
      settled = true;
      const record = event.message.records.find((item) => item.recordType === "url" || item.recordType === "text");
      if (!record) {
        onUnsupported();
        cleanup();
        return;
      }
      try {
        await onValue(decode(record));
      } finally {
        cleanup();
      }
    };
    const handleReadingError = () => {
      if (settled) return;
      settled = true;
      onReadingError();
      cleanup();
    };
    reader.addEventListener("reading", handleReading);
    reader.addEventListener("readingerror", handleReadingError);
    try {
      await reader.scan({ signal: controller.signal });
      return true;
    } catch (error) {
      if (!settled) {
        settled = true;
        onStartError(error);
        cleanup();
      }
      return false;
    }
  };
};
`;

export const finishLineScript = rosterEligibilityHelpersScript + stationStateHelpersScript
  + podiumPlaceHelpersScript
  + finishSelectionValidationScript + finishScanSerializationScript
  + finishNfcHelpersScript + String.raw`
const finishRoot = document.querySelector("[data-finish-line]");
const finishEventLabel = document.querySelector("[data-station-event]");
const finishHeatTitle = document.querySelector("[data-station-heat]");
const finishFacts = document.querySelector("[data-station-facts]");
const finishRoster = document.querySelector("[data-station-roster]");
const finishAction = document.querySelector("[data-finish-action]");
const finishScanForm = document.querySelector("[data-finish-scan-form]");
const finishSelections = document.querySelector("[data-finish-selections]");
const finishSubmit = document.querySelector("[data-submit-result]");
const finishMessage = document.querySelector("[data-station-message]");
const finishNfcButton = document.querySelector("[data-start-nfc]");
const finishIneligible = document.querySelector("[data-finish-ineligible]");
let finishEvent = null;
let finishHeat = null;
let finishRosterEntries = [];
let finishSelected = [];
// The podium the server is holding for this final, built by staff scanning each
// finishing duck's tag and choosing its place on the duck's own inspection page.
// It is authoritative and shared; the finishSelected list above is this one
// station's unsubmitted working list and is not.
let finishPodium = null;
let finishRenderKey = null;
let finishScanBusy = false;
let finishScanEndBusy = null;
let finishCommandBusy = false;
let finishSubscription = null;

const finishText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};
const finishHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
// One set of words for the three podium places, shared with the duck inspection
// page where a place is actually chosen.
const finishPlaceLabel = (place) => podiumPlaceLabel(place);
// A final whose podium is being built by tag scans. The moment one place has
// been scanned, this station stops offering its own way to assemble a podium:
// two half-built podiums on two screens, only one of which the server would
// accept, is the ambiguity this flag exists to prevent. Clearing every scanned
// place hands the station back its form.
const finishPodiumScanned = () => finishHeat !== null && finishHeat.round === "FINAL"
  && podiumTakenPlacements(finishPodium).length > 0;
const finishApi = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname + location.search));
    throw new Error("signed-out");
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const failure = new Error(body && body.error ? body.error : "The race could not be refreshed.");
    failure.status = response.status;
    // The server distinguishes "this duck's racer is withdrawn or disqualified"
    // from a genuine failure with one stable reason, so the station can present
    // that as the expected race-day outcome it is rather than as an error.
    failure.reason = body && typeof body.reason === "string" ? body.reason : null;
    failure.ineligible = body && body.ineligible ? body.ineligible : null;
    failure.ineligibleRaceEntryIds = body && Array.isArray(body.ineligibleRaceEntryIds)
      ? body.ineligibleRaceEntryIds
      : [];
    throw failure;
  }
  return body;
};
const FINISH_DUCK_NOT_ELIGIBLE = "DUCK_NOT_ELIGIBLE";
const finishClearIneligible = () => {
  if (!finishIneligible) return;
  finishIneligible.replaceChildren();
  finishIneligible.hidden = true;
};
// Nothing here disarms the scanner, clears the heat, or leaves a state that has
// to be dismissed: the station is immediately ready for the next duck.
const finishShowIneligible = (failure) => {
  if (!finishIneligible) return;
  const [headline, ...rest] = finishIneligibleLines(failure.ineligible);
  // Reveal the live region before writing into it, so the announcement is a
  // change inside a region that is already in the accessibility tree.
  finishIneligible.hidden = false;
  finishIneligible.replaceChildren(finishText("strong", headline));
  for (const line of rest) finishIneligible.append(finishText("p", line));
  finishMessage.textContent = "Scan the next duck to pass the finish line.";
};
const finishAddFact = (label, value) => {
  const fact = finishText("div", "", "fact");
  fact.append(finishText("dt", label), finishText("dd", value));
  finishFacts.append(fact);
};
// The podium is exactly as deep as the racers who can still take a place, which
// is the number the server's own result validation requires. Sizing it from the
// whole roster instead demands a place no duck may ever fill: the third duck
// answers every scan with DUCK_NOT_ELIGIBLE, Submit never enables, the final
// can never be published, and the event is stranded with no way out.
// Round one is counted the same way as the final, one place deep instead of
// three. Hard-coding it to 1 made the count a claim about the round rather than
// about the racers, so a round-one heat everybody left still reported one
// fillable place: the zero guard below could never fire for it, and the station
// sent the staffer to scan a bag in which every single duck answers
// DUCK_NOT_ELIGIBLE, with nothing on screen saying why or how to get out.
const finishEligibleEntries = () => rosterEligibleEntries(finishRosterEntries);
const finishRequiredPlaces = () => !finishHeat
  ? 0
  : Math.min(finishHeat.round === "ROUND_ONE" ? 1 : 3, finishEligibleEntries().length);
// Zero required places means every racer in this heat left, so there is no
// result to submit at all. That is deliberately not the same as "the selections
// happen to match", which is why it is tested for on its own rather than being
// left to a 0 === 0 comparison that would arm an empty, always-refused submit.
//
// One sentence, said identically wherever the station has to say it, because a
// staffer who reads it at the scan field and again on the message line must not
// have to work out whether they are two different problems. It leads with the
// fact, states that the ducks do not move, and names the only remedy there is:
// only a race director can reactivate a racer, and nothing the finish line can
// do will make this heat publishable until one does.
const FINISH_NO_ELIGIBLE_MESSAGE = "Nobody in this heat can win:"
  + " every racer in it is withdrawn or disqualified, so no result can be recorded."
  + " Every duck stays in its bag."
  + " Ask the race director to reactivate a racer, then this station can take the result.";
const finishSubmitBlocked = (busy) => {
  const required = finishRequiredPlaces();
  return busy || finishHeat === null || finishHeat.status !== "AWAITING_RESULT"
    || required === 0 || finishSelected.length !== required
    // A podium is being built by scans, so this station's own submit is not the
    // thing that publishes it. Hidden already; disabled as well, because hidden
    // is a paint and this is the guard.
    || finishPodiumScanned();
};
const finishSetScanBusy = (busy) => {
  finishScanBusy = busy;
  if (busy && finishScanEndBusy === null) finishScanEndBusy = globalThis.quickDucksLive.beginBusy();
  if (!busy && finishScanEndBusy !== null) {
    finishScanEndBusy();
    finishScanEndBusy = null;
    finishSubscription?.resume();
  }
  for (const control of finishScanForm.querySelectorAll("input, button")) control.disabled = busy;
  finishNfcButton.disabled = busy;
  for (const control of finishSelections.querySelectorAll("button")) control.disabled = busy;
  finishSubmit.disabled = finishSubmitBlocked(busy);
};
// Take one scanned duck back off the podium. The place reopens immediately and
// the next scan of the duck that actually finished there can take it.
const finishClearPodiumPlace = async (placement, button) => {
  if (!finishEvent || !finishHeat) return;
  const label = finishPlaceLabel(placement.place);
  if (!await appConfirm(
    "Clear " + label + " from Duck #" + placement.visibleNumber + "? That place goes back to being open"
      + " for the next duck scanned.",
    { danger: true, confirmLabel: "Clear " + label },
  )) return;
  button.disabled = true;
  finishCommandBusy = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  finishMessage.textContent = "Clearing " + label + "…";
  try {
    await finishApi("/api/v1/staff/events/" + encodeURIComponent(finishEvent.id)
      + "/heats/" + encodeURIComponent(finishHeat.id) + "/podium-place/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        raceEntryId: placement.raceEntryId,
        place: placement.place,
      }),
    });
    await finishLoad();
    finishMessage.textContent = label + " is open again. Scan the duck that finished there.";
  } catch (error) {
    if (error.message !== "signed-out") {
      button.disabled = false;
      finishMessage.textContent = error.message;
    }
  } finally {
    finishCommandBusy = false;
    endBusy();
    finishSubscription?.resume();
  }
};

// The podium the scans have built, with the way back off each place. Removing is
// here rather than only on the duck page because this is the screen where the
// mistake is visible: the staffer reads the three places back and sees that two
// of them are swapped, without the ducks in their hands.
// Publish a podium that is already as deep as the final requires but was never
// finished by a scan. Only reachable when a finalist left after enough places
// were recorded, which shrank the podium underneath them; the scan that would
// normally publish is never coming, because every duck still unscanned belongs
// to a racer the result paths refuse.
const finishPublishScannedPodium = async (button) => {
  const placements = podiumTakenPlacements(finishPodium);
  const readback = placements.map((placement) => finishPlaceLabel(placement.place) + ": Duck #"
    + placement.visibleNumber).join(", ");
  if (!await appConfirm(
    "Publish this podium now? Read back: " + readback + ". This publishes immediately.",
    { danger: true, confirmLabel: "Publish podium" },
  )) return;
  button.disabled = true;
  finishCommandBusy = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  finishMessage.textContent = "Publishing the official podium…";
  try {
    await finishApi("/api/v1/staff/events/" + encodeURIComponent(finishEvent.id)
      + "/heats/" + encodeURIComponent(finishHeat.id) + "/results/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        revision: finishHeat.revision,
        results: placements.map((placement) => ({ raceEntryId: placement.raceEntryId, place: placement.place })),
      }),
    });
    await finishLoad();
    finishMessage.textContent = "Official podium saved. Live race screens have been notified.";
  } catch (error) {
    if (error.message !== "signed-out") {
      button.disabled = false;
      finishMessage.textContent = error.message;
    }
  } finally {
    finishCommandBusy = false;
    endBusy();
    finishSubscription?.resume();
  }
};

const finishRenderScannedPodium = (focusedRaceEntry) => {
  const placements = podiumTakenPlacements(finishPodium);
  const required = finishRequiredPlaces();
  finishSelections.append(finishText("p", "Scanned podium · " + placements.length + " of " + required
    + " place" + (required === 1 ? "" : "s") + " recorded", "muted"));
  for (const placement of placements) {
    const card = finishText("article", "", "station-selection");
    card.append(
      finishText("strong", finishPlaceLabel(placement.place)),
      finishText("p", placement.participantDisplayName + " · Duck #" + placement.visibleNumber),
    );
    const remove = finishText("button", "Clear " + finishPlaceLabel(placement.place), "button secondary small");
    remove.type = "button";
    remove.dataset.raceEntryId = placement.raceEntryId;
    remove.dataset.podiumClear = String(placement.place);
    remove.disabled = finishScanBusy || finishCommandBusy;
    remove.addEventListener("click", () => finishClearPodiumPlace(placement, remove));
    card.append(remove);
    finishSelections.append(card);
    if (focusedRaceEntry === placement.raceEntryId) remove.focus();
  }
  if (finishPodium && finishPodium.complete === true && finishHeat && finishHeat.status === "AWAITING_RESULT") {
    const publish = finishText("button", "Publish official podium", "button station-control");
    publish.type = "button";
    publish.dataset.publishPodium = "true";
    publish.disabled = finishScanBusy || finishCommandBusy;
    publish.addEventListener("click", () => finishPublishScannedPodium(publish));
    finishSelections.append(publish);
  }
};
const finishRenderSelections = () => {
  const focusedRaceEntry = finishSelections.contains(document.activeElement)
    ? document.activeElement.dataset.raceEntryId
    : null;
  finishSelections.replaceChildren();
  if (finishPodiumScanned()) {
    finishRenderScannedPodium(focusedRaceEntry);
    return;
  }
  for (const selection of finishSelected) {
    const card = finishText("article", "", "station-selection");
    card.append(
      finishText("strong", finishPlaceLabel(selection.place)),
      finishText("p", selection.participantDisplayName + " · Duck #" + selection.visibleNumber),
    );
    const remove = finishText("button", "Remove", "button secondary small");
    remove.type = "button";
    remove.dataset.raceEntryId = selection.raceEntryId;
    remove.disabled = finishScanBusy;
    remove.addEventListener("click", () => {
      finishSelected = finishSelected.filter((item) => item.raceEntryId !== selection.raceEntryId)
        .map((item, index) => ({ ...item, place: index + 1 }));
      finishRenderSelections();
      finishMessage.textContent = "Selection removed. Scan or enter the correct duck.";
      finishSubscription?.resume();
    });
    card.append(remove);
    finishSelections.append(card);
    if (focusedRaceEntry === selection.raceEntryId) remove.focus();
  }
  finishSubmit.disabled = finishSubmitBlocked(finishScanBusy);
  finishSubmit.textContent = finishHeat && finishHeat.round === "FINAL" ? "Submit official podium" : "Submit official winner";
};
const finishSelectionContext = () => {
  if (
    !finishEvent || !finishHeat || finishHeat.status !== "AWAITING_RESULT"
    || finishSelected.length >= finishRequiredPlaces()
  ) return null;
  return {
    eventId: finishEvent.id,
    heatId: finishHeat.id,
    revision: finishHeat.revision,
    intendedPlace: finishSelected.length + 1,
  };
};
const finishRunSerializedSelection = finishCreateSerializedSelector({
  readContext: finishSelectionContext,
  setBusy: finishSetScanBusy,
  lookup: async (value, captured) => {
    finishMessage.textContent = "Checking this duck against the official heat roster…";
    const parameters = new URLSearchParams({ value: String(value).trim() });
    const body = await finishApi("/api/v1/staff/events/" + encodeURIComponent(captured.eventId)
      + "/heats/" + encodeURIComponent(captured.heatId) + "/finish-scan?" + parameters);
    return body.selection;
  },
  accept: async (selection, captured) => {
    const selectionProblem = finishSelectionProblem(finishSelected, finishRosterEntries, selection.raceEntryId);
    if (selectionProblem === "duplicate") {
      finishMessage.textContent = "That duck is already selected. Each place must be a different duck.";
      return false;
    }
    if (selectionProblem === "wrong-heat") {
      finishMessage.textContent = "That duck is not in the selected heat.";
      return false;
    }
    finishSelected.push({ ...selection, place: captured.intendedPlace });
    finishClearIneligible();
    finishRenderSelections();
    finishScanForm.elements.duck.value = "";
    globalThis.quickDucksLive.markClean(finishScanForm);
    finishMessage.textContent = selection.participantDisplayName + " · Duck #" + selection.visibleNumber
      + " selected for " + finishPlaceLabel(captured.intendedPlace) + ". Review before submitting.";
    return true;
  },
  stale: () => {
    finishMessage.textContent = "The heat changed while that duck was checked. Review the displayed heat and scan it again.";
  },
});
const finishSelectValue = async (value) => {
  if (!finishEvent || !finishHeat || finishHeat.status !== "AWAITING_RESULT") {
    finishMessage.textContent = "Mark the running heat finished before selecting results.";
    return;
  }
  if (finishRequiredPlaces() === 0) {
    finishMessage.textContent = FINISH_NO_ELIGIBLE_MESSAGE;
    return;
  }
  if (finishSelected.length >= finishRequiredPlaces()) {
    finishMessage.textContent = "Every required place is filled. Remove a selection to change it.";
    return;
  }
  try {
    return await finishRunSerializedSelection(value);
  } catch (error) {
    if (error.message === "signed-out") return;
    // Expected outcome, not a failure: the station keeps its heat, keeps the
    // scan form and the NFC button enabled, and is ready for the next duck the
    // moment this returns.
    if (error.reason === FINISH_DUCK_NOT_ELIGIBLE) {
      finishShowIneligible(error);
      return;
    }
    finishMessage.textContent = error.message;
  }
};
const finishRender = (event, detail) => {
  // Eligibility is part of the key, not just the heat: a racer who withdraws
  // during AWAITING_RESULT changes neither the heat's status nor its revision,
  // yet it changes both the marker this roster must show and how many places
  // this station requires. Without it the repaint is discarded and the station
  // keeps asking for a place that can never be filled.
  //
  // The scanned podium joins the key for the same reason. Every recorded place
  // does move the heat revision, so this is belt-and-braces there, but a station
  // that showed a stale podium would offer a Clear button for a place another
  // staffer already cleared, which is the one control here that must never be
  // wrong about what it is undoing.
  const renderKey = stationHeatRenderKey(event, detail) + "|" + rosterEligibilityKey(detail.roster)
    + "|" + podiumTakenPlacements(detail.podium).map((placement) => placement.place + ":" + placement.raceEntryId).join(",");
  if (renderKey === finishRenderKey) return;
  const changedHeatContext = !finishHeat
    || finishHeat.id !== detail.heat.id
    || finishHeat.revision !== detail.heat.revision
    || finishHeat.status !== detail.heat.status;
  const restoreActionFocus = finishAction.contains(document.activeElement);
  finishRenderKey = renderKey;
  finishEvent = event;
  finishHeat = detail.heat;
  finishRosterEntries = detail.roster;
  finishPodium = detail.podium || null;
  if (changedHeatContext) {
    finishSelected = [];
    finishClearIneligible();
  }
  // A reviewed selection survives a repaint only while it is still a duck this
  // heat may award a place to. A racer who left between the scan and the submit
  // is dropped here for the same reason the submit response drops them, and the
  // remaining places close up rather than leaving a gap the server would refuse.
  else finishSelected = finishSelected
    .filter((selection) => finishRosterEntries.some((entry) => entry.raceEntryId === selection.raceEntryId
      && rosterEntryEligible(entry)))
    .map((selection, index) => ({ ...selection, place: index + 1 }));
  finishEventLabel.textContent = event.name + " · " + finishHumanize(event.status);
  finishHeatTitle.textContent = (finishHeat.round === "FINAL" ? "Final" : "Round one") + " · Heat " + finishHeat.number;
  finishFacts.replaceChildren();
  finishAddFact("Heat status", finishHumanize(finishHeat.status));
  // The fact line reports the same count the submit path enforces. A round-one
  // heat nobody can win is not "one winner" waiting to be scanned, and saying so
  // is what stops a staffer working through the whole bag to find it.
  finishAddFact("Required result", finishRequiredPlaces() === 0
    ? (finishHeat.round === "ROUND_ONE" ? "No racer can win" : "0 podium places")
    : finishHeat.round === "ROUND_ONE" ? "One winner" : finishRequiredPlaces() + " podium places");
  finishRoster.replaceChildren();
  for (const entry of finishRosterEntries) {
    const item = finishText("li", "Slot " + entry.slotNumber + " · " + entry.participant.firstName + " " + entry.participant.lastName
      + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · Duck not assigned"));
    // This is the roster a staffer reads to decide who won, so it is the last
    // place that may leave a racer who cannot win looking like one who can. The
    // row keeps its slot: the duck is still in the bag and still in the water.
    rosterMarkIneligible(item, entry, "Cannot win", finishText);
    finishRoster.append(item);
  }
  finishAction.replaceChildren();
  const finalPodiumFlow = finishHeat.round === "FINAL";
  // Once a place has been scanned, the podium belongs to the scans. This
  // station keeps showing it and keeps the way to undo a place, but it stops
  // offering a second, unsubmitted podium of its own that the server would only
  // reject.
  const scannedPodium = finishPodiumScanned();
  const awaiting = finishHeat.status === "AWAITING_RESULT";
  finishScanForm.hidden = !awaiting || !finalPodiumFlow || scannedPodium;
  finishSelections.hidden = !awaiting || !finalPodiumFlow;
  finishSubmit.hidden = !awaiting || !finalPodiumFlow || scannedPodium;
  if (scannedPodium) finishSelected = [];
  if (finishHeat.status === "RUNNING") {
    const button = finishText("button", "Mark heat finished", "button station-control");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      finishCommandBusy = true;
      const endBusy = globalThis.quickDucksLive.beginBusy();
      finishMessage.textContent = "Marking the heat finished…";
      try {
        await finishApi("/api/v1/staff/events/" + encodeURIComponent(finishEvent.id) + "/heats/" + encodeURIComponent(finishHeat.id) + "/finish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: crypto.randomUUID(), revision: finishHeat.revision }),
        });
        await finishLoad();
        // The repaint just decided what this heat can produce, so the
        // confirmation must not talk over it: telling somebody to go and scan
        // the winning duck of a heat that has no eligible racer is exactly the
        // dead end this station is meant to close.
        finishMessage.textContent = finishRequiredPlaces() === 0
          ? FINISH_NO_ELIGIBLE_MESSAGE
          : finishHeat.round === "ROUND_ONE"
            ? "Heat finished. Scan the winning duck's permanent NFC or QR tag to open its inspection page."
            : "Heat finished. Scan each finishing duck's tag and choose its place, or select every place here"
              + " and submit once.";
      } catch (error) {
        if (error.message !== "signed-out") finishMessage.textContent = error.message;
        button.disabled = false;
      } finally {
        finishCommandBusy = false;
        endBusy();
        finishSubscription?.resume();
      }
    });
    finishAction.append(button);
    if (restoreActionFocus) button.focus();
    // The finish button stays: those ducks are physically on the water and the
    // heat still has to be marked finished. What changes is that the staffer is
    // told now, rather than after they have finished the heat and started
    // scanning, that this heat has no winner to find.
    finishMessage.textContent = finishRequiredPlaces() === 0
      ? "When the race physically finishes, press the one finish button. " + FINISH_NO_ELIGIBLE_MESSAGE
      : "When the race physically finishes, press the one finish button.";
  } else if (finishRequiredPlaces() === 0) {
    // Every racer in this heat left. There is no winner and no podium to take,
    // so say that instead of asking for zero ducks and leaving a dead Submit on
    // screen — and, in round one, instead of sending the staffer to scan a bag
    // in which every duck is refused.
    //
    // This is checked before the round, not after it: round one publishes
    // through the tag-scan flow rather than through this form, so a round-one
    // branch above this one hides the only sentence that explains the dead end
    // from the only staffer standing in it.
    finishMessage.textContent = FINISH_NO_ELIGIBLE_MESSAGE;
  } else if (finishHeat.round === "ROUND_ONE") {
    finishMessage.textContent = "Scan the winning duck's permanent NFC or QR tag. Its inspection page will offer Mark Duck as Heat " + finishHeat.number + " Winner.";
  } else if (scannedPodium) {
    const remaining = finishRequiredPlaces() - podiumTakenPlacements(finishPodium).length;
    finishMessage.textContent = remaining <= 0
      ? "Every place this final needs is recorded. Publish the podium to make it official."
      : "Scan the next finishing duck's tag and choose its place. " + remaining + " place"
        + (remaining === 1 ? "" : "s") + " still to record.";
  } else {
    finishMessage.textContent = "Scan each finishing duck's permanent NFC or QR tag and choose its place on the"
      + " duck's page, or select " + finishRequiredPlaces() + " distinct duck"
      + (finishRequiredPlaces() === 1 ? "" : "s") + " here and review every place before submitting.";
  }
  finishRenderSelections();
};
const finishEmpty = (message) => {
  const emptyKey = "empty:" + message;
  if (finishRenderKey === emptyKey) return;
  finishRenderKey = emptyKey;
  finishEvent = null;
  finishHeat = null;
  finishRosterEntries = [];
  finishSelected = [];
  finishPodium = null;
  finishEventLabel.textContent = message;
  finishHeatTitle.textContent = "No heat needs the finish line";
  finishFacts.replaceChildren();
  finishRoster.replaceChildren(finishText("li", "A running or just-finished heat will appear here."));
  finishAction.replaceChildren();
  finishClearIneligible();
  finishScanForm.hidden = true;
  finishSelections.hidden = true;
  finishSubmit.hidden = true;
  finishRenderSelections();
  finishMessage.textContent = "This station will keep checking for a running heat.";
};
const finishLoadWork = async () => {
  try {
    const events = await finishApi("/api/v1/staff/events");
    if (document.hidden) return;
    const event = events.events.find((item) => ["ROUND_ONE", "FINAL"].includes(item.status));
    if (!event) {
      finishEmpty("No race round is active right now.");
      return;
    }
    const listed = await finishApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats");
    if (document.hidden) return;
    const round = event.status === "FINAL" ? "FINAL" : "ROUND_ONE";
    const heat = finishPickHeat(listed.heats, round);
    if (!heat) {
      finishEmpty(event.name + " has no running heat or result waiting.");
      return;
    }
    const detail = await finishApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats/" + encodeURIComponent(heat.id));
    if (document.hidden) return;
    finishRender(event, detail);
  } catch (error) {
    // The station message line remains the actionable operational error surface.
    if (error.message !== "signed-out") finishMessage.textContent = error.message;
  }
};
const finishLoad = finishLoadWork;
finishScanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await finishSelectValue(finishScanForm.elements.duck.value);
});
finishSubmit.addEventListener("click", async () => {
  if (!finishEvent || !finishHeat || finishScanBusy || finishRequiredPlaces() === 0 || finishSelected.length !== finishRequiredPlaces()) return;
  const readback = finishSelected.map((selection) => finishPlaceLabel(selection.place) + ": "
    + selection.participantDisplayName + ", Duck #" + selection.visibleNumber).join("; ");
  if (!await appConfirm("Submit this official result now? Read back: " + readback + ". This publishes immediately.", { danger: true })) return;
  const captured = {
    eventId: finishEvent.id,
    heatId: finishHeat.id,
    revision: finishHeat.revision,
    results: finishSelected.map((selection) => ({ raceEntryId: selection.raceEntryId, place: selection.place })),
  };
  finishSubmit.disabled = true;
  finishCommandBusy = true;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  finishMessage.textContent = "Submitting the reviewed official result…";
  try {
    await finishApi("/api/v1/staff/events/" + encodeURIComponent(captured.eventId) + "/heats/" + encodeURIComponent(captured.heatId) + "/results/finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        revision: captured.revision,
        results: captured.results,
      }),
    });
    finishSelected = [];
    finishClearIneligible();
    await finishLoad();
    finishMessage.textContent = "Official result saved. The station has moved to the next available heat.";
  } catch (error) {
    if (error.message === "signed-out") {
      // The redirect owns this page now.
    } else if (error.reason === FINISH_DUCK_NOT_ELIGIBLE) {
      // Someone was withdrawn between selecting their duck and submitting.
      // Drop exactly those selections, renumber the rest, and stay armed.
      const dropped = error.ineligibleRaceEntryIds;
      finishSelected = finishSelected
        .filter((selection) => !dropped.includes(selection.raceEntryId))
        .map((selection, index) => ({ ...selection, place: index + 1 }));
      finishShowIneligible(error);
    } else {
      finishMessage.textContent = error.message;
    }
    // Recomputes the submit state from what is actually selected now, so a
    // dropped selection cannot leave an armed submit behind.
    finishRenderSelections();
  } finally {
    finishCommandBusy = false;
    endBusy();
    finishSubscription?.resume();
  }
});
if ("NDEFReader" in globalThis) {
  finishNfcButton.hidden = false;
  const finishStartNfcScan = finishCreateNfcScanner({
    createReader: () => new NDEFReader(),
    createController: () => new AbortController(),
    decode: (record) => new TextDecoder(record.encoding || "utf-8").decode(record.data),
    onValue: finishSelectValue,
    onUnsupported: () => {
      finishMessage.textContent = "That NFC tag did not contain a QuickDucks URL. Try scanning again or enter the duck number.";
    },
    onReadingError: () => {
      finishMessage.textContent = "That NFC tag could not be read. Try scanning again or enter the duck number.";
    },
    onStartError: () => {
      finishMessage.textContent = "NFC scanning could not start. Paste the tag URL or enter the duck number instead.";
    },
    setActive: (active) => {
      finishNfcButton.disabled = active || finishScanBusy;
      if (active) finishMessage.textContent = "Hold one duck tag near this device.";
    },
  });
  finishNfcButton.addEventListener("click", finishStartNfcScan);
}
if (finishRoot) {
  finishSubscription = globalThis.quickDucksLive.subscribe({
    domains: ["event", "participants", "ducks", "heats"],
    root: finishRoot,
    refresh: finishLoadWork,
    // A changed heat revision clears reviewed selections in finishRender. Do not
    // block that authoritative refresh, especially when a director resets it.
    isBlocked: () => finishScanBusy || finishCommandBusy,
  });
}
`;

export const inventoryIntakeHelpersScript = String.raw`
// Scanning ducks in stays available once racing starts. Deleting a duck mid-race
// puts its participant back in the pairing queue, and a race with no spare duck
// in inventory would otherwise have no way to finish. Only a race that is over,
// or no race at all, closes intake.
const intakeOpenStatuses = new Set([
  "DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL",
]);

const intakeProvisioningRuntimeIssue = ({ userAgent, hasNdefReader, secureContext, topLevel, visible }) => {
  if (
    typeof userAgent !== "string" || !/\bAndroid\b/i.test(userAgent)
    || !/\bChrome\/\d+(?:\.\d+)*/.test(userAgent)
    || /\b(?:EdgA|OPR|SamsungBrowser)\//.test(userAgent)
    || /;\s*wv\)/i.test(userAgent)
  ) return "android-chrome";
  if (!hasNdefReader) return "web-nfc";
  if (!secureContext) return "secure-context";
  if (!topLevel) return "top-level";
  if (!visible) return "visible";
  return null;
};

const intakeParseCanonicalTagUrl = (value, appOrigin) => {
  if (typeof value !== "string") return null;
  try {
    const configured = new URL(appOrigin);
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/t\/([A-Za-z0-9_-]{22,128})$/);
    if (
      configured.pathname !== "/" || configured.search || configured.hash
      || parsed.origin !== configured.origin || parsed.username || parsed.password
      || parsed.search || parsed.hash || match === null
      || value !== configured.origin + "/t/" + match[1]
    ) return null;
    return value;
  } catch {
    return null;
  }
};

const intakeCanonicalUrlsFromMessage = (message, appOrigin, decode) => {
  if (!message || !message.records) return [];
  const canonicalUrls = [];
  const seen = new Set();
  for (const record of message.records) {
    if (record.recordType !== "url" && record.recordType !== "text") continue;
    try {
      const canonical = intakeParseCanonicalTagUrl(decode(record), appOrigin);
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        canonicalUrls.push(canonical);
      }
    } catch {}
  }
  return canonicalUrls;
};

const intakeSafeTakeoverCandidate = (record) => {
  if (
    !record || record.takeoverAvailable !== true || typeof record.tagUrl === "string"
    || typeof record.duckId !== "string" || typeof record.provisioningCommandId !== "string"
    || !Number.isSafeInteger(record.visibleNumber) || record.visibleNumber <= 0
  ) return null;
  return {
    duckId: record.duckId,
    provisioningCommandId: record.provisioningCommandId,
    visibleNumber: record.visibleNumber,
  };
};

const intakeCreateProvisioningMachine = ({
  eventId, location, recover, start, classify, write, confirm: confirmProvisioning, refresh,
  accepted, message, state, feedback, changed = () => {},
  commandId = () => crypto.randomUUID(),
  scheduleReady = (callback) => setTimeout(callback, 900),
  beginBusy = () => () => {},
}) => {
  let pending = null;
  let inFlight = false;
  let removing = false;
  let lastSerial = null;
  let nextStartCommandId = commandId();

  const adopt = (record) => {
    if (!record || typeof record.tagUrl !== "string") return null;
    if (
      pending
      && pending.duckId === record.duckId
      && pending.provisioningCommandId === record.provisioningCommandId
    ) return pending;
    pending = {
      duckId: record.duckId,
      provisioningCommandId: record.provisioningCommandId,
      confirmCommandId: commandId(),
      tagUrl: record.tagUrl,
      writeResolved: false,
    };
    changed();
    return pending;
  };

  const recoverPending = async () => {
    const selectedEventId = eventId();
    if (!selectedEventId) return null;
    const record = await recover(selectedEventId);
    if (record) adopt(record);
    return pending;
  };

  const beginRemove = () => {
    removing = true;
    changed();
    state("remove");
    message("Success. Remove this duck before presenting the next sticker.", false);
    scheduleReady(() => {
      removing = false;
      state("ready");
      message("Ready. Tap the next blank writable sticker.", false);
      changed();
    });
  };

  // Scanning a duck that is already in inventory is not an error to recover
  // from: it is how staff reach that duck's record. The identifier travels to
  // the caller, which opens the duck below the station.
  const alreadyRegistered = (duckId) => {
    pending = null;
    nextStartCommandId = commandId();
    accepted({ outcome: "already", duckId: typeof duckId === "string" ? duckId : null });
    feedback("already");
    state("ready");
    message("This duck is already in inventory. Its record is open below; tap the next sticker when you are done.", false);
    changed();
    void refresh().catch(() => {});
    return { accepted: true, outcome: "already", duckId: typeof duckId === "string" ? duckId : null };
  };

  const refreshAfterOutcome = async () => {
    try {
      await refresh();
    } catch {
      message("The sticker is provisioned, but the authoritative race count could not refresh. Stay online and refresh before continuing.", true);
    }
  };

  const reading = async ({ serialNumber, canonicalUrls }) => {
    const transientSerial = typeof serialNumber === "string" && serialNumber ? serialNumber : null;
    const distinctCanonicalUrls = Array.isArray(canonicalUrls)
      ? Array.from(new Set(canonicalUrls.filter((value) => typeof value === "string")))
      : [];
    if (inFlight || removing) return { accepted: false, reason: "busy" };
    if (transientSerial !== null && transientSerial === lastSerial) {
      return { accepted: false, reason: "repeated" };
    }
    lastSerial = transientSerial;
    inFlight = true;
    const endBusy = beginBusy();
    try {
      const selectedEventId = eventId();
      if (!selectedEventId) {
        state("error");
        message("Select a race before starting NFC provisioning.", true);
        return { accepted: false, reason: "event" };
      }

      if (distinctCanonicalUrls.length > 0) {
        state("checking");
        message("Checking every QuickDucks URL already on this sticker.", false);
        const classifications = [];
        try {
          for (const tagUrl of distinctCanonicalUrls) {
            classifications.push({
              tagUrl,
              result: await classify({ eventId: selectedEventId, tagUrl }),
            });
          }
        } catch {
          lastSerial = null;
          state("error");
          message("Every existing QuickDucks URL must be classified online. Retap the same sticker; nothing was written.", true);
          return { accepted: false, reason: "classify-uncertain" };
        }

        const mismatch = classifications.find(({ result }) => result.kind === "mismatch");
        if (mismatch) {
          state("error");
          message(mismatch.result.message || "That QuickDucks sticker does not belong to this provisioning station. Do not overwrite it.", true);
          return { accepted: false, reason: "mismatch" };
        }
        const exactLocalPending = pending !== null
          && distinctCanonicalUrls.length === 1
          && distinctCanonicalUrls[0] === pending.tagUrl;
        if (pending && !exactLocalPending) {
          state("error");
          message("Finish the pending sticker before tapping another or mixed QuickDucks tag. Nothing was written.", true);
          return { accepted: false, reason: "mismatch" };
        }

        const already = classifications.filter(({ result }) => result.kind === "already");
        const pendingClassifications = classifications.filter(({ result }) => result.kind === "pending");
        const reusable = classifications.filter(({ result }) => result.kind === "reusable");
        if (pendingClassifications.length > 0 && distinctCanonicalUrls.length !== 1) {
          state("error");
          message("This sticker mixes a pending QuickDucks URL with other records. Nothing was written; retap only the exact pending sticker.", true);
          return { accepted: false, reason: "mismatch" };
        }
        if (already.length > 1) {
          state("error");
          message("This sticker contains multiple different registered QuickDucks URLs. Nothing was written.", true);
          return { accepted: false, reason: "mismatch" };
        }
        if (already.length > 0 && !exactLocalPending) {
          return alreadyRegistered(already[0].result.duckId);
        }

        if (already.length === 1 && exactLocalPending) {
          pending.writeResolved = true;
        } else if (pendingClassifications.length > 0) {
          const classification = pendingClassifications[0];
          if (!pending) {
            try {
              await recoverPending();
            } catch {
              lastSerial = null;
              state("error");
              message("The pending sticker could not be recovered online. Retap it after connectivity returns.", true);
              return { accepted: false, reason: "recover-uncertain" };
            }
          }
          if (
            !pending
            || pending.duckId !== classification.result.duckId
            || pending.provisioningCommandId !== classification.result.provisioningCommandId
            || pending.tagUrl !== classification.tagUrl
          ) {
            state("error");
            message("That pending QuickDucks sticker belongs to different inventory. Do not overwrite it.", true);
            return { accepted: false, reason: "mismatch" };
          }
          pending.writeResolved = true;
        } else if (reusable.length !== distinctCanonicalUrls.length) {
          state("error");
          message("This sticker has inconsistent QuickDucks URLs. Nothing was written.", true);
          return { accepted: false, reason: "mismatch" };
        }
      }

      if (!pending) {
        state("reserving");
        message("Reserving a permanent QuickDucks URL for this blank sticker.", false);
        try {
          const created = await start({
            commandId: nextStartCommandId,
            eventId: selectedEventId,
            location: location() || null,
          });
          if (created.status === "CONFIRMED") {
            return alreadyRegistered();
          }
          if (!adopt(created)) throw new Error("invalid-pending");
        } catch {
          lastSerial = null;
          state("error");
          message("A permanent URL could not be reserved online. Retap this same blank sticker; nothing was written.", true);
          return { accepted: false, reason: "start-uncertain" };
        }
      }

      if (pending.writeResolved) {
        if (distinctCanonicalUrls.length !== 1 || distinctCanonicalUrls[0] !== pending.tagUrl) {
          state("error");
          message("Confirmation is still pending. Retap the same sticker that was just written; no new duck was allocated.", true);
          return { accepted: false, reason: "wrong-confirmation-tag" };
        }
      } else {
        state("writing");
        message("Hold the sticker still while QuickDucks writes its permanent URL.", false);
        try {
          await write(pending.tagUrl);
          pending.writeResolved = true;
        } catch {
          lastSerial = null;
          state("error");
          message("The NFC write did not finish. Retap this same sticker; QuickDucks will retry the same reserved URL.", true);
          return { accepted: false, reason: "write-failed" };
        }
      }

      state("confirming");
      message("The sticker was written. Confirming its race reservation online.", false);
      try {
        await confirmProvisioning({
          commandId: pending.confirmCommandId,
          eventId: selectedEventId,
          duckId: pending.duckId,
          provisioningCommandId: pending.provisioningCommandId,
          physicalWriteVerified: true,
        });
      } catch (error) {
        lastSerial = null;
        state("error");
        message(error && Number.isInteger(error.status)
          ? "The written sticker could not be confirmed for this race. Keep it separate and retap it after resolving the event state."
          : "The sticker was written, but confirmation is uncertain. Retap this same sticker; QuickDucks will retry confirmation without rewriting it.", true);
        return { accepted: false, reason: "confirm-uncertain" };
      }

      pending = null;
      nextStartCommandId = commandId();
      accepted({ outcome: "added" });
      await refreshAfterOutcome();
      feedback("added");
      beginRemove();
      void recoverPending().catch(() => {});
      return { accepted: true, outcome: "added" };
    } finally {
      inFlight = false;
      endBusy();
      changed();
    }
  };

  return {
    reading,
    recover: recoverPending,
    adoptTakeover: adopt,
    end() {
      if (inFlight || removing || pending !== null) return false;
      lastSerial = null;
      nextStartCommandId = commandId();
      changed();
      return true;
    },
    resetForEvent() {
      if (inFlight || removing || pending !== null) return false;
      pending = null;
      removing = false;
      lastSerial = null;
      nextStartCommandId = commandId();
      changed();
      return true;
    },
    hasPending() { return pending !== null; },
    isBusy() { return inFlight || removing; },
  };
};

const intakeCreateNfcStation = ({ createReader, decode, appOrigin, onReading, onReadingError, onStartError, onActive }) => {
  let active = false;
  let starting = false;
  let reader = null;
  let handleReading = null;
  let controller = null;
  const start = async () => {
    if (active || starting) return false;
    const candidate = createReader();
    const candidateController = new AbortController();
    const candidateHandleReading = (event) => void onReading({
      serialNumber: event.serialNumber,
      canonicalUrls: intakeCanonicalUrlsFromMessage(event.message, appOrigin, decode),
    });
    reader = candidate;
    controller = candidateController;
    handleReading = candidateHandleReading;
    starting = true;
    reader.addEventListener("reading", candidateHandleReading);
    reader.addEventListener("readingerror", onReadingError);
    try {
      await reader.scan({ signal: candidateController.signal });
      if (reader !== candidate || candidateController.signal.aborted) return false;
      starting = false;
      active = true;
      onActive();
      return true;
    } catch {
      const stopped = candidateController.signal.aborted;
      if (reader === candidate) {
        candidate.removeEventListener("reading", candidateHandleReading);
        candidate.removeEventListener("readingerror", onReadingError);
        reader = null;
        handleReading = null;
        controller = null;
        starting = false;
      }
      if (!stopped) onStartError();
      return false;
    }
  };
  return {
    start,
    stop() {
      if (!active && !starting) return false;
      const currentReader = reader;
      const currentHandleReading = handleReading;
      const currentController = controller;
      active = false;
      starting = false;
      reader = null;
      handleReading = null;
      controller = null;
      if (currentReader && currentHandleReading) {
        currentReader.removeEventListener("reading", currentHandleReading);
        currentReader.removeEventListener("readingerror", onReadingError);
      }
      currentController?.abort();
      return true;
    },
    async write(tagUrl) {
      if (!active || reader === null) throw new Error("nfc-not-active");
      await reader.write({ records: [{ recordType: "url", data: tagUrl }] });
    },
    isActive() { return active; },
  };
};
`;

export const eventLifecycleHelpersScript = String.raw`
const lifecycleCreateAttempt = (commandId = crypto.randomUUID()) => {
  let state = "READY";
  return {
    begin() {
      if (state !== "READY") return null;
      state = "IN_FLIGHT";
      return commandId;
    },
    fail() {
      if (state === "IN_FLIGHT") state = "READY";
    },
    complete() {
      state = "COMPLETE";
    },
    disabled() {
      return state !== "READY";
    },
  };
};

const lifecycleShouldRenderEvent = (selectedEventId, current, incoming) => {
  if (selectedEventId !== incoming.id) return false;
  if (current === null || current.id !== incoming.id) return true;
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return !current.updatedAt || !incoming.updatedAt || incoming.updatedAt >= current.updatedAt;
};

const lifecycleStatusOrder = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "ROUND_ONE",
  "FINAL",
  "COMPLETED",
];

const lifecycleReadinessPresentation = (state, eventStatus) => {
  const eventRank = lifecycleStatusOrder.indexOf(eventStatus);
  const fromRank = lifecycleStatusOrder.indexOf(state.fromStatus);
  const toRank = lifecycleStatusOrder.indexOf(state.toStatus);
  const isBackward = fromRank >= 0 && toRank >= 0 && toRank < fromRank;
  if (isBackward && eventStatus === state.toStatus) {
    return { kind: "not-needed", chipText: "Not needed", chipClass: "status-chip", upcoming: false };
  }
  if (!isBackward && eventRank >= 0 && toRank >= 0 && eventRank >= toRank) {
    return { kind: "done", chipText: "Done", chipClass: "status-chip done", upcoming: false };
  }
  return state.allowed
    ? { kind: "ready", chipText: "Ready", chipClass: "status-chip ready", upcoming: true }
    : { kind: "blocked", chipText: "Blocked", chipClass: "status-chip blocked", upcoming: true };
};
`;

export const eventSlugHelpersScript = String.raw`
const eventSlugFromName = (name) => {
  const source = String(name).trim().replace(/\s+/g, " ").normalize("NFKD");
  const slug = source
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (slug) return slug;

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return "event-" + (hash >>> 0).toString(36);
};
`;

// Timezone options are built in the browser: the full IANA list is far too
// large to server-render into every staff page, and the operator's own zone is
// only knowable on the device. The server renders one valid option so the
// select is never empty and the form stays valid before this runs.
export const timezonePickerHelpersScript = String.raw`
// Used only when Intl.supportedValuesOf is missing. Small on purpose: it is a
// usable spread of zones, not a second copy of the tz database.
const timezoneFallbackZones = [
  "UTC",
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
  "America/Anchorage", "America/Argentina/Buenos_Aires", "America/Bogota",
  "America/Chicago", "America/Denver", "America/Halifax", "America/Lima",
  "America/Los_Angeles", "America/Mexico_City", "America/New_York",
  "America/Phoenix", "America/Puerto_Rico", "America/Sao_Paulo",
  "America/St_Johns", "America/Toronto", "America/Vancouver",
  "Asia/Bangkok", "Asia/Dubai", "Asia/Hong_Kong", "Asia/Jakarta",
  "Asia/Jerusalem", "Asia/Karachi", "Asia/Kolkata",
  "Asia/Manila", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore",
  "Asia/Taipei", "Asia/Tokyo",
  "Atlantic/Reykjavik",
  "Australia/Adelaide", "Australia/Brisbane", "Australia/Melbourne",
  "Australia/Perth", "Australia/Sydney",
  "Europe/Amsterdam", "Europe/Athens", "Europe/Berlin", "Europe/Brussels",
  "Europe/Bucharest", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul",
  "Europe/Lisbon", "Europe/London", "Europe/Madrid", "Europe/Moscow",
  "Europe/Oslo", "Europe/Paris", "Europe/Prague", "Europe/Rome",
  "Europe/Stockholm", "Europe/Vienna", "Europe/Warsaw", "Europe/Zurich",
  "Pacific/Auckland", "Pacific/Fiji", "Pacific/Honolulu",
];

const timezoneDetect = () => {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof detected === "string" && detected !== "") return detected;
  } catch {}
  return "UTC";
};

const timezoneSupportedZones = () => {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const zones = Intl.supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones.slice();
    }
  } catch {}
  return timezoneFallbackZones.slice();
};

// The detected zone and any already-stored zone are always selectable, even
// when the runtime list omits them (legacy aliases such as US/Mountain).
const timezoneZoneList = (detected, current) => {
  const zones = timezoneSupportedZones();
  const seen = new Set(zones);
  for (const extra of ["UTC", detected, current]) {
    if (typeof extra === "string" && extra !== "" && !seen.has(extra)) {
      seen.add(extra);
      zones.push(extra);
    }
  }
  return zones.sort((left, right) => left.localeCompare(right));
};

const timezoneOptionLabel = (zone, detected) => zone === detected ? zone + " (detected)" : zone;

const timezoneBuildOption = (doc, zone, detected, selected) => {
  const option = doc.createElement("option");
  option.value = zone;
  option.textContent = timezoneOptionLabel(zone, detected);
  if (zone === detected) option.setAttribute("data-detected", "true");
  option.selected = selected;
  option.defaultSelected = selected;
  return option;
};

const timezoneSelectDocument = (select, context) => context.documentObject
  || select.ownerDocument
  || document;

// Applies a stored zone, adding it to the list first when the runtime does not
// know it, so an existing event never loses or silently changes its timezone.
const timezoneApplyValue = (select, value, context = {}) => {
  if (!select) return "";
  const zone = typeof value === "string" ? value.trim() : "";
  if (zone === "") return select.value;
  const options = Array.from(select.options || []);
  if (!options.some((option) => option.value === zone)) {
    const doc = timezoneSelectDocument(select, context);
    const detected = context.detected
      || (typeof select.getAttribute === "function" ? select.getAttribute("data-timezone-detected") : "")
      || "";
    const option = timezoneBuildOption(doc, zone, detected, false);
    const before = options.find((existing) => existing.value.localeCompare(zone) > 0);
    if (before && typeof select.insertBefore === "function") select.insertBefore(option, before);
    else select.append(option);
  }
  select.value = zone;
  return select.value;
};

// data-timezone-detect marks a field with no stored value yet (event creation),
// where the detected zone is the default selection.
const timezonePopulate = (select, context = {}) => {
  const doc = timezoneSelectDocument(select, context);
  const detected = context.detected || timezoneDetect();
  const rendered = typeof select.value === "string" ? select.value : "";
  const preferDetected = typeof select.getAttribute === "function"
    && select.getAttribute("data-timezone-detect") === "true";
  const desired = preferDetected || rendered === "" ? detected : rendered;
  const zones = timezoneZoneList(detected, desired);
  select.replaceChildren(
    ...zones.map((zone) => timezoneBuildOption(doc, zone, detected, zone === desired)),
  );
  if (typeof select.setAttribute === "function") select.setAttribute("data-timezone-detected", detected);
  select.value = desired;
  return { detected, desired, zones };
};
`;

export const inventoryDetailHelpersScript = String.raw`
const createInventoryDetailController = ({ detail, list, closeButton, clear }) => {
  let returnTarget = null;
  let selectedDuckId = null;
  let requestVersion = 0;

  const buttons = () => list.querySelectorAll("[data-duck-id]");
  const currentButton = () => Array.from(buttons())
    .find((button) => button.dataset.duckId === selectedDuckId) || null;
  const syncButtons = () => {
    for (const button of buttons()) {
      button.setAttribute("aria-expanded", String(!detail.hidden && button.dataset.duckId === selectedDuckId));
    }
  };
  const open = (duckId, trigger, focusDetail = true) => {
    selectedDuckId = duckId;
    returnTarget = trigger || currentButton();
    detail.hidden = false;
    syncButtons();
    if (focusDetail) closeButton.focus();
  };
  const close = ({ restoreFocus = true } = {}) => {
    const target = returnTarget && returnTarget.isConnected ? returnTarget : currentButton();
    requestVersion += 1;
    selectedDuckId = null;
    detail.hidden = true;
    syncButtons();
    clear();
    returnTarget = null;
    if (restoreFocus && target) target.focus();
  };

  closeButton.addEventListener("click", () => close());
  return {
    open,
    close,
    syncButtons,
    beginRequest: () => ++requestVersion,
    isCurrentRequest: (version) => version === requestVersion,
  };
};
`;

// Inventory sectioning. The grouping is derived from the states the inventory
// API already reports for every duck — its `inventoryStatus`, its most recent
// event reservation, and its open participant assignment — so the console never
// invents an inventory state of its own.
//
// A duck is "in use" when it is committed to a race: it holds an unreleased
// reservation, it is paired with a participant, or its status is already
// IN_USE. It is "ready to be reserved" when it is not committed and its status
// is AVAILABLE, which is exactly the state the assign and pairing paths accept.
// Everything else (NEW mid-provisioning, QUARANTINED, DAMAGED, RETIRED,
// MISSING, UNACCOUNTED_FOR, KEPT) cannot be reserved and is kept visible in a
// third group rather than dropped from the list.
export const inventoryGroupHelpersScript = String.raw`
const inventoryGroupDefinitions = [
  {
    key: "IN_USE",
    title: "In use",
    description: "Reserved to a race, paired with a participant, or racing now.",
    emptyMessage: "No ducks are reserved or paired yet.",
    alwaysRender: true,
  },
  {
    key: "READY",
    title: "Ready to be reserved",
    description: "Available ducks with no live reservation. Assigning one reserves it automatically.",
    emptyMessage: "No ducks are ready to be reserved.",
    alwaysRender: true,
  },
  {
    key: "UNAVAILABLE",
    title: "Not ready to reserve",
    description: "Ducks that cannot be reserved until their inventory state changes.",
    emptyMessage: "No ducks are held out of the race.",
    alwaysRender: false,
  },
];

const inventoryDuckReserved = (duck) => Boolean(duck && duck.reservation && !duck.reservation.releasedAt);
const inventoryDuckPaired = (duck) => Boolean(duck && (duck.assignment || duck.participant));

const inventoryDuckGroupKey = (duck) => {
  if (inventoryDuckReserved(duck) || inventoryDuckPaired(duck)) return "IN_USE";
  if (duck && duck.inventoryStatus === "IN_USE") return "IN_USE";
  return duck && duck.inventoryStatus === "AVAILABLE" ? "READY" : "UNAVAILABLE";
};

// Groups keep the server's visible-number ordering. The two primary groups are
// always rendered, with an explicit empty message instead of a blank area; the
// exception bucket is rendered only when it actually holds ducks.
const groupInventoryDucks = (ducks) => inventoryGroupDefinitions
  .map((group) => ({
    key: group.key,
    title: group.title,
    description: group.description,
    emptyMessage: group.emptyMessage,
    alwaysRender: group.alwaysRender,
    ducks: (ducks || []).filter((duck) => inventoryDuckGroupKey(duck) === group.key),
  }))
  .filter((group) => group.alwaysRender || group.ducks.length > 0);
`;

// The standalone /staff/inventory page: the duck list and detail panel that used
// to be a console section, plus the blank-sticker scanning station that used to
// be its own Android-only page.
//
// Only the station is device gated, and it gates itself in place. Everything
// below it runs on any device that can sign in, which is the whole reason this
// page exists: the old station page replaced itself with a compatibility notice
// on a laptop and took the staff navigation down with it.
export const staffInventoryScript = inventoryDetailHelpersScript
  + inventoryGroupHelpersScript
  + inventoryIntakeHelpersScript
  + String.raw`
const inventoryRoot = document.querySelector("[data-staff-inventory]");
const inventoryMessageLine = document.querySelector("[data-console-message]");
const eventSelect = document.querySelector("[data-event-select]");
const inventoryNoRace = document.querySelector("[data-no-race]");
const inventoryList = document.querySelector("[data-inventory-list]");
const inventoryDetail = document.querySelector("[data-inventory-detail]");
const inventoryFacts = document.querySelector("[data-inventory-facts]");
const inventoryHistory = document.querySelector("[data-inventory-history]");
const inventoryDuckNameForm = document.querySelector("[data-inventory-duck-name-form]");
const inventoryClearNameButton = document.querySelector("[data-clear-duck-name]");
const assignForm = document.querySelector("[data-inventory-assign-form]");
const unassignForm = document.querySelector("[data-inventory-unassign-form]");
const releaseReservationForm = document.querySelector("[data-reservation-release-form]");
const deleteDuckForm = document.querySelector("[data-duck-delete-form]");
const deleteDuckEffect = document.querySelector("[data-delete-duck-effect]");
const inventoryCloseButton = document.querySelector("[data-close-inventory-detail]");

let currentEvent = null;
let selectedDuck = null;
let inventoryCommandCount = 0;
let inventorySubscription = null;

// A duck or race entry handed over by another staff page. Consumed once, so a
// later refresh does not keep yanking the panel back to it.
const inventoryQuery = new URLSearchParams(location.search);
let requestedDuckId = inventoryQuery.get("duck");
const requestedRaceEntryId = inventoryQuery.get("raceEntry");

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

const humanize = (value) => String(value || "none").replaceAll("_", " ").toLowerCase()
  .replace(/^./, (character) => character.toUpperCase());

const setMessage = (message, isError = false) => {
  if (!inventoryMessageLine) return;
  inventoryMessageLine.textContent = message;
  inventoryMessageLine.classList.toggle("error-text", isError);
};

const empty = (message) => text("p", message, "empty-state");

const showFacts = (container, facts) => {
  container.replaceChildren();
  for (const [label, value] of facts) {
    const fact = text("div", "", "fact");
    fact.append(text("dt", label), text("dd", value == null || value === "" ? "None" : value));
    container.append(fact);
  }
};

const historyCard = (title, detail) => {
  const card = text("div", "", "data-card");
  card.append(text("h3", title), text("p", detail, "muted"));
  return card;
};

// The duck name is free text that is published, so a moderator has to be able to
// tell a name the read-time filter is already suppressing from one the public
// can see. It reaches the page as text through the shared helper either way.
const inventoryDuckNameLabel = (duck) => duck.duckNamePubliclyHidden === true
  ? duck.duckName + " (already hidden from public surfaces)"
  : duck.duckName;

const commandOptions = (method, payload) => ({
  method,
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const api = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  let body = null;
  if (response.status !== 204) {
    try { body = await response.json(); } catch { body = null; }
  }
  if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed.");
  return body;
};

const perform = async (button, loadingMessage, operation) => {
  button.disabled = true;
  inventoryCommandCount += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  setMessage(loadingMessage);
  try {
    const result = await operation();
    globalThis.quickDucksLive.markClean(button.form);
    setMessage("Saved. Current data has been refreshed.");
    return result;
  } catch (error) {
    if (error.message !== "signed-out") setMessage(error.message, true);
    return null;
  } finally {
    button.disabled = false;
    inventoryCommandCount = Math.max(0, inventoryCommandCount - 1);
    endBusy();
    inventorySubscription?.resume();
  }
};

const currentEventId = () => {
  if (!currentEvent) throw new Error("There is no event to work against yet.");
  return currentEvent.id;
};

const clearInventoryDetail = () => {
  selectedDuck = null;
  document.querySelector("[data-inventory-name]").textContent = "Duck detail";
  inventoryFacts.replaceChildren();
  inventoryHistory.replaceChildren();
  document.querySelector("[data-label-result]").replaceChildren();
  for (const form of inventoryDetail.querySelectorAll("form")) form.reset();
  for (const disclosure of inventoryDetail.querySelectorAll("details")) disclosure.open = false;
  inventoryDuckNameForm.hidden = true;
  unassignForm.hidden = true;
  releaseReservationForm.hidden = true;
  globalThis.quickDucksLive.markClean(inventoryDetail);
};

const inventoryDetailController = createInventoryDetailController({
  detail: inventoryDetail,
  list: inventoryList,
  closeButton: inventoryCloseButton,
  clear: clearInventoryDetail,
});

const inventoryCard = (duck) => {
  const eventLabel = duck.reservation && !duck.reservation.releasedAt ? " · " + duck.reservation.event.name : "";
  const label = "Duck #" + duck.visibleNumber
    + (duck.duckName ? " · " + inventoryDuckNameLabel(duck) : "")
    + " · " + humanize(duck.inventoryStatus) + eventLabel;
  const button = text("button", label, "result-button");
  button.type = "button";
  button.dataset.duckId = duck.id;
  button.setAttribute("aria-controls", "inventory-detail-panel");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => loadDuckDetail(duck.id, button, true)
    .catch((error) => setMessage(error.message, true)));
  return button;
};

// The cards stay one grid of the same buttons; each group is a labelled band
// across that grid so the detail controller still finds every [data-duck-id]
// card and selection, focus, and live refresh behave exactly as before.
const inventoryGroupSection = (group) => {
  const section = text("section", "", "inventory-group");
  section.dataset.inventoryGroup = group.key;
  const heading = text("h3", group.title, "inventory-group-title");
  heading.id = "inventory-group-" + group.key.toLowerCase().replaceAll("_", "-");
  section.setAttribute("aria-labelledby", heading.id);
  section.append(heading);
  if (group.ducks.length === 0) {
    section.append(empty(group.emptyMessage));
    return section;
  }
  section.append(text(
    "p",
    group.ducks.length + (group.ducks.length === 1 ? " duck · " : " ducks · ") + group.description,
    "muted",
  ));
  const cards = text("div", "", "data-list inventory-card-grid");
  for (const duck of group.ducks) cards.append(inventoryCard(duck));
  section.append(cards);
  return section;
};

const loadInventory = async () => {
  const body = await api("/api/v1/staff/inventory/ducks");
  inventoryList.replaceChildren();
  if (body.ducks.length === 0) {
    inventoryList.append(empty("No ducks are in inventory. Scan a blank sticker to add the first one."));
    inventoryDetailController.syncButtons();
    return;
  }
  for (const group of groupInventoryDucks(body.ducks)) inventoryList.append(inventoryGroupSection(group));
  inventoryDetailController.syncButtons();
};

// Deleting a paired duck also hands its participant back to the pairing queue,
// so the confirmation says which of the two things is about to happen.
const renderDeleteEffect = (duck) => {
  deleteDuckEffect.textContent = duck.participant
    ? "Removes this duck from inventory and puts its participant back in the queue for a new duck. Their heat place is kept, and that heat cannot start until they hold a duck again. This cannot be undone."
    : "Removes this duck from inventory. Its tag can be written again. This cannot be undone.";
};

const renderDuckDetail = (body) => {
  selectedDuck = body.duck;
  const duck = body.duck;
  document.querySelector("[data-inventory-name]").textContent = "Duck #" + duck.visibleNumber;
  showFacts(inventoryFacts, [
    ["Inventory", humanize(duck.inventoryStatus)],
    ["Duck name", duck.duckName ? inventoryDuckNameLabel(duck) : "Not named"],
    ["Location", duck.location || "Not set"],
    ["Tag", duck.tag ? humanize(duck.tag.status) : "No tag"],
    ["Reservation", duck.reservation ? duck.reservation.event.name + (duck.reservation.releasedAt ? " · released" : " · active") : "None"],
    ["Participant", duck.participant
      ? duck.participant.firstName
        ? duck.participant.firstName + " " + duck.participant.lastName
        : "Assigned race entry " + duck.participant.raceEntryId
      : "Unpaired"],
    ["Heat", duck.heat ? humanize(duck.heat.round) + " " + duck.heat.number : "None"],
    ["Revision", duck.revision],
  ]);
  // A name labels a duck someone is racing, so the field appears only while
  // this duck is paired. The endpoint refuses it otherwise.
  inventoryDuckNameForm.hidden = !duck.participant;
  inventoryDuckNameForm.elements.duckName.value = duck.duckName || "";
  inventoryClearNameButton.hidden = !duck.duckName;
  unassignForm.hidden = !duck.assignment;
  releaseReservationForm.hidden = !duck.reservation || Boolean(duck.reservation.releasedAt) || Boolean(duck.assignment);
  renderDeleteEffect(duck);
  inventoryHistory.replaceChildren();
  for (const item of body.history.inventoryEvents) {
    inventoryHistory.append(historyCard(humanize(item.action), item.occurredAt + " · " + (item.actor.displayName || "Staff")));
  }
  for (const item of body.history.tags) {
    inventoryHistory.append(historyCard("Tag " + humanize(item.status), item.createdAt + (item.retiredAt ? " · retired " + item.retiredAt : "")));
  }
  for (const item of body.history.reservations) {
    inventoryHistory.append(historyCard("Reservation · " + item.event.name, item.releasedAt ? "Released " + item.releasedAt : "Active since " + item.reservedAt));
  }
  for (const item of body.history.assignments) {
    const participant = item.participant.firstName
      ? item.participant.firstName + " " + item.participant.lastName
      : "Race entry " + item.participant.raceEntryId;
    inventoryHistory.append(historyCard("Assignment · " + participant, item.validTo ? "Closed " + item.validTo : "Active since " + item.validFrom));
  }
  if (!inventoryHistory.childElementCount) inventoryHistory.append(empty("No inventory history is recorded."));
};

const loadDuckDetail = async (duckId, trigger = null, focusDetail = false) => {
  const requestVersion = inventoryDetailController.beginRequest();
  const body = await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(duckId));
  if (!inventoryDetailController.isCurrentRequest(requestVersion)) return;
  renderDuckDetail(body);
  inventoryDetailController.open(duckId, trigger, focusDetail);
};

const refreshSelectedDuck = async () => {
  const duckId = selectedDuck && !inventoryDetail.hidden ? selectedDuck.id : null;
  const loads = [loadInventory()];
  if (duckId) loads.push(loadDuckDetail(duckId));
  await Promise.all(loads);
};

// A duck deleted while its panel was open has no detail left to load, so the
// panel closes rather than reporting a 404 the actor cannot act on.
const forgetSelectedDuck = async () => {
  inventoryDetailController.close({ restoreFocus: false });
  await loadInventory();
};

document.querySelector("[data-refresh-inventory]").addEventListener("click", () => loadInventory()
  .catch((error) => setMessage(error.message, true)));

document.querySelector("[data-inventory-intake-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Adding duck to inventory…", async () => {
    const result = await api("/api/v1/staff/inventory/ducks", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(),
      visibleNumber: Number(values.get("visibleNumber")), tagToken: String(values.get("tagToken")),
      location: String(values.get("location")) || null,
      notes: String(values.get("notes")) || null, physicallyPresent: values.get("physicallyPresent") === "on",
    }));
    form.reset();
    await loadInventory();
    await loadDuckDetail(result.duck.id, null, true);
  });
});

inventoryDuckNameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const duckName = String(new FormData(form).get("duckName") || "");
  await perform(form.querySelector("button"), "Saving duck name…", async () => {
    await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(selectedDuck.participant.registrationId) + "/set-duck-name",
      commandOptions("POST", { commandId: crypto.randomUUID(), duckName }),
    );
    await refreshSelectedDuck();
  });
});

inventoryClearNameButton.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!await appConfirm(
    "Clear this duck's name? It goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;
  await perform(button, "Clearing duck name…", async () => {
    await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(selectedDuck.participant.registrationId) + "/clear-duck-name",
      commandOptions("POST", { commandId: crypto.randomUUID() }),
    );
    await refreshSelectedDuck();
  });
});

document.querySelector("[data-print-label]").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  await perform(button, "Loading label data…", async () => {
    const result = await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/label");
    const link = text("a", "Duck #" + result.visibleNumber + " tag URL");
    link.href = result.tagUrl;
    link.target = "_blank";
    link.rel = "noopener";
    document.querySelector("[data-label-result]").replaceChildren(link);
  });
});

assignForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  if (!selectedDuck) {
    setMessage("Select an inventory duck first.", true);
    return;
  }
  if (!await appConfirm("Assign Duck #" + selectedDuck.visibleNumber + " to this race entry?")) return;
  await perform(button, "Assigning duck…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/assignments", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), raceEntryId: String(values.get("raceEntryId")),
      expectedRevision: selectedDuck.revision, reason: String(values.get("reason")),
    }));
    await refreshSelectedDuck();
  });
});

unassignForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  if (!await appConfirm("Unpair Duck #" + selectedDuck.visibleNumber + " from its participant?", { danger: true })) return;
  await perform(button, "Unpairing duck…", async () => {
    await api("/api/v1/staff/inventory/assignments/" + encodeURIComponent(selectedDuck.assignment.id) + "/unassign", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision,
      releaseReservation: values.get("releaseReservation") === "on", reason: String(values.get("reason")),
    }));
    form.reset();
    await refreshSelectedDuck();
  });
});

releaseReservationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const reason = String(new FormData(form).get("reason"));
  if (!await appConfirm("Release Duck #" + selectedDuck.visibleNumber + " from this event?", { danger: true })) return;
  await perform(button, "Releasing reservation…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/reservations/release", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision, reason,
    }));
    form.reset();
    await refreshSelectedDuck();
  });
});

deleteDuckForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const reason = String(new FormData(form).get("reason"));
  const duck = selectedDuck;
  if (!duck) {
    setMessage("Select an inventory duck first.", true);
    return;
  }
  if (!await appConfirm(
    duck.participant
      ? "Delete Duck #" + duck.visibleNumber + "? Its participant goes back into the queue for a new duck, and this duck is gone for good."
      : "Delete Duck #" + duck.visibleNumber + "? It is gone for good.",
    { danger: true, confirmLabel: "Delete duck" },
  )) return;
  await perform(button, "Deleting duck…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(duck.id) + "/delete", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: duck.revision, reason,
    }));
    form.reset();
    await forgetSelectedDuck();
  });
});

// ---------------------------------------------------------------------------
// Blank NFC sticker station
//
// Everything below is conditional on the device. The runtime check disables the
// station's own controls and says why; it never touches the inventory above it.
// ---------------------------------------------------------------------------
const intakeRoot = document.querySelector("[data-intake-station]");
const intakeLocation = document.querySelector("[data-intake-location]");
const intakeNfcButton = document.querySelector("[data-start-intake-nfc]");
const intakeEndNfcButton = document.querySelector("[data-end-intake-nfc]");
const intakeState = document.querySelector("[data-intake-state]");
const intakeMessage = document.querySelector("[data-intake-message]");
const intakeReservedCount = document.querySelector("[data-reserved-count]");
const intakeSessionCount = document.querySelector("[data-session-count]");
const intakeHistory = document.querySelector("[data-intake-history]");
const intakeTakeoverPanel = document.querySelector("[data-intake-takeover]");
const intakeTakeoverMessage = document.querySelector("[data-intake-takeover-message]");
const intakeTakeoverButton = document.querySelector("[data-takeover-provisioning]");
const intakeRuntimeNotice = document.querySelector("[data-intake-runtime]");
const intakeRuntimeMessage = document.querySelector("[data-intake-runtime-message]");
const intakeControls = document.querySelector("[data-intake-controls]");
const intakeAppOrigin = inventoryRoot.dataset.appOrigin;

let intakeTopLevel = false;
try { intakeTopLevel = window.top === window.self; } catch {}
const intakeRuntimeIssue = () => intakeProvisioningRuntimeIssue({
  userAgent: navigator.userAgent,
  hasNdefReader: typeof globalThis.NDEFReader === "function",
  secureContext: isSecureContext === true,
  topLevel: intakeTopLevel,
  visible: document.visibilityState === "visible",
});
const intakeShowRuntimeIssue = (issue) => {
  const messages = {
    "android-chrome": "Scanning needs current Chrome on an NFC-capable Android device. It is not available on desktop, iPhone, iPad, Android WebView, or another Android browser. Everything else on this page still works here.",
    "web-nfc": "This Android Chrome runtime does not expose Web NFC. Update Chrome or use another NFC-capable Android device.",
    "secure-context": "Open the HTTPS QuickDucks site directly before scanning.",
    "top-level": "Open QuickDucks in a top-level browser tab, not an embedded frame.",
    visible: "Bring this page into view and reload it before scanning.",
  };
  intakeControls.hidden = true;
  intakeRuntimeNotice.hidden = false;
  intakeRuntimeMessage.textContent = messages[issue] || "This device cannot scan NFC stickers.";
};

let intakeAddedCount = 0;
let intakeStarted = false;
let intakeStarting = false;
let intakeSupported = true;
let intakeAudio = null;
let intakeTakeoverCandidate = null;
let intakeNfcStation = null;
let intakeMachine = null;
const intakeEnabled = intakeRuntimeIssue() === null;

const intakeSetMessage = (value, isError = false) => {
  if (!intakeEnabled) return;
  intakeMessage.textContent = value;
  intakeMessage.classList.toggle("error-text", isError);
};

const intakeSetState = (value) => {
  if (!intakeEnabled) return;
  const labels = {
    checking: "Checking sticker",
    confirming: "Confirming",
    error: "Needs attention",
    ended: "Ended",
    ready: "Ready",
    remove: "Remove duck",
    reserving: "Reserving URL",
    writing: "Writing sticker",
  };
  intakeState.textContent = labels[value] || "Not started";
};

const intakeCanProvision = () =>
  currentEvent !== null && intakeOpenStatuses.has(currentEvent.status);

const intakeUpdateControls = () => {
  if (!intakeEnabled) return;
  const active = intakeStarted && intakeNfcStation?.isActive() === true;
  const pending = intakeMachine?.hasPending() === true;
  const busy = intakeMachine?.isBusy() === true;
  const running = active || intakeStarting;
  intakeNfcButton.disabled = !intakeSupported || !intakeCanProvision() || running;
  intakeNfcButton.textContent = active ? "NFC provisioning active" : "Start NFC provisioning";
  intakeEndNfcButton.hidden = !active;
  intakeEndNfcButton.disabled = !active || busy || pending;
  eventSelect.disabled = running || pending;
  intakeLocation.disabled = running;
};

const intakePost = (path, body) => api(path, commandOptions("POST", body));

const intakeOfferTakeover = (record) => {
  if (!intakeEnabled) return;
  intakeTakeoverCandidate = intakeSafeTakeoverCandidate(record);
  intakeTakeoverPanel.hidden = intakeTakeoverCandidate === null;
  intakeTakeoverMessage.textContent = intakeTakeoverCandidate === null
    ? ""
    : "Pending Duck #" + intakeTakeoverCandidate.visibleNumber + " has had no ownership activity for at least 10 minutes.";
};

const intakeRefreshStation = async () => {
  await loadInventory();
  if (!currentEvent) {
    if (intakeEnabled) intakeReservedCount.textContent = "0";
    return;
  }
  const detail = await api("/api/v1/staff/events/" + encodeURIComponent(currentEvent.id));
  currentEvent = detail.event;
  if (!intakeEnabled) return;
  intakeReservedCount.textContent = String(detail.summary.eventDucks);
  if (!intakeOpenStatuses.has(detail.event.status)) {
    intakeSetState("error");
    intakeSetMessage("Scanning new ducks in is closed for this event.", true);
  }
};

const intakeAddHistory = ({ outcome, duckId }) => {
  // A sticker already in inventory is a lookup, not an intake: open its record.
  if (outcome === "already" && typeof duckId === "string") {
    loadDuckDetail(duckId, null, false).catch((error) => setMessage(error.message, true));
  }
  if (!intakeEnabled) return;
  if (intakeHistory.children.length === 1 && intakeHistory.firstElementChild.textContent.startsWith("No ducks")) {
    intakeHistory.replaceChildren();
  }
  const item = document.createElement("li");
  item.textContent = outcome === "added" ? "Sticker provisioned and reserved" : "Already in inventory; opened its record";
  intakeHistory.prepend(item);
  while (intakeHistory.children.length > 12) intakeHistory.lastElementChild.remove();
  if (outcome === "added") {
    intakeAddedCount += 1;
    intakeSessionCount.textContent = String(intakeAddedCount);
  }
};

const intakeFeedback = () => {
  if (typeof navigator.vibrate === "function") navigator.vibrate(120);
  if (!intakeAudio) return;
  try {
    const oscillator = intakeAudio.createOscillator();
    const gain = intakeAudio.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(intakeAudio.destination);
    oscillator.start();
    oscillator.stop(intakeAudio.currentTime + 0.12);
  } catch {}
};

if (intakeEnabled) {
  intakeRuntimeNotice.hidden = true;
  intakeControls.hidden = false;

  intakeMachine = intakeCreateProvisioningMachine({
    eventId: () => (currentEvent ? currentEvent.id : ""),
    location: () => intakeLocation.value.trim(),
    recover: async (eventId) => {
      const body = await api("/api/v1/staff/inventory/provisioning?eventId=" + encodeURIComponent(eventId));
      intakeOfferTakeover(body.provisioning);
      return body.provisioning;
    },
    start: (body) => {
      intakeOfferTakeover(null);
      return intakePost("/api/v1/staff/inventory/provisioning", body);
    },
    classify: (body) => intakePost("/api/v1/staff/inventory/provisioning/classify", body),
    write: (tagUrl) => intakeNfcStation.write(tagUrl),
    confirm: (body) => intakePost("/api/v1/staff/inventory/provisioning/confirm", body),
    refresh: intakeRefreshStation,
    accepted: intakeAddHistory,
    message: intakeSetMessage,
    state: (value) => {
      intakeSetState(value);
      intakeUpdateControls();
    },
    feedback: intakeFeedback,
    changed: intakeUpdateControls,
    beginBusy: () => globalThis.quickDucksLive.beginBusy(),
  });

  intakeNfcStation = intakeCreateNfcStation({
    createReader: () => new NDEFReader(),
    decode: (record) => new TextDecoder(record.encoding || "utf-8").decode(record.data),
    appOrigin: intakeAppOrigin,
    onReading: (reading) => intakeMachine.reading(reading),
    onReadingError: () => intakeSetMessage("The NFC sticker could not be read. Remove it, then retap the same sticker.", true),
    onStartError: () => {
      intakeSetState("error");
      intakeSetMessage("NFC scanning could not start. Use current Android Chrome over HTTPS, allow NFC, and keep this top-level page visible.", true);
    },
    onActive: () => {
      intakeSetState("ready");
      intakeSetMessage(intakeMachine.hasPending()
        ? "A pending sticker was recovered. Retap that same sticker to finish it before using another."
        : "Ready. Tap a sticker.", false);
    },
  });

  intakeTakeoverButton.addEventListener("click", async () => {
    const candidate = intakeTakeoverCandidate;
    if (candidate === null || intakeMachine.isBusy() || intakeMachine.hasPending()) return;
    if (!await appConfirm(
      "Take over pending Duck #" + candidate.visibleNumber
      + "? Continue only if the previous provisioning station has been abandoned.",
      { danger: true },
    )) return;
    intakeTakeoverButton.disabled = true;
    const endBusy = globalThis.quickDucksLive.beginBusy();
    intakeSetMessage("Taking ownership of the abandoned pending sticker.", false);
    try {
      const recovered = await intakePost("/api/v1/staff/inventory/provisioning/takeover", {
        commandId: crypto.randomUUID(),
        eventId: currentEventId(),
        duckId: candidate.duckId,
        provisioningCommandId: candidate.provisioningCommandId,
      });
      if (!intakeMachine.adoptTakeover(recovered)) throw new Error("invalid-takeover");
      intakeOfferTakeover(null);
      intakeSetMessage(intakeStarted
        ? "Takeover complete. Retap that exact pending sticker to finish confirmation."
        : "Takeover complete. Press Start, then retap that exact pending sticker.", false);
    } catch {
      intakeSetState("error");
      intakeSetMessage("The pending sticker could not be taken over. Refresh its status before trying again.", true);
    } finally {
      intakeTakeoverButton.disabled = false;
      endBusy();
      inventorySubscription?.resume();
    }
  });

  intakeNfcButton.addEventListener("click", async () => {
    if (!intakeSupported || intakeStarted || intakeStarting) return;
    const runtimeIssue = intakeRuntimeIssue();
    if (runtimeIssue !== null) {
      intakeSupported = false;
      intakeSetState("error");
      intakeSetMessage("This station no longer has a supported visible Android Chrome Web NFC context. Reload it after correcting the device or browser context.", true);
      intakeUpdateControls();
      return;
    }
    if (!intakeCanProvision()) {
      intakeSetState("error");
      intakeSetMessage("Scanning new ducks in is closed for this event.", true);
      return;
    }
    if (document.hidden) {
      intakeSetState("error");
      intakeSetMessage("Keep this page visible before starting NFC provisioning.", true);
      return;
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContextClass) {
      try {
        intakeAudio = new AudioContextClass();
        void intakeAudio.resume();
      } catch {}
    }
    intakeStarting = true;
    intakeUpdateControls();
    const started = await intakeNfcStation.start();
    intakeStarting = false;
    if (!started) {
      intakeUpdateControls();
      return;
    }
    intakeStarted = true;
    intakeUpdateControls();
    globalThis.quickDucksLive.markClean(inventoryRoot);
    inventorySubscription?.resume();
  });

  intakeEndNfcButton.addEventListener("click", () => {
    if (!intakeStarted) return;
    if (!intakeMachine.end()) {
      intakeUpdateControls();
      if (intakeMachine.hasPending()) {
        intakeSetMessage("Finish the pending sticker before ending NFC provisioning.", true);
      }
      return;
    }
    intakeNfcStation.stop();
    intakeStarted = false;
    if (intakeAudio && typeof intakeAudio.close === "function") void intakeAudio.close().catch(() => {});
    intakeAudio = null;
    intakeSetState("ended");
    intakeSetMessage("Scanning ended. Press Start to resume when ready.", false);
    intakeUpdateControls();
  });
} else {
  intakeShowRuntimeIssue(intakeRuntimeIssue());
}

const intakeRecoverSelected = async () => {
  if (!intakeEnabled) return;
  intakeMachine.resetForEvent();
  if (!intakeCanProvision()) return;
  const pending = await intakeMachine.recover();
  intakeSetMessage(pending
    ? "A pending sticker is waiting. Press Start, then retap that same sticker."
    : "Press Start once, then tap one sticker per duck.", false);
};

// ---------------------------------------------------------------------------
// Event selection and page load
// ---------------------------------------------------------------------------
const applyRequestedSelection = async () => {
  if (requestedRaceEntryId) assignForm.elements.raceEntryId.value = requestedRaceEntryId;
  if (!requestedDuckId) return;
  const duckId = requestedDuckId;
  requestedDuckId = null;
  await loadDuckDetail(duckId, null, true).catch(() => {
    setMessage("That duck is no longer in inventory.", true);
  });
};

const loadEvents = async () => {
  const body = await api("/api/v1/staff/events", { headers: { accept: "application/json" } });
  eventSelect.replaceChildren();
  currentEvent = null;
  if (body.events.length === 0) {
    eventSelect.append(new Option("No event exists", ""));
    if (inventoryNoRace) inventoryNoRace.hidden = false;
  } else {
    for (const eventRecord of body.events) {
      eventSelect.append(new Option(eventRecord.name + " · " + humanize(eventRecord.status), eventRecord.id));
    }
    eventSelect.value = body.events[0].id;
    currentEvent = body.events[0];
    if (inventoryNoRace) inventoryNoRace.hidden = true;
  }
  await intakeRefreshStation();
  await intakeRecoverSelected();
  intakeUpdateControls();
  setMessage(currentEvent
    ? "Inventory is current."
    : "Inventory is current. Create the race event on the staff console to reserve ducks for it.");
};

eventSelect.addEventListener("change", () => {
  if (intakeStarted) return;
  loadEvents()
    .then(() => globalThis.quickDucksLive.markClean(eventSelect))
    .catch((error) => setMessage(error.message, true));
});

const inventoryRefresh = async () => {
  const duckId = selectedDuck && !inventoryDetail.hidden ? selectedDuck.id : null;
  await loadEvents();
  if (duckId) await loadDuckDetail(duckId).catch(() => inventoryDetailController.close({ restoreFocus: false }));
};

inventorySubscription = globalThis.quickDucksLive.subscribe({
  domains: ["event", "participants", "ducks", "heats"],
  root: inventoryRoot,
  refresh: inventoryRefresh,
  isBlocked: () => inventoryCommandCount > 0
    || intakeMachine?.isBusy() === true
    || intakeMachine?.hasPending() === true,
});

loadEvents()
  .then(applyRequestedSelection)
  .catch((error) => setMessage(error.message, true));
`;

// Heat roster deep links. A roster entry names the racer, shows the race-entry
// UUID that identifies it everywhere else in the console, and offers the two
// in-page navigations the actor's roles allow. The caller passes the element
// factory and the already role-checked actions, so this helper never decides
// permissions and never touches the network itself.
export const heatRosterHelpersScript = rosterEligibilityHelpersScript + String.raw`
const heatRosterParticipantName = (entry) => entry.participant.firstName + " " + entry.participant.lastName;

const heatRosterLinkButton = (text, label, action) => {
  const button = text("button", label, "button secondary small");
  button.type = "button";
  button.addEventListener("click", action);
  return button;
};

const createHeatRosterEntry = ({ entry, text, openParticipant, openDuck }) => {
  const participantName = heatRosterParticipantName(entry);
  const item = text("li", "", "roster-entry");
  item.append(text(
    "p",
    "Slot " + entry.slotNumber + " · " + participantName
      + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · No duck"),
    "roster-entry-line",
  ));
  item.append(text("p", "Race entry " + entry.raceEntryId, "roster-entry-id"));
  // Marked, never dropped: the console is where a race director reconciles the
  // bag, so the entry keeps its slot and states why it cannot win.
  rosterMarkIneligible(item, entry, "Cannot win", text);
  const actions = text("div", "", "actions");
  let linkCount = 0;
  if (openParticipant) {
    const button = heatRosterLinkButton(text, "Participant details · " + participantName, openParticipant);
    button.dataset.rosterParticipantLink = entry.raceEntryId;
    actions.append(button);
    linkCount += 1;
  }
  // A roster entry with no assigned duck offers no duck link at all.
  if (openDuck && entry.duck) {
    const button = heatRosterLinkButton(
      text,
      "Duck #" + entry.duck.visibleNumber + " in inventory",
      openDuck,
    );
    button.dataset.rosterDuckLink = entry.duck.id;
    actions.append(button);
    linkCount += 1;
  }
  if (linkCount > 0) item.append(actions);
  return item;
};
`;

export const staffHomeScript = eventLifecycleHelpersScript + eventSlugHelpersScript + timezonePickerHelpersScript + heatRosterHelpersScript + String.raw`
const operationsRoot = document.querySelector("[data-operations-root]");
const isSystemAdmin = operationsRoot.dataset.systemAdmin === "true";
const assignedRoles = new Set((operationsRoot.dataset.roles || "").split(",").filter(Boolean));
const hasRole = (role) => isSystemAdmin || assignedRoles.has(role);
const canRegistration = hasRole("REGISTRATION") || hasRole("RACE_DIRECTOR");
const canInventory = hasRole("DUCK_MANAGER") || hasRole("RACE_DIRECTOR");
const canRaceRead = hasRole("ANNOUNCER") || hasRole("HEAT_RUNNER") || hasRole("RESULT_TAKER") || hasRole("RACE_DIRECTOR");
const canDirectRace = hasRole("RACE_DIRECTOR");
const canRunHeat = hasRole("HEAT_RUNNER") || hasRole("RACE_DIRECTOR");
const canTakeResults = hasRole("RESULT_TAKER") || hasRole("RACE_DIRECTOR");
const consoleMessage = document.querySelector("[data-console-message]");
// This client runs on the Admin console and on the registration desk. Only the
// operations root and the working-event picker are required on both — every
// other surface below checks for its own markup before touching it, because one
// throw here silently kills every section after it.
const eventSelect = document.querySelector("[data-event-select]");
let currentEvent = null;
let currentEventDetail = null;
let selectedRegistration = null;
let selectedHeat = null;
let staffCommandCount = 0;
let staffLiveSubscription = null;

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

const humanize = (value) => String(value || "none").replaceAll("_", " ").toLowerCase()
  .replace(/^./, (character) => character.toUpperCase());

const setMessage = (message, isError = false, target = consoleMessage) => {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("error-text", isError);
};

const addFact = (container, label, value) => {
  const fact = text("div", "", "fact");
  fact.append(text("dt", label), text("dd", value == null || value === "" ? "None" : value));
  container.append(fact);
};

const showFacts = (container, facts) => {
  container.replaceChildren();
  for (const [label, value] of facts) addFact(container, label, value);
};

const empty = (message) => text("p", message, "empty-state");

const commandOptions = (method, payload) => ({
  method,
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const api = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff");
    throw new Error("signed-out");
  }
  let body = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed.");
  return body;
};

const perform = async (button, loadingMessage, operation) => {
  button.disabled = true;
  staffCommandCount += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  setMessage(loadingMessage);
  try {
    const result = await operation();
    globalThis.quickDucksLive.markClean(button.form);
    setMessage("Saved. Current data has been refreshed.");
    return result;
  } catch (error) {
    if (error.message !== "signed-out") setMessage(error.message, true);
    return null;
  } finally {
    button.disabled = false;
    staffCommandCount = Math.max(0, staffCommandCount - 1);
    endBusy();
    staffLiveSubscription?.resume();
  }
};

const currentEventId = () => {
  if (!currentEvent) throw new Error("Select an event first.");
  return currentEvent.id;
};

const randomPrivateToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const toLocalInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const fromLocalInput = (value) => value ? new Date(value).toISOString() : null;

const eventDetailRegion = document.querySelector("[data-event-detail]");
const eventEmptyState = document.querySelector("[data-event-empty]");
const eventCreateCard = document.querySelector("[data-event-create-card]");
const noRaceState = document.querySelector("[data-no-race]");
// Every event-scoped section and its console-nav anchor ships hidden, so the
// console never flashes work areas that a missing event would then remove.
// Role gating stays authoritative on top: a section the actor may not use
// stays hidden even once an event exists.
const eventScopedElements = document.querySelectorAll("[data-event-scoped]");
let consoleEventExists = false;
const showEventScopedSections = (eventExists) => {
  consoleEventExists = eventExists;
  for (const element of eventScopedElements) {
    element.hidden = !eventExists || element.dataset.roleAllowed === "false";
  }
  if (noRaceState) noRaceState.hidden = eventExists;
  // The console sections are also the Admin views, so exactly one of the
  // sections this pass just made available may actually be displayed. The
  // switcher has the final say on their hidden state.
  applyConsoleView(requestedConsoleView());
};

// --- Admin view switcher -----------------------------------------------------
// The Admin console is a menu bar over separate views, not one long page. The
// URL hash names the view, so a view is linkable, survives reload, and moves
// with browser back and forward. A view may only ever be shown when its own
// gating already allows it: role gating is fixed at render time and event
// scoping follows the loaded event, so the switcher can never reveal a section
// the actor is not allowed to see. When the requested view is unavailable it
// falls back to the first permitted, currently-available one.
//
// Pages that are not the console (the registration desk) render none of this
// markup, so every list here is simply empty and the switcher does nothing.
const consoleViewSections = [...document.querySelectorAll("[data-console-view]")];
const consoleViewLinks = [...document.querySelectorAll("[data-console-view-link]")];

const consoleViewAvailable = (section) => section.dataset.roleAllowed !== "false"
  && (!section.hasAttribute("data-event-scoped") || consoleEventExists);

const requestedConsoleView = () => {
  const hash = location.hash.replace(/^#/, "");
  return hash === "" ? null : hash;
};

const applyConsoleView = (requested) => {
  if (consoleViewSections.length === 0) return null;
  const available = consoleViewSections.filter(consoleViewAvailable);
  const target = available.find((section) => section.dataset.consoleView === requested)
    || available[0]
    || null;
  const activeView = target === null ? null : target.dataset.consoleView;
  for (const section of consoleViewSections) section.hidden = section !== target;
  for (const link of consoleViewLinks) {
    if (link.dataset.consoleViewLink === activeView) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  return activeView;
};

globalThis.addEventListener("hashchange", () => applyConsoleView(requestedConsoleView()));
applyConsoleView(requestedConsoleView());
const eventSummary = document.querySelector("[data-event-summary]");
const readinessList = document.querySelector("[data-event-readiness]");
const eventConfigCard = document.querySelector("[data-event-config-card]");
const eventConfigForm = document.querySelector("[data-event-config-form]");
const eventConfigSlugPreview = document.querySelector("[data-event-config-slug-preview]");
const forceDeleteCard = document.querySelector("[data-force-delete-card]");
const forceDeleteOpen = document.querySelector("[data-open-force-delete]");
const forceDeleteDialog = document.querySelector("[data-force-delete-dialog]");
const forceDeleteForm = document.querySelector("[data-force-delete-form]");
const forceDeleteEventName = document.querySelector("[data-force-delete-event-name]");
const forceDeleteMessage = document.querySelector("[data-force-delete-message]");
const forceDeleteCancel = document.querySelector("[data-cancel-force-delete]");
let forceDeleteBusy = false;

const closeForceDeleteDialog = () => {
  if (!forceDeleteBusy && forceDeleteDialog && forceDeleteDialog.open) forceDeleteDialog.close();
};

const resetForceDeleteDialog = () => {
  if (!forceDeleteForm) return;
  forceDeleteBusy = false;
  forceDeleteForm.reset();
  forceDeleteForm.elements.confirmName.disabled = false;
  forceDeleteForm.elements.confirmName.setCustomValidity("");
  forceDeleteForm.querySelector('button[type="submit"]').disabled = true;
  if (forceDeleteCancel) forceDeleteCancel.disabled = false;
  if (forceDeleteMessage) {
    forceDeleteMessage.textContent = "";
    forceDeleteMessage.classList.remove("error-text");
  }
};

// The device zone is resolved once and every timezone select is filled from the
// runtime zone list. The create form defaults to the detected zone; the config
// form is overwritten with the stored zone when an event loads.
const timezoneDetected = timezoneDetect();
const timezoneContext = { documentObject: document, detected: timezoneDetected };
for (const select of document.querySelectorAll("[data-timezone-select]")) {
  timezonePopulate(select, timezoneContext);
}

const updateEventSlugPreview = (form, preview, persistedEvent = null) => {
  if (!form || !preview) return;
  const name = String(form.elements.name.value).trim().replace(/\s+/g, " ");
  preview.value = !name
    ? ""
    : persistedEvent && name === persistedEvent.name
      ? persistedEvent.slug
      : eventSlugFromName(name);
};

// --- Heat-bag move instructions ---------------------------------------------
// Closing registration folds a short round-one tail heat into the heat before
// it, and reopening splits it back out. Both move ducks that are already sealed
// in numbered bags, and QuickDucks cannot move a bag, so the transition
// response reports what changed and this turns it into a physical instruction.
//
// It behaves like a job ticket rather than like a message: it is queued in
// localStorage, so it survives a reload, a view switch, and a live refresh, and
// only the Done button removes one. That is deliberate — walking to the bags is
// exactly the interval in which a page gets reloaded, and a physical task that
// disappears when the page repaints is a task that does not get done.
//
// The registration desk loads this same client and renders no callout, so every
// entry point checks the markup is present first.
const bagMove = document.querySelector("[data-bag-move]");
const bagMoveInstruction = document.querySelector("[data-bag-move-instruction]");
const bagMoveNumber = document.querySelector("[data-bag-move-number]");
const bagMoveDucks = document.querySelector("[data-bag-move-ducks]");
const bagMoveNote = document.querySelector("[data-bag-move-note]");
const bagMoveDismiss = document.querySelector("[data-bag-move-dismiss]");
const bagMoveStorageKey = "quickducks.bag-moves";

// The queue is read back out of localStorage, which anything on this origin can
// have written, so every field the copy interpolates is checked here rather than
// trusted. The duck numbers are checked element by element: they are printed
// straight into the instruction, and an object or a null there would put
// "Duck #[object Object]" in front of a staffer looking for a physical duck.
// Nothing here is a safety boundary — every field is written with textContent —
// it is simply the difference between a followable instruction and a nonsense
// one.
const bagMoveValid = (move) => Boolean(move)
  && typeof move.id === "string"
  && (move.action === "MERGE" || move.action === "SPLIT")
  && Number.isInteger(move.fromHeatNumber)
  && Number.isInteger(move.intoHeatNumber)
  && Array.isArray(move.duckNumbers)
  && move.duckNumbers.every((number) => Number.isInteger(number));

// Storage can be unavailable or hold something else entirely, and neither may
// take the console down; an unreadable queue is simply an empty one.
const bagMoveRead = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(bagMoveStorageKey) || "[]");
    return Array.isArray(stored) ? stored.filter(bagMoveValid) : [];
  } catch {
    return [];
  }
};

const bagMoveWrite = (moves) => {
  try {
    if (moves.length === 0) localStorage.removeItem(bagMoveStorageKey);
    else localStorage.setItem(bagMoveStorageKey, JSON.stringify(moves));
  } catch {}
};

const bagMoveCounted = (count, noun) => count + " " + noun + (count === 1 ? "" : "s");

// A staffer stands at the bags and counts what this line tells them to count, so
// the number and the list beside it must be the same thing. They are two
// different facts on the server: movedEntryCount counts roster places, while
// duckNumbers names the ducks that are physically in the bag, and a place
// whose duck assignment has ended is a racer with no duck to carry. Counting the
// places and then listing fewer ducks reads as "Move 2 ducks: Duck #5" and sends
// somebody hunting the bank for a duck that does not exist.
//
// So the instruction always counts exactly what it lists, and the roster
// difference is reported as the separate fact it is rather than folded into a
// number of ducks. Neither statement invents anything: both are read straight
// off the transition response.
const bagMoveDuckList = (move) => move.duckNumbers.length === 0
  ? "No ducks to carry"
  : bagMoveCounted(move.duckNumbers.length, "duck") + ": "
    + move.duckNumbers.map((number) => "Duck #" + number).join(", ");

const bagMoveEntryGap = (move) => {
  const entries = Number.isInteger(move.movedEntryCount) ? move.movedEntryCount : move.duckNumbers.length;
  const withoutDuck = Math.max(0, entries - move.duckNumbers.length);
  return withoutDuck === 0
    ? ""
    : " " + bagMoveCounted(withoutDuck, "racer") + " in this move " + (withoutDuck === 1 ? "has" : "have")
      + " no duck assigned right now, so there is nothing to carry for them.";
};

// Plain physical sentences. A merge pours one whole bag into another and needs
// no searching; a split takes named ducks back out of one, which is why the
// numbers are on screen.
const bagMoveCopy = (move) => {
  const from = "Heat " + move.fromHeatNumber;
  const into = "Heat " + move.intoHeatNumber;
  const arrow = from + " → " + into;
  if (move.action === "MERGE") {
    return {
      instruction: "Pour the " + from + " bag into the " + into + " bag",
      number: arrow,
      ducks: bagMoveDuckList(move),
      note: "Closing registration folded heat " + move.fromHeatNumber + " into heat "
        + move.intoHeatNumber + ", because heat " + move.fromHeatNumber
        + " had too few ducks to race. Empty the whole " + from + " bag into the " + into
        + " bag and put the empty bag away. No other bag changes, and no duck changes"
        + " position inside the " + into + " bag." + bagMoveEntryGap(move),
    };
  }
  return {
    instruction: move.duckNumbers.length === 0
      ? "No duck moves out of the " + from + " bag"
      : "Move " + bagMoveDuckList(move) + " from the " + from + " bag into a new " + into + " bag",
    number: arrow,
    ducks: bagMoveDuckList(move),
    note: "Reopening registration split heat " + move.intoHeatNumber + " back out of heat "
      + move.fromHeatNumber + ". " + (move.duckNumbers.length === 0
        ? "No duck in the " + from + " bag moves, and every bag stays exactly as it is."
        : "Take exactly those ducks out of the " + from
          + " bag, put them in a bag labelled " + into
          + ", and leave every other duck exactly where it is.") + bagMoveEntryGap(move),
  };
};

const renderBagMove = () => {
  if (!bagMove) return;
  const queued = bagMoveRead();
  if (queued.length === 0) {
    bagMove.hidden = true;
    return;
  }
  const copy = bagMoveCopy(queued[0]);
  // Reveal the live region before writing into it, so the announcement is a
  // change inside a region that is already in the accessibility tree.
  bagMove.hidden = false;
  bagMoveInstruction.textContent = copy.instruction;
  bagMoveNumber.textContent = copy.number;
  bagMoveDucks.textContent = copy.ducks;
  bagMoveNote.textContent = copy.note;
};

// The identifier is the lifecycle command that performed the move plus the
// move's position in it, so a retried or double-rendered response can never
// queue the same physical task twice.
const queueBagMoves = (moves, commandId) => {
  if (!bagMove || !Array.isArray(moves) || moves.length === 0) return;
  const queued = bagMoveRead();
  const known = new Set(queued.map((move) => move.id));
  for (const [index, move] of moves.entries()) {
    const queuedMove = { ...move, id: String(commandId) + ":" + index };
    if (!bagMoveValid(queuedMove) || known.has(queuedMove.id)) continue;
    known.add(queuedMove.id);
    queued.push(queuedMove);
  }
  bagMoveWrite(queued);
  renderBagMove();
};

// Deleting the event removes every heat and every roster, so the bags it named
// mean nothing any more and the queue goes with them.
const clearBagMoves = () => {
  if (!bagMove) return;
  bagMoveWrite([]);
  renderBagMove();
};

if (bagMove && bagMoveDismiss) {
  bagMoveDismiss.addEventListener("click", () => {
    bagMoveWrite(bagMoveRead().slice(1));
    renderBagMove();
  });
  renderBagMove();
}

const lifecycleLabels = {
  "open-registration": "Open registration",
  "close-registration": "Close registration",
  "reopen-registration": "Reopen registration",
  "start-round-one": "Start round one",
  "start-final": "Start final",
  complete: "Complete event",
};

const renderReadiness = (readiness) => {
  const event = currentEvent;
  // The registration desk loads this same client without the Event Details
  // view, so every surface checks that its own markup is on the page first. A
  // throw here would silently kill everything after it.
  if (!readinessList) return;
  readinessList.replaceChildren();
  for (const [action, state] of Object.entries(readiness)) {
    const presentation = lifecycleReadinessPresentation(state, event.status);
    const card = text("div", "", "data-card");
    card.append(text("h3", lifecycleLabels[action] || humanize(action)));
    card.append(text("span", presentation.chipText, presentation.chipClass));
    if (presentation.upcoming && state.requiresAdmin) card.append(text("span", "Administrator", "status-chip"));
    if (presentation.upcoming) for (const blocker of state.blockers) card.append(text("p", blocker, "muted"));
    // Notes are facts to know before committing, never reasons the transition is
    // refused, so they get their own informational treatment and are shown even
    // when the action is Ready. An older response without notes renders as it
    // did before rather than throwing.
    if (presentation.upcoming) {
      for (const note of Array.isArray(state.notes) ? state.notes : []) {
        card.append(text("p", note, "readiness-note"));
      }
    }
    if (presentation.upcoming && canDirectRace && (!state.requiresAdmin || isSystemAdmin)) {
      const button = text("button", lifecycleLabels[action] || humanize(action), "button small");
      button.type = "button";
      button.disabled = !state.allowed;
      const attempt = lifecycleCreateAttempt();
      button.addEventListener("click", async () => {
        if (
          event === null
          || eventSelect.value !== event.id
          || currentEvent === null
          || currentEvent.id !== event.id
          || currentEvent.status !== state.fromStatus
        ) {
          button.disabled = true;
          setMessage("This lifecycle action is stale. Refreshing the current event.", true);
          loadEvents(event && event.id).catch(() => undefined);
          return;
        }
        if (!await appConfirm("Run “" + button.textContent + "” for " + event.name + "?")) return;
        const commandId = attempt.begin();
        if (commandId === null) return;
        button.disabled = true;
        setMessage("Running event transition…");
        try {
          const result = await api(
            "/api/v1/staff/events/" + encodeURIComponent(event.id) + "/" + action,
            commandOptions("POST", { commandId }),
          );
          attempt.complete();
          // Before anything repaints: this is a physical task and it must be on
          // screen from the moment the transition is known to have committed.
          queueBagMoves(result.bagMoves, commandId);
          renderLifecycleResult(result.event);
          const savedMessage = result.replayed || result.alreadyAtTarget
            ? "This transition was already saved. Current state: " + humanize(result.event.status) + "."
            : "Transition saved. Current state: " + humanize(result.event.status) + ".";
          setMessage(savedMessage);
          try {
            await loadEvents(event.id);
            setMessage(savedMessage);
          } catch {
            setMessage(savedMessage + " Other operation areas could not refresh; refresh when the connection returns.", true);
          }
        } catch (error) {
          attempt.fail();
          try {
            await loadEvents(event.id);
          } catch {}
          const stateChanged = currentEvent !== null
            && currentEvent.id === event.id
            && currentEvent.status !== state.fromStatus;
          if (stateChanged) {
            attempt.complete();
            button.disabled = true;
            setMessage(currentEvent.status === state.toStatus
              ? "This transition is already saved. Current state: " + humanize(currentEvent.status) + "."
              : "Current state: " + humanize(currentEvent.status) + ". The stale action was not retried.");
            return;
          }
          button.disabled = attempt.disabled();
          if (error.message !== "signed-out") setMessage(error.message, true);
        }
      });
      card.append(button);
    }
    readinessList.append(card);
  }
};

const renderEvent = (detail, readiness) => {
  if (!lifecycleShouldRenderEvent(eventSelect.value, currentEvent, detail.event)) return false;
  currentEvent = detail.event;
  currentEventDetail = detail;
  renderWalkUpAvailability(detail.walkUpAdmission);
  if (eventSummary) showFacts(eventSummary, [
    ["Name", currentEvent.name],
    ["Status", humanize(currentEvent.status)],
    ["Date", currentEvent.eventDate || "Not set"],
    ["Timezone", currentEvent.timezone],
    ["Registrations", detail.summary.registrations],
    ["Reserved ducks", detail.summary.eventDucks],
    ["Round-one heats", detail.summary.roundOneHeats],
    ["Final heats", detail.summary.finalHeats],
  ]);
  renderReadiness(readiness.readiness);
  if (eventConfigCard) {
    eventConfigCard.hidden = currentEvent.status !== "DRAFT";
    eventConfigForm.elements.name.value = currentEvent.name;
    eventConfigForm.elements.eventDate.value = currentEvent.eventDate || "";
    timezoneApplyValue(eventConfigForm.elements.timezone, currentEvent.timezone, timezoneContext);
    eventConfigForm.elements.registrationOpensAt.value = toLocalInput(currentEvent.registrationOpensAt);
    eventConfigForm.elements.registrationClosesAt.value = toLocalInput(currentEvent.registrationClosesAt);
    eventConfigForm.elements.emailRequired.checked = currentEvent.emailRequired;
    eventConfigForm.elements.roundOneHeatCapacity.value = currentEvent.roundOneHeatCapacity;
    eventConfigForm.elements.finalHeatCapacity.value = currentEvent.finalHeatCapacity;
    eventConfigForm.elements.publicNamePolicy.value = currentEvent.publicNamePolicy;
    updateEventSlugPreview(eventConfigForm, eventConfigSlugPreview, currentEvent);
  }
  if (forceDeleteCard) {
    forceDeleteCard.hidden = false;
    forceDeleteForm.elements.confirmName.placeholder = currentEvent.name;
    forceDeleteEventName.textContent = currentEvent.name;
  }
  // QuickDucks holds one event dataset at a time, so a second create would be
  // refused anyway. The card is removed from the page rather than dimmed, and
  // the submit handler refuses too, so it can never be hidden but submittable.
  if (eventCreateCard) {
    eventCreateCard.open = false;
    eventCreateCard.hidden = true;
  }
  if (eventEmptyState) eventEmptyState.hidden = true;
  if (eventDetailRegion) eventDetailRegion.hidden = false;
  showEventScopedSections(true);
  return true;
};

const renderLifecycleResult = (event) => {
  if (currentEventDetail === null || currentEventDetail.event.id !== event.id) return false;
  const rendered = renderEvent({ ...currentEventDetail, event }, { readiness: {} });
  // Only renderReadiness can create the button that reaches here, and it
  // returns early when this element is missing, so today the guard can never
  // fire. It is still written, because every other surface on this client is
  // guarded the same way and one throw inside a console render silently kills
  // every control after it — the cost of being wrong is invisible and total.
  if (rendered && readinessList) readinessList.replaceChildren(empty("Refreshing lifecycle actions…"));
  return rendered;
};

const loadEvents = async (preferredId) => {
  const body = await api("/api/v1/staff/events", { headers: { accept: "application/json" } });
  eventSelect.replaceChildren();
  if (body.events.length === 0) {
    eventSelect.append(new Option("No event exists", ""));
    currentEvent = null;
    currentEventDetail = null;
    selectedRegistration = null;
    selectedHeat = null;
    renderWalkUpAvailability({
      allowed: false,
      reason: "Walk-up registration is unavailable until an event is ready for registration.",
    });
    if (eventSummary) eventSummary.replaceChildren(empty("Create a draft event to begin."));
    if (readinessList) readinessList.replaceChildren(empty("No lifecycle is available."));
    for (const selector of [
      "[data-participant-list]", "[data-heat-list]",
      "[data-finalist-list]", "[data-support-summary]",
      "[data-notification-list]", "[data-notification-attempts]", "[data-audit-list]",
      "[data-walkup-result]",
      "[data-participant-name]", "[data-participant-facts]", "[data-participant-actions]",
      "[data-heat-name]", "[data-heat-facts]", "[data-heat-roster]",
      "[data-heat-results]", "[data-heat-controls]",
    ]) document.querySelector(selector)?.replaceChildren();
    for (const selector of ["[data-participant-detail]", "[data-heat-detail]"]) {
      const element = document.querySelector(selector);
      if (element) element.hidden = true;
    }
    if (participantEditForm) participantEditForm.reset();
    if (eventConfigForm) {
      eventConfigForm.reset();
      eventConfigCard.hidden = true;
    }
    if (forceDeleteForm) {
      resetForceDeleteDialog();
      closeForceDeleteDialog();
      forceDeleteCard.hidden = true;
    }
    if (eventDetailRegion) eventDetailRegion.hidden = true;
    if (eventEmptyState) eventEmptyState.hidden = false;
    // No event: creating one is the only thing to do, so the card comes back
    // and opens itself. Deleting an event reaches this branch too, so the card
    // reappears without a manual reload.
    if (eventCreateCard) {
      eventCreateCard.hidden = false;
      eventCreateCard.open = true;
    }
    showEventScopedSections(false);
    clearBagMoves();
    setMessage("No event dataset exists. An administrator can create one.");
    return;
  }
  for (const eventRecord of body.events) {
    eventSelect.append(new Option(eventRecord.name + " · " + humanize(eventRecord.status), eventRecord.id));
  }
  const selectedId = preferredId && body.events.some((eventRecord) => eventRecord.id === preferredId)
    ? preferredId
    : currentEvent && body.events.some((eventRecord) => eventRecord.id === currentEvent.id)
      ? currentEvent.id
      : body.events[0].id;
  eventSelect.value = selectedId;
  await loadEvent(selectedId);
};

const loadEvent = async (eventId) => {
  setMessage("Loading selected event operations…");
  const detail = await api("/api/v1/staff/events/" + encodeURIComponent(eventId));
  const readiness = canRaceRead
    ? await api("/api/v1/staff/events/" + encodeURIComponent(eventId) + "/readiness")
    : { readiness: {} };
  if (!renderEvent(detail, readiness)) return;
  const loads = [];
  if (canRegistration) loads.push(loadParticipants(true));
  if (canRaceRead) loads.push(loadHeats(), loadFinalists());
  if (isSystemAdmin) loads.push(loadSupportSummary(), loadNotifications(), loadAudit());
  const results = await Promise.allSettled(loads);
  const failed = results.filter((result) => result.status === "rejected");
  setMessage(failed.length === 0
    ? "All operation areas are current."
    : failed.length + " operation area" + (failed.length === 1 ? " is" : "s are") + " temporarily unavailable.", failed.length > 0);
};

eventSelect.addEventListener("change", () => {
  if (eventSelect.value) loadEvent(eventSelect.value)
    .then(() => globalThis.quickDucksLive.markClean(eventSelect))
    .catch((error) => setMessage(error.message, true));
});
document.querySelector("[data-refresh-event]")?.addEventListener("click", () => {
  if (eventSelect.value) loadEvent(eventSelect.value).catch((error) => setMessage(error.message, true));
});

const eventCreateForm = document.querySelector("[data-event-create-form]");
const eventCreateSlugPreview = document.querySelector("[data-event-create-slug-preview]");
if (eventCreateForm) {
  eventCreateForm.elements.name.addEventListener("input", () => {
    updateEventSlugPreview(eventCreateForm, eventCreateSlugPreview);
  });
}
if (eventConfigForm) {
  eventConfigForm.elements.name.addEventListener("input", () => {
    updateEventSlugPreview(eventConfigForm, eventConfigSlugPreview, currentEvent);
  });
}
if (eventCreateForm) eventCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  // The card is removed from the page the moment an event exists; refusing here
  // as well means a stale or scripted submission cannot send a doomed command.
  if (currentEvent) {
    setMessage("An event already exists. Delete it before creating another.", true);
    return;
  }
  await perform(button, "Creating draft event…", async () => {
    const result = await api("/api/v1/staff/events", commandOptions("POST", {
      commandId: crypto.randomUUID(),
      name: String(values.get("name")),
      eventDate: String(values.get("eventDate")),
      timezone: String(values.get("timezone")),
      roundOneHeatCapacity: Number(values.get("roundOneHeatCapacity")),
    }));
    form.reset();
    updateEventSlugPreview(form, eventCreateSlugPreview);
    if (eventCreateCard) {
      eventCreateCard.open = false;
      eventCreateCard.hidden = true;
    }
    await loadEvents(result.event.id);
  });
});

if (eventConfigForm) eventConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Saving event configuration…", async () => {
    await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/configuration",
      commandOptions("PATCH", {
        commandId: crypto.randomUUID(),
        revision: currentEvent.revision,
        name: String(values.get("name")),
        eventDate: String(values.get("eventDate")) || null,
        timezone: String(values.get("timezone")),
        registrationOpensAt: fromLocalInput(String(values.get("registrationOpensAt"))),
        registrationClosesAt: fromLocalInput(String(values.get("registrationClosesAt"))),
        emailRequired: values.get("emailRequired") === "on",
        roundOneHeatCapacity: Number(values.get("roundOneHeatCapacity")),
        finalHeatCapacity: Number(values.get("finalHeatCapacity")),
        publicNamePolicy: String(values.get("publicNamePolicy")),
      }),
    );
    await loadEvents(currentEvent.id);
  });
});

if (forceDeleteOpen) forceDeleteOpen.addEventListener("click", () => {
  if (!currentEvent || !forceDeleteDialog || !forceDeleteForm) return;
  resetForceDeleteDialog();
  forceDeleteEventName.textContent = currentEvent.name;
  forceDeleteForm.elements.confirmName.placeholder = currentEvent.name;
  forceDeleteDialog.showModal();
  forceDeleteForm.elements.confirmName.focus();
});

if (forceDeleteCancel) forceDeleteCancel.addEventListener("click", closeForceDeleteDialog);
if (forceDeleteDialog) {
  forceDeleteDialog.addEventListener("click", (event) => {
    if (event.target === forceDeleteDialog) closeForceDeleteDialog();
  });
  forceDeleteDialog.addEventListener("cancel", (event) => {
    if (forceDeleteBusy) event.preventDefault();
  });
  forceDeleteDialog.addEventListener("close", () => {
    resetForceDeleteDialog();
    globalThis.quickDucksLive.markClean(forceDeleteForm);
  });
}
if (forceDeleteForm) forceDeleteForm.elements.confirmName.addEventListener("input", (event) => {
  const input = event.currentTarget;
  input.setCustomValidity("");
  forceDeleteForm.querySelector('button[type="submit"]').disabled = !currentEvent
    || input.value !== currentEvent.name;
  if (forceDeleteMessage) {
    forceDeleteMessage.textContent = "";
    forceDeleteMessage.classList.remove("error-text");
  }
});

if (forceDeleteForm) forceDeleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const input = form.elements.confirmName;
  const confirmName = String(new FormData(form).get("confirmName"));
  if (!currentEvent || confirmName !== currentEvent.name) {
    input.setCustomValidity("Type the exact event name to continue.");
    input.reportValidity();
    return;
  }
  forceDeleteBusy = true;
  button.disabled = true;
  input.disabled = true;
  forceDeleteCancel.disabled = true;
  if (forceDeleteMessage) {
    forceDeleteMessage.textContent = "Permanently deleting event…";
    forceDeleteMessage.classList.remove("error-text");
  }
  staffCommandCount += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/force-delete",
      commandOptions("POST", { commandId: crypto.randomUUID(), revision: currentEvent.revision, confirmName }),
    );
    location.assign("/staff");
  } catch (error) {
    if (error.message !== "signed-out" && forceDeleteMessage) {
      forceDeleteBusy = false;
      forceDeleteMessage.textContent = error.message;
      forceDeleteMessage.classList.add("error-text");
      input.disabled = false;
      forceDeleteCancel.disabled = false;
      button.disabled = false;
      input.focus();
    }
  } finally {
    staffCommandCount = Math.max(0, staffCommandCount - 1);
    endBusy();
    staffLiveSubscription?.resume();
  }
});

const participantFilterForm = document.querySelector("[data-participant-filter-form]");
const participantList = document.querySelector("[data-participant-list]");
const participantDetail = document.querySelector("[data-participant-detail]");
const participantFacts = document.querySelector("[data-participant-facts]");
const participantEditForm = document.querySelector("[data-participant-edit-form]");
const participantActions = document.querySelector("[data-participant-actions]");
const walkUpCard = document.querySelector("[data-walkup-card]");
const walkUpForm = document.querySelector("[data-walkup-form]");
const walkUpAvailability = document.querySelector("[data-walkup-availability]");
const walkUpGuide = document.querySelector("[data-walkup-guide]");
let currentWalkUpAdmission = { allowed: false, reason: "Checking walk-up availability…" };
let pendingWalkUpCommand = null;
// The participants surface is rendered by both the Admin console's Participants
// view and the registration desk, so it is always all-or-nothing on a page.
const participantsPresent = Boolean(participantFilterForm && participantList && participantDetail);

const renderWalkUpAvailability = (admission) => {
  if (!walkUpCard || !walkUpForm || !walkUpAvailability) return;
  const allowed = admission && admission.allowed === true;
  currentWalkUpAdmission = {
    allowed,
    reason: admission && typeof admission.reason === "string"
      ? admission.reason
      : "Walk-up availability could not be confirmed. Refresh before registering anyone.",
  };
  walkUpAvailability.textContent = currentWalkUpAdmission.reason;
  walkUpForm.hidden = !allowed;
  if (walkUpGuide) walkUpGuide.hidden = !allowed;
  const button = walkUpForm.querySelector('button[type="submit"]');
  if (button) button.disabled = !allowed;
  // A closed disclosure opens itself so the explanation is visible immediately;
  // the form and its action are removed from the interaction flow.
  if (!allowed) walkUpCard.open = true;
};

const participantQuery = () => {
  const values = new FormData(participantFilterForm);
  const parameters = new URLSearchParams({ limit: "200" });
  for (const name of ["q", "status", "createdVia", "assignment"]) {
    const value = String(values.get(name) || "");
    if (value) parameters.set(name, value);
  }
  return parameters;
};

// The open participant is marked in the list so staff can see what the detail
// card belongs to, and so the row they press again is obviously the one they
// are putting down.
const markParticipantSelection = () => {
  if (!participantsPresent) return;
  const openId = selectedRegistration === null ? null : selectedRegistration.registrationId;
  for (const button of participantList.querySelectorAll("[data-registration-id]")) {
    const isOpen = button.dataset.registrationId === openId;
    button.className = isOpen ? "result-button is-selected" : "result-button";
    button.setAttribute("aria-pressed", isOpen ? "true" : "false");
  }
};

const toggleParticipantDetail = (registrationId) => {
  // Pressing the open participant again closes it. Staff read a row, decide it
  // is not the person, and want the card out of the way without picking a
  // different one.
  if (selectedRegistration !== null && selectedRegistration.registrationId === registrationId) {
    clearParticipantDetail();
    markParticipantSelection();
    return;
  }
  loadParticipantDetail(registrationId)
    .then(markParticipantSelection)
    .catch((error) => setMessage(error.message, true));
};

// The pruneSelection flag is set by the explicit list reloads — the "List
// participants" button and the filter form. If the open participant is not in
// the list the operator just asked for, the detail card is stale, so it clears
// and hides instead of describing someone the list no longer shows.
const loadParticipants = async (pruneSelection = false) => {
  if (!currentEvent || !participantsPresent) return;
  const body = await api(
    "/api/v1/staff/events/" + encodeURIComponent(currentEvent.id) + "/registrations?" + participantQuery(),
  );
  participantList.replaceChildren();
  if (body.registrations.length === 0) participantList.append(empty("No participants match these filters."));
  for (const registration of body.registrations) {
    const button = text(
      "button",
      registration.firstName + " " + registration.lastName + " · " + registration.lookupCode
        + " · " + humanize(registration.status)
        + (registration.assignment ? " · Duck #" + registration.assignment.duck.visibleNumber : " · Unassigned"),
      "result-button",
    );
    button.type = "button";
    button.dataset.registrationId = registration.registrationId;
    button.addEventListener("click", () => toggleParticipantDetail(registration.registrationId));
    participantList.append(button);
  }
  if (
    pruneSelection
    && selectedRegistration !== null
    && !body.registrations.some((registration) => registration.registrationId === selectedRegistration.registrationId)
  ) {
    clearParticipantDetail();
  }
  markParticipantSelection();
};

const addParticipantAction = (label, className, action) => {
  const button = text("button", label, className);
  button.type = "button";
  button.addEventListener("click", action);
  participantActions.append(button);
};

const changeParticipantStatus = async (operation, label, dangerous, button) => {
  if (dangerous && !await appConfirm(label + " for " + selectedRegistration.firstName + " " + selectedRegistration.lastName + "?", { danger: true })) return;
  await perform(button, label + "…", async () => {
    const result = await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(selectedRegistration.registrationId) + "/" + operation,
      commandOptions("POST", { commandId: crypto.randomUUID(), expectedRevision: selectedRegistration.revision }),
    );
    selectedRegistration = result.registration;
    renderParticipantDetail(selectedRegistration);
    await loadParticipants();
  });
};

// The projection answers two different questions, and the console needs both.
//
// deletable is the only thing that may decide whether Delete is rendered. It is
// the exact predicate the delete endpoint re-checks inside its guarded write:
// never paired at all — no assignment row, current or already ended — no heat
// place, and a deletable event status. A projection served before those fields
// existed reports undefined, and the safe reading of that is "not deletable":
// refusing a delete that would have worked costs a page refresh, while offering
// one the server refuses is a 409 in a staffer's face on race day.
const participantIsDeletable = (registration) => registration.deletable === true;

// currentlyPaired is the narrower, physical question — is a duck in this
// participant's hands right now — and it is the only thing that may be used to
// say a duck is sealed in a heat bag. It is not the same question as deletable:
// a participant whose duck was later unassigned is not currently paired and is
// still not deletable, because the ended assignment row proves their duck went
// into a bag. Status does not answer either question, because a reactivated
// participant can be SUBMITTED while still holding their duck.
//
// The explicit boolean wins; an older projection falls back to the assignment
// object it is defined to be exactly equivalent to.
const participantIsCurrentlyPaired = (registration) => registration.currentlyPaired === true
  || (registration.currentlyPaired === undefined
    && registration.assignment !== null && registration.assignment !== undefined);

// The bagged duck's number, or null when this render cannot prove one. Rendering
// runs inside no try block, so a projection without the nested duck must degrade
// to slightly vaguer wording rather than throw and silently drop every control
// after it.
const participantPairedDuckNumber = (registration) => {
  if (!participantIsCurrentlyPaired(registration)) return null;
  const assignment = registration.assignment;
  if (!assignment || !assignment.duck) return null;
  const visibleNumber = assignment.duck.visibleNumber;
  return typeof visibleNumber === "number" ? visibleNumber : null;
};

// The Duck fact reads through the same guard, so an assignment without a
// readable duck number degrades to a plain word instead of throwing part-way
// through the fact list and taking every action below it with it.
const participantDuckFact = (registration) => {
  const duckNumber = participantPairedDuckNumber(registration);
  if (duckNumber !== null) return "#" + duckNumber;
  return participantIsCurrentlyPaired(registration) ? "Paired" : "Unassigned";
};

// The event statuses the delete endpoint accepts at all, mirroring
// DELETABLE_EVENT_STATUSES in registration.ts. Outside them nothing about the
// participant is the reason — the race itself is — and saying anything about
// heat bags there would be false about someone who has never held a duck.
const PARTICIPANT_DELETABLE_EVENT_STATUSES = [
  "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED",
];

// True only when the console can positively see a race whose status forbids
// deletion. An unknown or not-yet-loaded event is not evidence of anything, so
// it falls through to the participant-shaped reasons rather than blaming a race
// state nobody has confirmed.
const participantEventBlocksDeletion = () => Boolean(currentEvent)
  && typeof currentEvent.status === "string"
  && !PARTICIPANT_DELETABLE_EVENT_STATUSES.includes(currentEvent.status);

// One sentence for the one participant who is being told they cannot be deleted.
// Each branch is a separate fact, and claiming the wrong one is a lie a staffer
// acts on. In order of what the console can actually prove:
//
//   1. the race's own status forbids deleting any registration;
//   2. this participant holds a duck that is already in a numbered heat bag;
//   3. this participant holds a duck that has no heat, and therefore no bag,
//      yet — the same heatAssignmentPending state the pairing callout refuses
//      to invent a bag number for;
//   4. this participant has been in the race before: an ended assignment or a
//      heat place, either of which the delete endpoint refuses on.
//
// A duck is never described as bagged unless a heat is genuinely holding it.
const participantUndeletableReason = (registration) => {
  if (participantEventBlocksDeletion()) {
    return "Registrations cannot be deleted while this race is " + humanize(currentEvent.status).toLowerCase()
      + ". Withdraw or disqualify only makes this participant ineligible to be counted as a winner.";
  }
  const duckNumber = participantPairedDuckNumber(registration);
  const duckLabel = duckNumber === null ? "This participant's duck" : "Duck #" + duckNumber;
  if (participantIsCurrentlyPaired(registration) && registration.heatAssignmentPending === true) {
    return duckLabel + " is paired with this participant but has no heat yet, so there is no bag it can go"
      + " into. Ask the race director which heat it belongs to. Withdraw or disqualify only makes this"
      + " participant ineligible to be counted as a winner; the registration cannot be deleted.";
  }
  if (participantIsCurrentlyPaired(registration)) {
    return duckLabel + " is already sealed in a heat bag, so it stays in the race. Withdraw or disqualify"
      + " only makes this participant ineligible to be counted as a winner; the registration cannot be"
      + " deleted.";
  }
  return "This participant has already been in the race — their duck went into a heat bag, or they hold a"
    + " place on a heat roster — so the registration cannot be deleted. Withdraw or disqualify only makes"
    + " them ineligible to be counted as a winner.";
};

const clearParticipantDetail = () => {
  selectedRegistration = null;
  participantDetail.hidden = true;
  participantFacts.replaceChildren();
  participantActions.replaceChildren();
  document.querySelector("[data-participant-name]").textContent = "Participant detail";
  participantEditForm.reset();
};

const deleteParticipant = async (button) => {
  const registration = selectedRegistration;
  if (!await appConfirm("Permanently delete the registration for " + registration.firstName + " " + registration.lastName + "? This removes the participant and their race entry. This cannot be undone.", { danger: true })) return;
  await perform(button, "Deleting registration…", async () => {
    await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(registration.registrationId),
      commandOptions("DELETE", { commandId: crypto.randomUUID(), expectedRevision: registration.revision }),
    );
    clearParticipantDetail();
    await loadParticipants();
  });
};

// The duck name is participant-written text that is shown publicly, so staff
// see exactly what is stored and whether the read-time filter is already hiding
// it. It is rendered through the shared safe text helper, so a hostile name can
// only ever be text on this page.
const participantDuckNameFact = (registration) => {
  if (typeof registration.duckName !== "string" || registration.duckName.length === 0) {
    return "Not named";
  }
  return registration.duckNamePubliclyHidden === true
    ? registration.duckName + " (already hidden from public surfaces)"
    : registration.duckName;
};

// Staff naming at the registration desk, for a participant who cannot do it
// themselves. The endpoint runs exactly the gates the public one runs, so a 422
// here means the name itself was refused and nothing was written.
const participantDuckNameForm = document.querySelector("[data-participant-duck-name-form]");

const saveParticipantDuckName = async (button, duckName) => {
  const registration = selectedRegistration;
  await perform(button, "Saving duck name…", async () => {
    const result = await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(registration.registrationId) + "/set-duck-name",
      commandOptions("POST", { commandId: crypto.randomUUID(), duckName }),
    );
    selectedRegistration = result.registration;
    renderParticipantDetail(selectedRegistration);
    await loadParticipants();
  });
};

const clearParticipantDuckName = async (button) => {
  const registration = selectedRegistration;
  if (!await appConfirm(
    "Clear the duck name chosen by " + registration.firstName + " " + registration.lastName
    + "? The duck goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;
  await perform(button, "Clearing duck name…", async () => {
    const result = await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(registration.registrationId) + "/clear-duck-name",
      commandOptions("POST", { commandId: crypto.randomUUID() }),
    );
    selectedRegistration = result.registration;
    renderParticipantDetail(selectedRegistration);
    await loadParticipants();
  });
};

const renderParticipantDetail = (registration) => {
  selectedRegistration = registration;
  participantDetail.hidden = false;
  document.querySelector("[data-participant-name]").textContent = registration.firstName + " " + registration.lastName;
  showFacts(participantFacts, [
    ["Status", humanize(registration.status)],
    ["Lookup code", registration.lookupCode],
    ["Email", registration.email || "Not provided"],
    ["Phone", registration.phone || "Not provided"],
    ["Created via", humanize(registration.createdVia)],
    ["Duck", participantDuckFact(registration)],
    ["Duck name", participantDuckNameFact(registration)],
    ["Race entry", registration.raceEntryId],
    ["Revision", registration.revision],
  ]);
  participantEditForm.elements.firstName.value = registration.firstName;
  participantEditForm.elements.lastName.value = registration.lastName;
  participantEditForm.elements.email.value = registration.email || "";
  participantEditForm.elements.phone.value = registration.phone || "";
  participantEditForm.elements.notes.value = registration.notes || "";
  // Naming needs a duck to name *now*, and the endpoint refuses without a
  // current assignment, so this is the pairing question rather than the
  // deletable one.
  if (participantDuckNameForm) {
    participantDuckNameForm.hidden = !canRegistration || !participantIsCurrentlyPaired(registration);
    participantDuckNameForm.elements.duckName.value = registration.duckName || "";
  }
  participantActions.replaceChildren();
  // Offered only when there is a name to clear. The server enforces the role.
  if (canRegistration && typeof registration.duckName === "string" && registration.duckName.length > 0) {
    addParticipantAction(
      "Clear duck name",
      "button danger small",
      (event) => clearParticipantDuckName(event.currentTarget),
    );
  }
  // Inventory is its own page, so this hands the race entry to it rather than
  // scrolling to a section that is no longer here.
  if (canInventory) {
    addParticipantAction("Use for duck assignment", "button secondary small", () => {
      location.assign("/staff/inventory?raceEntry=" + encodeURIComponent(registration.raceEntryId));
    });
  }
  // The deletable projection decides one thing only: whether Delete exists.
  // The two halves below are exhaustive and mutually exclusive, and Delete
  // appears in exactly one of them, so nobody who has been in the race can ever
  // be offered it.
  const deletable = participantIsDeletable(registration);
  // --- Not deletable: no Delete, and one plain sentence saying why not. ---
  if (!deletable) {
    const note = text("p", participantUndeletableReason(registration), "muted participant-action-note");
    note.dataset.participantActionNote = "";
    participantActions.append(note);
  }
  // Leaving the race is a different question from deleting the registration,
  // and it is asked of everyone the server accepts it for. A never-paired
  // no-show is withdrawn like anyone else; offering them only Delete would make
  // destroying the registration the sole way to record that they did not turn
  // up, and would lose the person who registered.
  if (["SUBMITTED", "ACTIVE"].includes(registration.status)) {
    addParticipantAction("Withdraw", "button danger small", (event) => changeParticipantStatus("withdraw", "Withdraw participant", true, event.currentTarget));
    if (canDirectRace) addParticipantAction("Disqualify", "button danger small", (event) => changeParticipantStatus("disqualify", "Disqualify participant", true, event.currentTarget));
  }
  if (canDirectRace && ["WITHDRAWN", "DISQUALIFIED"].includes(registration.status)) {
    addParticipantAction("Reactivate", "button small", async (event) => {
      const button = event.currentTarget;
      if (!await appConfirm("Reactivate this participant?")) return;
      perform(button, "Reactivating participant…", async () => {
        const result = await api(
          "/api/v1/staff/registrations/" + encodeURIComponent(selectedRegistration.registrationId) + "/reactivate",
          commandOptions("POST", { commandId: crypto.randomUUID(), expectedRevision: selectedRegistration.revision }),
        );
        selectedRegistration = result.registration;
        renderParticipantDetail(selectedRegistration);
        await loadParticipants();
      });
    });
  }
  // --- Deletable: the server would accept a delete right now, and this is the
  // only branch that renders it. ---
  if (deletable) {
    addParticipantAction("Delete registration", "button danger small", (event) => deleteParticipant(event.currentTarget));
  }
};

const loadParticipantDetail = async (registrationId) => {
  const body = await api("/api/v1/staff/registrations/" + encodeURIComponent(registrationId));
  renderParticipantDetail(body.registration);
};

participantFilterForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  loadParticipants(true)
    .then(() => globalThis.quickDucksLive.markClean(participantFilterForm))
    .catch((error) => setMessage(error.message, true));
});

walkUpForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const resultTarget = document.querySelector("[data-walkup-result]");
  if (!currentWalkUpAdmission.allowed) {
    resultTarget.textContent = currentWalkUpAdmission.reason;
    return;
  }
  const values = new FormData(form);
  pendingWalkUpCommand ??= { commandId: crypto.randomUUID(), privateToken: randomPrivateToken() };
  await perform(button, "Creating walk-up registration…", async () => {
    const { commandId, privateToken } = pendingWalkUpCommand;
    const result = await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/registrations",
      commandOptions("POST", {
        commandId,
        privateToken,
        firstName: String(values.get("firstName")),
        lastName: String(values.get("lastName")),
        email: String(values.get("email")) || null,
        phone: String(values.get("phone")) || null,
        emailNotificationsEnabled: false,
        notes: String(values.get("notes")) || null,
        clientTimestamp: new Date().toISOString(),
      }),
    );
    const link = text("a", "Open private participant status");
    link.href = result.privateStatusPath;
    link.target = "_blank";
    link.rel = "noopener";
    resultTarget.replaceChildren(text("strong", "Lookup code: " + result.registration.lookupCode + " · "), link);
    pendingWalkUpCommand = null;
    form.reset();
    await loadParticipants();
    renderParticipantDetail(result.registration);
  });
  if (!currentWalkUpAdmission.allowed) button.disabled = true;
});

participantEditForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Saving participant details…", async () => {
    const result = await api(
      "/api/v1/staff/registrations/" + encodeURIComponent(selectedRegistration.registrationId),
      commandOptions("PATCH", {
        commandId: crypto.randomUUID(),
        expectedRevision: selectedRegistration.revision,
        firstName: String(values.get("firstName")),
        lastName: String(values.get("lastName")),
        email: String(values.get("email")) || null,
        phone: String(values.get("phone")) || null,
        emailNotificationsEnabled: false,
        notes: String(values.get("notes")) || null,
      }),
    );
    renderParticipantDetail(result.registration);
    await loadParticipants();
  });
});

if (participantDuckNameForm) {
  participantDuckNameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await saveParticipantDuckName(
      form.querySelector("button"),
      String(new FormData(form).get("duckName") || ""),
    );
  });
}

// A small card for one history or summary line. It reads as a heading and a
// muted detail, and every value reaches it as text.
const historyCard = (title, detail) => {
  const card = text("div", "", "data-card");
  card.append(text("h3", title), text("p", detail, "muted"));
  return card;
};

// A participant deep link from the heat roster switches the Admin view, so it
// goes through the hash exactly like the menu bar does. That keeps one code
// path for switching and leaves the jump in browser history.
const revealConsoleSection = (view) => {
  const section = document.getElementById(view);
  if (consoleViewSections.some((candidate) => candidate.dataset.consoleView === view)) {
    if (location.hash === "#" + view) applyConsoleView(view);
    else location.hash = view;
  }
  if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  return section;
};

const openRosterParticipant = async (registrationId) => {
  revealConsoleSection("participants");
  await loadParticipantDetail(registrationId);
  participantDetail.focus();
};

// Inventory is its own page now, so a roster duck link is a real navigation
// that asks that page to open this duck.
const openRosterDuck = (duckId) => {
  location.assign("/staff/inventory?duck=" + encodeURIComponent(duckId));
};

const heatList = document.querySelector("[data-heat-list]");
const heatDetail = document.querySelector("[data-heat-detail]");
const heatFacts = document.querySelector("[data-heat-facts]");
const heatRoster = document.querySelector("[data-heat-roster]");
const heatResults = document.querySelector("[data-heat-results]");
const heatControls = document.querySelector("[data-heat-controls]");
const finalistList = document.querySelector("[data-finalist-list]");
const finalistCard = document.querySelector("[data-finalist-card]");

const loadHeats = async () => {
  if (!currentEvent || !heatList) return;
  const body = await api("/api/v1/staff/events/" + encodeURIComponent(currentEvent.id) + "/heats");
  heatList.replaceChildren();
  if (body.heats.length === 0) {
    heatList.append(empty("No heats have been created."));
    heatDetail.hidden = true;
    selectedHeat = null;
    return;
  }
  for (const heat of body.heats) {
    const button = text("button", humanize(heat.round) + " · Heat " + heat.number + " · " + humanize(heat.status) + " · " + heat.rosterSize + " ducks", "result-button");
    button.type = "button";
    button.addEventListener("click", () => loadHeatDetail(heat.id).catch((error) => setMessage(error.message, true)));
    heatList.append(button);
  }
  const selectedId = selectedHeat && body.heats.some((heat) => heat.id === selectedHeat.id) ? selectedHeat.id : body.heats[0].id;
  await loadHeatDetail(selectedId);
};

// The roster editor is offered in exactly the window PUT /heats/:id/roster
// accepts: an unlocked planned heat whose round has not started yet, which is
// registration-closed for a round-one heat and round one for the final. Outside
// that window every submission would 409, so the form is not rendered at all.
const rosterEditableEventStatus = { ROUND_ONE: "REGISTRATION_CLOSED", FINAL: "ROUND_ONE" };

const rosterFormAllowed = (heat, event) => Boolean(canDirectRace)
  && heat.status === "PLANNED" && !heat.rosterLocked
  && Boolean(event) && event.status === rosterEditableEventStatus[heat.round];

const addRosterForm = (body) => {
  if (!rosterFormAllowed(body.heat, currentEvent)) return;
  const details = text("details", "", "operation-card");
  details.append(text("summary", "Replace unlocked roster"));
  const form = document.createElement("form");
  const label = text("label", "Race-entry IDs, one per line in slot order");
  const input = document.createElement("textarea");
  input.required = true;
  input.value = body.roster.map((entry) => entry.raceEntryId).join("\n");
  label.append(input);
  const button = text("button", "Replace roster", "button secondary");
  button.type = "submit";
  form.append(label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raceEntryIds = input.value.split(/\s+/).map((value) => value.trim()).filter(Boolean);
    await perform(button, "Replacing heat roster…", async () => {
      await api(
        "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/roster",
        commandOptions("PUT", { commandId: crypto.randomUUID(), revision: selectedHeat.revision, raceEntryIds }),
      );
      await loadHeats();
    });
  });
  details.append(form);
  heatControls.append(details);
};

const heatResetAllowed = (heat) => Boolean(canDirectRace)
  && ["READY", "CALLING", "RUNNING", "AWAITING_RESULT"].includes(heat.status)
  && heat.rosterLocked && heat.rosterSize > 0 && heat.publishedResultCount === 0;

// The one place the console names a winner, used for the FINAL finalize, the
// FINAL correction, and the ROUND_ONE correction alike.
//
// Only the racers who can still take a place are selectable, and the podium is
// only as deep as there are of them, because that is exactly what the server's
// result validation requires. Offering the whole roster contradicts the heat
// roster directly above — which now marks the same racers "Cannot win" — and
// hands the race director a 422 on race day. The roster list itself is
// unchanged: staff still see every entry, marked, because the ducks are all
// still in the bag.
const resultForm = (body, mode) => {
  const form = text("form", "", "operation-card");
  form.append(text("h3", mode === "finalize" ? "Finalize result" : "Correct published result"));
  const eligibleRoster = rosterEligibleEntries(body.roster);
  // No eligible racer at all: there is no result to publish and no honest form
  // to render, so the card says so rather than showing empty, unsubmittable
  // selects the server would refuse.
  if (eligibleRoster.length === 0) {
    form.append(empty("Every racer in this heat is withdrawn or disqualified, so no result can be recorded."
      + " Reactivate the racer who should hold the place, then publish the result."));
    return form;
  }
  if (mode === "correct") {
    const reasonLabel = text("label", "Correction reason");
    const reason = document.createElement("input");
    reason.name = "reason";
    reason.minLength = 4;
    reason.maxLength = 500;
    reason.required = true;
    reasonLabel.append(reason);
    form.append(reasonLabel);
  }
  const places = body.heat.round === "ROUND_ONE"
    ? [1]
    : Array.from({ length: Math.min(3, eligibleRoster.length) }, (_, index) => index + 1);
  const selects = [];
  for (const place of places) {
    const label = text("label", place === 1 ? "First place" : place === 2 ? "Second place" : "Third place");
    const select = document.createElement("select");
    select.required = true;
    select.append(new Option("Choose roster entry", ""));
    for (const entry of eligibleRoster) {
      select.append(new Option(
        entry.participant.firstName + " " + entry.participant.lastName + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : ""),
        entry.raceEntryId,
      ));
    }
    // A published place whose racer has since left is deliberately not
    // preselected: that name is no longer on offer, so preselecting it would
    // either silently fall back to nothing or, worse, look chosen. The director
    // is made to name someone the server will actually accept.
    const published = body.results.find((result) => result.place === place);
    if (published && eligibleRoster.some((entry) => entry.raceEntryId === published.raceEntryId)) {
      select.value = published.raceEntryId;
    }
    label.append(select);
    form.append(label);
    selects.push([place, select]);
  }
  const button = text("button", mode === "finalize" ? "Publish final result" : "Publish corrected result", mode === "finalize" ? "button" : "button danger");
  button.type = "submit";
  form.append(button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const readback = selects.map(([place, select]) => {
      const label = place === 1 ? "First place" : place === 2 ? "Second place" : "Third place";
      return label + ": " + (select.selectedOptions[0]?.textContent || "not selected");
    }).join("; ");
    const action = mode === "finalize" ? "Publish this official result now" : "Replace the official result now";
    if (!await appConfirm(action + "? Read back: " + readback + ". This changes the public result immediately.", { danger: mode === "correct" })) return;
    const payload = {
      commandId: crypto.randomUUID(), revision: selectedHeat.revision,
      results: selects.map(([place, select]) => ({ raceEntryId: select.value, place })),
    };
    if (mode === "correct") payload.reason = form.elements.reason.value;
    await perform(button, "Saving official result…", async () => {
      await api(
        "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/results/" + mode,
        commandOptions("POST", payload),
      );
      await Promise.all([loadEvents(currentEvent.id), loadFinalists()]);
    });
  });
  return form;
};

const renderHeatControls = (body) => {
  heatControls.replaceChildren();
  // No lock control: starting the round locks every roster in one guarded
  // command, so PLANNED offers nothing for an operator to press here.
  const transition = {
    LOADING: ["ready", "Mark Heat Ready"], READY: ["call", "Heat Has Been Announced"],
    CALLING: ["start", "Start This Heat"], RUNNING: ["finish", "Finish heat"],
  }[body.heat.status];
  const canTransition = transition && (transition[0] === "finish" ? canTakeResults : canRunHeat);
  if (canTransition) {
    const button = text("button", transition[1], "button small");
    button.type = "button";
    button.addEventListener("click", async () => {
      const confirmation = transition[0] === "start"
        ? "Start " + humanize(body.heat.round) + " Heat " + body.heat.number + " now? Read back: "
          + body.roster.length + " racer" + (body.roster.length === 1 ? "" : "s")
          + ". No next heat can start until this heat's official result is published."
        : transition[1] + "?";
      if (!await appConfirm(confirmation)) return;
      await perform(button, transition[1] + "…", async () => {
        await api(
          "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/" + transition[0],
          commandOptions("POST", { commandId: crypto.randomUUID(), revision: selectedHeat.revision }),
        );
        await loadHeats();
      });
    });
    heatControls.append(button);
  }
  if (heatResetAllowed(body.heat)) {
    const resetButton = text("button", "Reset Heat", "button danger small");
    resetButton.type = "button";
    resetButton.addEventListener("click", async () => {
      if (!await appConfirm(
        "Reset this heat to Loading? Its locked roster and lock details will remain. Start and finish progress and any unsubmitted result entry will be cleared.",
        { danger: true, confirmLabel: "Reset Heat" },
      )) return;
      await perform(resetButton, "Resetting heat…", async () => {
        await api(
          "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/reset",
          commandOptions("POST", { commandId: crypto.randomUUID(), revision: selectedHeat.revision }),
        );
        await loadHeats();
      });
    });
    heatControls.append(resetButton);
  }
  addRosterForm(body);
  if (canTakeResults && body.heat.status === "AWAITING_RESULT" && body.heat.round === "FINAL") {
    heatControls.append(resultForm(body, "finalize"));
  }
  if (canDirectRace && body.heat.status === "FINALIZED" && body.results.length > 0) {
    if (body.heat.resultCorrectionAllowed) heatControls.append(resultForm(body, "correct"));
    if (!body.heat.resultReopenAllowed) return;
    const reopenForm = text("form", "", "operation-card danger-zone");
    const label = text("label", "Reason to reopen result");
    const reason = document.createElement("input");
    reason.minLength = 4;
    reason.maxLength = 500;
    reason.required = true;
    label.append(reason);
    const button = text("button", "Reopen result", "button danger");
    button.type = "submit";
    reopenForm.append(label, button);
    reopenForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!await appConfirm("Reopen this published result and remove downstream finalist promotion when applicable?", { danger: true })) return;
      await perform(button, "Reopening result…", async () => {
        await api(
          "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/results/reopen",
          commandOptions("POST", { commandId: crypto.randomUUID(), revision: selectedHeat.revision, reason: reason.value }),
        );
        await Promise.all([loadEvents(currentEvent.id), loadFinalists()]);
      });
    });
    heatControls.append(reopenForm);
  }
};

const loadHeatDetail = async (heatId) => {
  const body = await api("/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(heatId));
  selectedHeat = body.heat;
  heatDetail.hidden = false;
  document.querySelector("[data-heat-name]").textContent = humanize(body.heat.round) + " · Heat " + body.heat.number;
  showFacts(heatFacts, [["Status", humanize(body.heat.status)], ["Roster", body.heat.rosterSize], ["Published results", body.heat.publishedResultCount], ["Revision", body.heat.revision]]);
  heatRoster.replaceChildren();
  // Each link is offered only to an actor whose roles can open that section,
  // which is the same gating the target APIs enforce.
  for (const entry of body.roster) {
    heatRoster.append(createHeatRosterEntry({
      entry,
      text,
      openParticipant: canRegistration && entry.participant.registrationId
        ? () => openRosterParticipant(entry.participant.registrationId)
          .catch((error) => setMessage(error.message, true))
        : null,
      openDuck: canInventory && entry.duck && entry.duck.id
        ? () => openRosterDuck(entry.duck.id)
        : null,
    }));
  }
  if (body.roster.length === 0) heatRoster.append(empty("This heat has no roster entries."));
  heatResults.replaceChildren();
  // A published place whose racer has since left stays published — nothing is
  // reordered — but the card says plainly that it can no longer stand as a win.
  for (const result of body.results) {
    const card = historyCard("Place " + result.place + " · Duck #" + result.duck.visibleNumber, result.participant.firstName + " " + result.participant.lastName);
    rosterMarkIneligible(card, result, "Cannot win", text);
    heatResults.append(card);
  }
  if (body.results.length === 0) heatResults.append(empty("No result has been published."));
  renderHeatControls(body);
};

document.querySelector("[data-refresh-heats]")?.addEventListener("click", () => loadHeats().catch((error) => setMessage(error.message, true)));

const finalistsExist = () => ["ROUND_ONE", "FINAL", "COMPLETED"].includes(currentEvent?.status);

const loadFinalists = async () => {
  if (!currentEvent || !finalistCard || !finalistList) return;
  finalistCard.hidden = !finalistsExist();
  if (finalistCard.hidden) {
    finalistList.replaceChildren();
    return;
  }
  const body = await api("/api/v1/staff/events/" + encodeURIComponent(currentEvent.id) + "/finalists");
  finalistList.replaceChildren();
  for (const finalist of body.finalists) {
    const card = historyCard("Slot " + finalist.slotNumber + " · Duck #" + finalist.duck.visibleNumber, finalist.participant.firstName + " " + finalist.participant.lastName + " · won Heat " + finalist.qualifiedFrom.heatNumber + (finalist.podiumPlace ? " · podium " + finalist.podiumPlace : ""));
    // A finalist who has since left keeps their slot in the final — the duck is
    // in that heat's bag — and is marked so nobody reads them out as a winner.
    rosterMarkIneligible(card, finalist, "Cannot win", text);
    finalistList.append(card);
  }
  if (body.finalists.length === 0) finalistList.append(empty("No round-one winner has been recorded yet."));
};

const supportSummary = document.querySelector("[data-support-summary]");
const notificationList = document.querySelector("[data-notification-list]");
const notificationAttempts = document.querySelector("[data-notification-attempts]");
const auditList = document.querySelector("[data-audit-list]");

const loadSupportSummary = async () => {
  if (!isSystemAdmin || !currentEvent || !supportSummary) return;
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/summary");
  showFacts(supportSummary, [
    ["Total blockers", body.blockerCount], ["Registration", body.areas.registration.blockerCount],
    ["Inventory", body.areas.duck.blockerCount], ["Heats", body.areas.heat.blockerCount],
    ["Notifications", body.areas.notification.blockerCount],
  ]);
};

const notificationAction = async (notification, action, reason, button) => {
  const label = action === "retry" ? "Retry" : action === "suppress" ? "Suppress" : "Cancel";
  if (!await appConfirm(label + " this notification?", { danger: action !== "retry" })) return;
  await perform(button, label + " notification…", async () => {
    const payload = { commandId: crypto.randomUUID() };
    if (action !== "retry") payload.reason = reason;
    await api(
      "/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/notifications/" + encodeURIComponent(notification.id) + "/" + action,
      commandOptions("POST", payload),
    );
    await Promise.all([loadNotifications(), loadSupportSummary()]);
  });
};

const loadNotificationAttempts = async (notificationId) => {
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/notifications/" + encodeURIComponent(notificationId) + "/attempts");
  notificationAttempts.replaceChildren(text("h3", "Delivery attempts"));
  for (const attempt of body.attempts) notificationAttempts.append(historyCard("Attempt " + attempt.number + " · " + humanize(attempt.status), humanize(attempt.stage) + (attempt.errorCode ? " · " + attempt.errorCode : "")));
  if (body.attempts.length === 0) notificationAttempts.append(empty("No delivery attempts are recorded."));
};

const loadNotifications = async () => {
  const form = document.querySelector("[data-notification-filter-form]");
  if (!isSystemAdmin || !currentEvent || !form || !notificationList) return;
  const status = String(new FormData(form).get("status") || "");
  const parameters = new URLSearchParams({ limit: "100" });
  if (status) parameters.set("status", status);
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/notifications?" + parameters);
  notificationList.replaceChildren();
  for (const notification of body.notifications) {
    const card = text("article", "", "data-card");
    card.append(text("h3", notification.participantName + " · " + humanize(notification.type)), text("p", humanize(notification.status) + " · " + notification.attempts + " attempts", "muted"));
    if (notification.errorCode) card.append(text("p", "Error code: " + notification.errorCode, "error-text"));
    const reason = document.createElement("input");
    reason.placeholder = "Reason for suppress or cancel";
    reason.maxLength = 500;
    const actions = text("div", "", "actions");
    const attemptsButton = text("button", "Attempts", "button secondary small");
    attemptsButton.type = "button";
    attemptsButton.addEventListener("click", () => loadNotificationAttempts(notification.id).catch((error) => setMessage(error.message, true)));
    actions.append(attemptsButton);
    if (["FAILED", "RETRY_PENDING"].includes(notification.status)) {
      const retry = text("button", "Retry", "button small"); retry.type = "button";
      retry.addEventListener("click", () => notificationAction(notification, "retry", "", retry)); actions.append(retry);
    }
    if (["WAITING_FOR_SYNC", "PENDING", "QUEUED", "RETRY_PENDING", "FAILED"].includes(notification.status)) {
      card.append(reason);
      const suppress = text("button", "Suppress", "button danger small"); suppress.type = "button";
      suppress.addEventListener("click", () => notificationAction(notification, "suppress", reason.value, suppress)); actions.append(suppress);
    }
    if (["WAITING_FOR_SYNC", "PENDING", "QUEUED", "RETRY_PENDING"].includes(notification.status)) {
      const cancel = text("button", "Cancel", "button danger small"); cancel.type = "button";
      cancel.addEventListener("click", () => notificationAction(notification, "cancel", reason.value, cancel)); actions.append(cancel);
    }
    card.append(actions);
    notificationList.append(card);
  }
  if (body.notifications.length === 0) notificationList.append(empty("No notifications match this filter."));
};

const loadAudit = async () => {
  if (!isSystemAdmin || !currentEvent || !auditList) return;
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/audit?limit=200");
  auditList.replaceChildren();
  for (const item of body.events) auditList.append(historyCard(humanize(item.action), item.occurredAt + " · " + (item.actorDisplayName || humanize(item.actorType)) + (item.code ? " · " + item.code : "")));
  if (body.events.length === 0) auditList.append(empty("No audit events are recorded."));
};

if (isSystemAdmin) {
  document.querySelector("[data-refresh-support]")?.addEventListener("click", () => loadSupportSummary().catch((error) => setMessage(error.message, true)));
  document.querySelector("[data-notification-filter-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadNotifications()
      .then(() => globalThis.quickDucksLive.markClean(event.currentTarget))
      .catch((error) => setMessage(error.message, true));
  });
  document.querySelector("[data-refresh-audit]")?.addEventListener("click", () => loadAudit().catch((error) => setMessage(error.message, true)));
}

// This client runs on the Admin console and on the registration desk, and the
// desk renders the participants surface and nothing else. RaceUpdates admits a
// bounded number of connections and fans every signal out to every matching
// subscriber, so the broad page refresh asks only for the domains its operation
// loaders can repaint. The small walk-up cutoff projection below is intentionally
// separate: it consumes a heat signal without waking the absent heat loader.
//
// Each domain is therefore gated on the markup and the role that would consume
// it, exactly as loadEvent gates the loaders themselves. The "event" domain is
// unconditional because both pages resolve and render a working event.
// "ducks" is deliberately not gated on the participant list alone. loadEvent
// renders the readiness panel for canRaceRead, and readiness reports duck facts
// — unpaired active participants and pending NFC stickers — while duck
// provisioning publishes only ("ducks", "support"). A console that can read the
// race but not the registration desk would therefore hold a stale readiness
// panel until something else woke it. Unreachable today, because
// canOpenAdminConsole admits only administrators and RACE_DIRECTOR and
// canRegistration already includes RACE_DIRECTOR; gated correctly anyway,
// because the role shape is one grant away.
const staffLiveDomains = ["event", "staff"];
if (canRegistration && participantList) staffLiveDomains.push("participants");
if ((canRegistration && participantList) || canRaceRead) staffLiveDomains.push("ducks");
if (canRaceRead && (heatList || finalistCard)) staffLiveDomains.push("heats");
if (isSystemAdmin && (supportSummary || notificationList || auditList)) staffLiveDomains.push("support");

staffLiveSubscription = globalThis.quickDucksLive.subscribe({
  domains: staffLiveDomains,
  root: operationsRoot,
  refresh: () => loadEvents(currentEvent?.id),
  isBlocked: () => staffCommandCount > 0,
});

// The admission cutoff is caused by a heat start. This narrow subscriber is
// rooted on the read-only explanation rather than the surrounding forms, so a
// staffer who has already typed a name still sees the authoritative closure
// immediately without losing what they typed. The stale submit remains guarded
// by the backend as well.
//
// It asks the dedicated cutoff projection rather than reloading the whole event
// detail. Deleting the event publishes a heat signal too, and by the time this
// subscriber runs the event it still remembers may already be gone; the event
// detail answers that with a 404, which is a browser console error on a page
// that did nothing wrong. The cutoff projection answers "closed" instead, so
// this surface degrades to the truth in one request and logs nothing.
if (walkUpAvailability) globalThis.quickDucksLive.subscribe({
  domains: ["heats"],
  root: walkUpAvailability,
  refresh: async () => {
    if (!currentEvent) return;
    const eventId = currentEvent.id;
    const body = await api(
      "/api/v1/staff/events/" + encodeURIComponent(eventId) + "/walk-up-admission",
    );
    if (currentEvent && currentEvent.id === eventId) renderWalkUpAvailability(body.walkUpAdmission);
  },
});
`;

// Staff account and role management for the standalone /staff/access page. It
// is event-independent, so it never reads or selects an event; the DOM hooks
// and request shapes are unchanged from when this lived inside the console.
export const staffAccessScript = String.raw`
const staffAccess = document.querySelector("[data-staff-access]");
const staffAccessForm = document.querySelector("[data-staff-access-form]");
const staffAccessMessage = document.querySelector("[data-staff-access-message]");
const staffAccessList = document.querySelector("[data-staff-access-list]");
let staffCommandCount = 0;
let staffLiveSubscription = null;

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

const setMessage = (message, isError = false, target = staffAccessMessage) => {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("error-text", isError);
};

const commandOptions = (method, payload) => ({
  method,
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const api = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff");
    throw new Error("signed-out");
  }
  let body = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new Error(body && body.error ? body.error : "Request failed.");
  return body;
};

const perform = async (button, loadingMessage, operation) => {
  button.disabled = true;
  staffCommandCount += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  setMessage(loadingMessage);
  try {
    const result = await operation();
    globalThis.quickDucksLive.markClean(button.form);
    return result;
  } catch (error) {
    if (error.message !== "signed-out") setMessage(error.message, true);
    return null;
  } finally {
    button.disabled = false;
    staffCommandCount = Math.max(0, staffCommandCount - 1);
    endBusy();
    staffLiveSubscription?.resume();
  }
};

const staffRoleLabels = {
  REGISTRATION: "Registration",
  DUCK_MANAGER: "Duck manager",
  ANNOUNCER: "Announcer",
  HEAT_RUNNER: "Heat runner",
  RESULT_TAKER: "Result taker",
  RACE_DIRECTOR: "Race director",
};

const roleSetControl = (selectedRoles) => {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "role-set";
  const legend = text("legend", "Operational roles");
  fieldset.append(legend);
  for (const [value, label] of Object.entries(staffRoleLabels)) {
    const option = text("label", "", "check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = selectedRoles.includes(value);
    option.append(checkbox, text("span", label, "label-text"));
    fieldset.append(option);
  }
  return fieldset;
};

const selectedRoleSet = (fieldset) => [...fieldset.querySelectorAll('input[type="checkbox"]:checked')]
  .map((checkbox) => checkbox.value);

const staffLifecycle = async (profile, action, roleChange, button) => {
  const description = action === "role" ? "change this account role" : action + " this staff account";
  if (!await appConfirm("Really " + description + "?", { danger: action === "deactivate" })) return;
  await perform(button, "Updating staff access…", async () => {
    const payload = { commandId: crypto.randomUUID() };
    if (action === "role") {
      payload.role = roleChange.role;
      payload.roles = roleChange.roles;
      payload.revision = profile.roleRevision;
      if (payload.role === "STAFF" && payload.roles.length === 0) {
        throw new Error("Select at least one operational role for regular staff.");
      }
    }
    await api("/api/v1/staff/profiles/" + encodeURIComponent(profile.id) + "/" + action, commandOptions("POST", payload));
    await loadStaffProfiles();
  });
};

const loadStaffProfiles = async () => {
  if (!staffAccess) return;
  const body = await api("/api/v1/staff/profiles");
  staffAccessList.replaceChildren();
  for (const profile of body.staff) {
    const card = text("article", "", "staff-access-card");
    const identity = text("div", "");
    identity.append(text("p", profile.displayName || profile.email), text("p", profile.email + " · " + (profile.active === false ? "Inactive" : "Active"), "muted"));
    const controls = text("div", "", "actions staff-role-controls");
    const role = document.createElement("select");
    role.setAttribute("aria-label", "Account type for " + (profile.displayName || profile.email));
    role.append(new Option("Regular staff", "STAFF"), new Option("System administrator", "ADMIN"));
    role.value = profile.role;
    const roleSet = roleSetControl(profile.roles || []);
    roleSet.disabled = role.value === "ADMIN";
    role.addEventListener("change", () => { roleSet.disabled = role.value === "ADMIN"; });
    const saveRole = text("button", "Save role", "button secondary small"); saveRole.type = "button";
    saveRole.addEventListener("click", () => staffLifecycle(profile, "role", {
      role: role.value,
      roles: role.value === "ADMIN" ? [] : selectedRoleSet(roleSet),
    }, saveRole));
    const activeAction = profile.active === false ? "reactivate" : "deactivate";
    const activeButton = text("button", profile.active === false ? "Reactivate" : "Deactivate", profile.active === false ? "button small" : "button danger small");
    activeButton.type = "button";
    activeButton.addEventListener("click", () => staffLifecycle(profile, activeAction, null, activeButton));
    controls.append(role, roleSet, saveRole, activeButton);
    const roleSummary = profile.role === "ADMIN"
      ? "System administrator"
      : (profile.roles || []).map((value) => staffRoleLabels[value]).join(", ");
    card.append(identity, text("span", roleSummary || "No operational roles", "role-tag"), controls);
    staffAccessList.append(card);
  }
  setMessage(body.staff.length + " authorized staff account" + (body.staff.length === 1 ? "." : "s."), false, staffAccessMessage);
};

if (staffAccessForm) staffAccessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Creating Cognito account and staff access…", async () => {
    const accountType = String(values.get("role"));
    const roles = accountType === "ADMIN" ? [] : values.getAll("roles").map(String);
    if (accountType === "STAFF" && roles.length === 0) {
      throw new Error("Select at least one operational role for regular staff.");
    }
    const result = await api("/api/v1/staff/profiles", commandOptions("POST", {
      commandId: crypto.randomUUID(), email: String(values.get("email")), displayName: String(values.get("displayName")), role: accountType, roles,
    }));
    form.reset();
    await loadStaffProfiles();
    setMessage(result.staff.displayName + " can now sign in.", false, staffAccessMessage);
  });
});

if (staffAccessForm) {
  const accountType = staffAccessForm.elements.role;
  const roleSet = staffAccessForm.querySelector("[data-create-role-set]");
  const updateRoleSet = () => { roleSet.disabled = accountType.value === "ADMIN"; };
  accountType.addEventListener("change", updateRoleSet);
  updateRoleSet();
}

staffLiveSubscription = globalThis.quickDucksLive.subscribe({
  domains: ["staff"],
  root: staffAccess,
  refresh: () => loadStaffProfiles(),
  isBlocked: () => staffCommandCount > 0,
});
`;

// Pure helpers for participant QR pairing. These mirror `participant-qr.ts` on
// the server: the browser only decides whether a scanned value looks like a
// QuickDucks participant code and is worth sending. Every authorization,
// event, inventory, and registration-state check stays server-side, so a
// spoofed or hand-crafted QR gains nothing beyond typing a code by hand.
export const participantQrHelpersScript = String.raw`
const qrParticipantPrefix = "QD1:";
const qrLookupCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;

const qrNormalizeLookupCode = (value) => String(value == null ? "" : value)
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "");

const qrParseParticipantPayload = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toUpperCase().startsWith(qrParticipantPrefix)) return null;
  const code = qrNormalizeLookupCode(trimmed.slice(qrParticipantPrefix.length));
  return qrLookupCodePattern.test(code) ? code : null;
};

// Camera scanning needs a secure context and a camera. Decoding does not need
// native support: browsers without BarcodeDetector, notably iOS Safari and
// Firefox, load the bundled decoder instead. Only a device with no camera or a
// non-secure context falls back to typing the code.
const qrScannerSupported = (scope) => {
  const target = scope || globalThis;
  const mediaDevices = target.navigator && target.navigator.mediaDevices;
  return target.isSecureContext === true
    && !!mediaDevices
    && typeof mediaDevices.getUserMedia === "function";
};

// Native detection is the fast path where it exists; it runs off the main
// thread and needs no download.
const qrNativeDetection = async (scope) => {
  const target = scope || globalThis;
  if (typeof target.BarcodeDetector !== "function") return null;
  try {
    const formats = await target.BarcodeDetector.getSupportedFormats();
    if (!formats.includes("qr_code")) return null;
    const detector = new target.BarcodeDetector({ formats: ["qr_code"] });
    return (frame) => detector.detect(frame);
  } catch {
    return null;
  }
};

// Decode a centred square crop, downscaled, which is what the participant
// actually points the camera at and keeps each frame cheap enough to run
// between paints.
const qrCropFrame = (video, context, target) => {
  const side = Math.min(video.videoWidth, video.videoHeight);
  const size = Math.min(target, side);
  context.canvas.width = size;
  context.canvas.height = size;
  context.drawImage(
    video,
    (video.videoWidth - side) / 2,
    (video.videoHeight - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  return context.getImageData(0, 0, size, size);
};

const qrCameraProblem = (error) => {
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow camera access for this site, or cancel and search manually.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No usable camera was found on this device. Cancel and search manually.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is being used by another app. Close it and scan again, or cancel and search manually.";
  }
  if (name === "decoder-unavailable" || (error && error.message === "decoder-unavailable")) {
    return "The QR reader could not be loaded. Check the connection and scan again, or cancel and search manually.";
  }
  return "The camera could not be started. Scan again, or cancel and search manually.";
};
`;

// Loader for the bundled decoder, kept separate so the scan flow can be tested
// without a DOM. The script is same-origin, so it needs no CSP change, and it
// downloads only when a browser lacks native detection and staff start a scan.
export const participantQrDecoderScript = String.raw`
let qrDecoderLoad = null;

const qrLoadDecoder = (documentRef, scope) => {
  const target = scope || globalThis;
  if (typeof target.jsQR === "function") return Promise.resolve(target.jsQR);
  if (qrDecoderLoad === null) {
    qrDecoderLoad = new Promise((resolve, reject) => {
      const element = documentRef.createElement("script");
      element.src = "/assets/qr-decoder.js";
      element.addEventListener("load", () => {
        if (typeof target.jsQR === "function") resolve(target.jsQR);
        else reject(new Error("decoder-unavailable"));
      });
      element.addEventListener("error", () => reject(new Error("decoder-unavailable")));
      documentRef.head.append(element);
    }).catch((error) => {
      qrDecoderLoad = null;
      throw error;
    });
  }
  return qrDecoderLoad;
};
`;

// Pairing puts a physical duck into a physical heat bag, and nobody empties a
// bag on the bank to find one duck: heat entries are never reordered, because
// the ducks inside a bag are indistinguishable without scanning every one of
// them.
//
// So the bag number is the loudest thing on the pairing screen, and it is ALWAYS
// the heat the server's pairing command actually committed. This helper is a
// pure function of that response on purpose: it takes the heat the server
// returned and never counts entries, increments a previous number, or otherwise
// derives one. A guessed number here puts a real duck in the wrong real bag.
//
// The note is the one thing that is not fixed, and it is a promise, so it has to
// be true. There is exactly one operation that can still move an already-paired
// duck's entry: closing registration folds a round-one tail heat that is too
// short to race into the heat before it, and reopening splits it back out. That
// can only happen while the event is REGISTRATION_OPEN and only to a round-one
// heat, so:
//
//   - While registration is open the note says the bag is this duck's bag and
//     that a fold is announced in the console if the tail heat turns out to be
//     too short. It does not claim the bag is final, because it is not.
//   - Once registration has closed, or for a final-heat repair pairing, no fold
//     can reach this entry any more and the note says so absolutely.
//
// `eventStatus` is the status of the event the pairing command was run against,
// straight from `GET /api/v1/events/current`; an unknown status falls back to
// the cautious wording rather than the absolute one.
export const heatBagHelpersScript = String.raw`
const heatBagCallout = (heat, duckNumber, heatAssignmentPending, eventStatus) => {
  const duckLabel = "Duck #" + duckNumber;
  // Say so plainly rather than printing a blank or an invented bag number.
  if (!heat || heatAssignmentPending === true || typeof heat.number !== "number") {
    return {
      pending: true,
      instruction: "Do not bag this duck yet",
      number: "No heat assigned",
      duck: duckLabel + " is paired",
      note: "QuickDucks did not return a heat for this pairing, so there is no bag to put "
        + duckLabel + " in. Keep it aside and ask the race director which heat it belongs to"
        + " before it goes into any bag.",
    };
  }
  // The round comes from the server too. A repair pairing during racing can land
  // in the final, and that is a different bag from round-one heat 1.
  const bag = heat.round === "FINAL" ? "FINAL heat " + heat.number : "HEAT " + heat.number;
  const settled = heat.round === "FINAL"
    || ["REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"].includes(eventStatus);
  return {
    pending: false,
    instruction: "Put this duck in " + bag + " bag",
    number: (heat.round === "FINAL" ? "Final · Heat " : "Heat ") + heat.number,
    duck: duckLabel,
    note: "Walk " + duckLabel + " to the " + bag.toLowerCase() + " bag now. " + (settled
      ? "It stays in that bag, in that position, for the rest of the race."
      : "While registration is open this whole bag can still be folded into the heat before it, "
        + "if the heat is too short to race when registration closes. QuickDucks then tells the "
        + "race director to pour one whole bag into another, and the Admin console names both "
        + "bags. Nothing else ever moves this duck."),
  };
};
`;

export const staffDuckScript = participantQrHelpersScript
  + participantQrDecoderScript
  + heatBagHelpersScript
  // This page is the result surface for both racing rounds, so it asks the same
  // eligibility question the finish line asks, through the same shared helper
  // rather than a second copy of "can this racer still win".
  + rosterEligibilityHelpersScript
  + podiumPlaceHelpersScript
  + String.raw`
const root = document.querySelector("[data-staff-duck]");
const token = root.dataset.token;
const pageTitle = document.querySelector("[data-staff-title]");
const summary = document.querySelector("[data-duck-summary]");
const workArea = document.querySelector("[data-pairing-work]");
const winnerAction = document.querySelector("[data-winner-action]");
const message = document.querySelector("[data-staff-message]");
const heatBag = document.querySelector("[data-heat-bag]");
const heatBagInstruction = document.querySelector("[data-heat-bag-instruction]");
const heatBagNumber = document.querySelector("[data-heat-bag-number]");
const heatBagDuck = document.querySelector("[data-heat-bag-duck]");
const heatBagNote = document.querySelector("[data-heat-bag-note]");
let currentEvent = null;
let selectedRegistration = null;
let staffDuckBusy = 0;
let staffDuckSubscription = null;
let justPairedCode = null;
let winnerSuccess = null;

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    document.querySelector("main")?.replaceChildren();
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return body;
};

const addFact = (label, value) => {
  const fact = text("div", "", "fact");
  fact.append(text("dt", label), text("dd", value));
  summary.append(fact);
};

// The real registration status, in plain race-day words.
const ineligibleStatusLabel = (status) => status === "WITHDRAWN"
  ? "Withdrawn"
  : status === "DISQUALIFIED"
    ? "Disqualified"
    : String(status || "").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());

// The bag panel is painted straight from the pairing response the server
// returned, through the pure helper above. Nothing here decides a heat number.
const showHeatBag = (result) => {
  if (!heatBag) return;
  const callout = heatBagCallout(
    result.heat,
    result.duck.visibleNumber,
    result.heatAssignmentPending,
    currentEvent ? currentEvent.status : null,
  );
  heatBag.classList.toggle("pending", callout.pending);
  // Reveal the live region before writing into it, so the announcement is a
  // change inside a region that is already in the accessibility tree.
  heatBag.hidden = false;
  heatBagInstruction.textContent = callout.instruction;
  heatBagNumber.textContent = callout.number;
  heatBagDuck.textContent = callout.duck;
  heatBagNote.textContent = callout.note;
  heatBag.scrollIntoView({ block: "start" });
};

if (heatBag) {
  // It stays up until the staffer says the duck is physically in the bag, or
  // until they scan the next duck, which loads a different page entirely. A
  // live refresh must never take it off the screen while they walk to the bags.
  heatBag.querySelector("[data-heat-bag-dismiss]").addEventListener("click", () => {
    heatBag.hidden = true;
    message.textContent = "Scan the next duck to pair it.";
  });
}

// "Scan the next duck" is the right answer for one refused duck and the wrong
// answer for a heat in which every duck will be refused: it sends a result taker
// through the whole bag, one DUCK_NOT_ELIGIBLE at a time, with nothing on any
// screen saying the heat has no winner in it or that only a race director can
// change that.
//
// Round one publishes here rather than through the finish-line form, so this
// page has to answer it too. The question is asked only when the server has
// already refused this duck, and it is asked of the heat the server itself
// named, using the same roster projection and the same eligibility helper the
// finish line uses. A failed or unauthorized read simply answers "no", leaving
// the statement exactly as it was rather than inventing a claim about the heat.
const winnerHeatHasNoEligibleRacer = async (data) => {
  const ineligible = data && !data.winnerAction ? data.winnerIneligible : null;
  if (!ineligible || typeof ineligible.eventId !== "string" || typeof ineligible.heatId !== "string") return false;
  try {
    const body = await fetchJson("/api/v1/staff/events/" + encodeURIComponent(ineligible.eventId)
      + "/heats/" + encodeURIComponent(ineligible.heatId));
    return Array.isArray(body.roster) && rosterEligibleEntries(body.roster).length === 0;
  } catch {
    return false;
  }
};

// One scan of a final's duck: publish the place the staffer chose, and let the
// server decide whether that place was the last one the podium needed. The
// station is never asked to know which scan finishes the race — it scans the
// ducks that finished, in whatever order they are picked out of the water.
const submitPodiumPlace = async (data, candidate, place, button) => {
  const duckLabel = "Duck #" + data.duck.visibleNumber;
  const lastPlace = candidate.podium.availablePlaces.length === 1;
  if (!await appConfirm(
    "Record " + duckLabel + " as " + podiumPlaceLabel(place) + " in the final?"
      + (lastPlace
        ? " That is the last place, so this publishes the official podium immediately."
        : " You can clear this place by scanning this duck again."),
    { danger: true, confirmLabel: "Record " + podiumPlaceLabel(place) },
  )) return;
  button.disabled = true;
  staffDuckBusy += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  message.textContent = "Recording " + duckLabel + " as " + podiumPlaceLabel(place) + "…";
  try {
    const body = await fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token) + "/heat-winner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: candidate.eventId,
        heatId: candidate.heatId,
        raceEntryId: candidate.raceEntryId,
        revision: candidate.revision,
        place,
      }),
    });
    // The response, not the count the button was painted from, decides what this
    // says: another station may have filled a place between the paint and the
    // press, so the scan that publishes is not always the one that looked like it
    // would. A replayed command can also come back to a podium that has moved on
    // since — the place may have been cleared — so the banner claims a saved
    // place only while the response still shows this duck standing in it.
    const published = body.heat && body.heat.status === "FINALIZED";
    const standing = published || podiumTakenPlacements(body.podium)
      .some((placement) => placement.place === place && placement.raceEntryId === candidate.raceEntryId);
    winnerSuccess = published
      ? {
        title: "Official podium saved",
        detail: duckLabel + " took " + podiumPlaceLabel(place) + ". The final podium is now official.",
      }
      : standing
        ? {
          title: podiumPlaceLabel(place) + " saved",
          detail: duckLabel + " is recorded as " + podiumPlaceLabel(place) + " in the final.",
        }
        : {
          title: podiumPlaceLabel(place) + " is not recorded",
          detail: duckLabel + " is not standing in " + podiumPlaceLabel(place)
            + " any more. Check the podium below and scan again if it should be.",
        };
    await load();
    if (standing) pageTitle.textContent = duckLabel + " took " + podiumPlaceLabel(place);
    message.textContent = published
      ? "Official podium saved. Live race screens have been notified."
      : standing
        ? "Saved. Scan the next duck to pass the finish line."
        : "That place is not recorded any more. Check the podium and scan again if it should be.";
  } catch (error) {
    if (error.message !== "signed-out") {
      button.disabled = false;
      message.textContent = error.message;
    }
  } finally {
    staffDuckBusy = Math.max(0, staffDuckBusy - 1);
    endBusy();
    staffDuckSubscription?.resume();
  }
};

const clearPodiumPlace = async (data, candidate, button) => {
  const place = candidate.podium.selectedPlace;
  const duckLabel = "Duck #" + data.duck.visibleNumber;
  if (!await appConfirm(
    "Clear " + duckLabel + " from " + podiumPlaceLabel(place) + " in the final?"
      + " That place goes back to being open for the next duck scanned.",
    { danger: true, confirmLabel: "Clear " + podiumPlaceLabel(place) },
  )) return;
  button.disabled = true;
  staffDuckBusy += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  message.textContent = "Clearing " + podiumPlaceLabel(place) + "…";
  try {
    await fetchJson("/api/v1/staff/events/" + encodeURIComponent(candidate.eventId)
      + "/heats/" + encodeURIComponent(candidate.heatId) + "/podium-place/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        raceEntryId: candidate.raceEntryId,
        place,
      }),
    });
    winnerSuccess = {
      title: podiumPlaceLabel(place) + " cleared",
      detail: podiumPlaceLabel(place) + " is open again. Scan the duck that finished there.",
    };
    await load();
    message.textContent = podiumPlaceLabel(place) + " is open again. Scan the duck that finished there.";
  } catch (error) {
    if (error.message !== "signed-out") {
      button.disabled = false;
      message.textContent = error.message;
    }
  } finally {
    staffDuckBusy = Math.max(0, staffDuckBusy - 1);
    endBusy();
    staffDuckSubscription?.resume();
  }
};

// The final's version of the winner action. Round one has one place, so it has
// one button; the final has up to three, so the staffer says which one this duck
// took. Only the places the server reports open are offered, and a duck that is
// already standing on the podium is offered the way back off it instead.
const renderPodiumAction = (data, candidate) => {
  const podium = candidate.podium;
  const duckLabel = "Duck #" + data.duck.visibleNumber;
  const taken = podiumTakenPlacements(podium);
  if (podium.selectedPlace !== null) {
    winnerAction.append(
      text("strong", duckLabel + " is " + podiumPlaceLabel(podium.selectedPlace)),
      text("p", candidate.participantDisplayName + " is recorded as " + podiumPlaceLabel(podium.selectedPlace)
        + " in the final. The podium is published once every place is scanned."),
    );
    const clear = text("button", "Clear " + podiumPlaceLabel(podium.selectedPlace), "button secondary station-control");
    clear.type = "button";
    clear.dataset.podiumClear = String(podium.selectedPlace);
    clear.addEventListener("click", () => clearPodiumPlace(data, candidate, clear));
    winnerAction.append(clear);
    message.textContent = duckLabel + " is already " + podiumPlaceLabel(podium.selectedPlace)
      + ". Scan the next duck to pass the finish line.";
    return;
  }
  const open = podiumOpenPlaces(podium);
  if (open.length === 0) {
    // Every place this final has is held by a duck that is not this one. There
    // is nothing to press, so say what is true rather than leaving the panel
    // looking broken.
    winnerAction.append(
      text("strong", "Every podium place is taken"),
      text("p", "The final's " + podium.requiredPlaces + " podium place"
        + (podium.requiredPlaces === 1 ? " is" : "s are") + " already recorded, so " + duckLabel
        + " cannot be added. Clear a place from the finish-line station if one is wrong."),
    );
    message.textContent = "Every podium place is already recorded.";
    return;
  }
  winnerAction.append(
    text("strong", "Which place did " + duckLabel + " take?"),
    text("p", candidate.participantDisplayName + " and " + duckLabel + " are on the official final roster."),
  );
  if (taken.length > 0) {
    for (const placement of taken) {
      winnerAction.append(text("p", podiumPlaceLabel(placement.place) + " is already recorded: "
        + placement.participantDisplayName + " · Duck #" + placement.visibleNumber));
    }
  }
  for (const place of open) {
    const button = text("button", "Mark Duck as " + podiumPlaceLabel(place), "button station-control");
    button.type = "button";
    button.dataset.podiumPlace = String(place);
    button.addEventListener("click", () => submitPodiumPlace(data, candidate, place, button));
    winnerAction.append(button);
  }
};

const renderWinnerAction = (data, heatHasNoEligibleRacer = false) => {
  winnerAction.replaceChildren();
  winnerAction.classList.remove("ineligible");
  if (winnerSuccess !== null) {
    const success = winnerSuccess;
    winnerSuccess = null;
    winnerAction.hidden = false;
    winnerAction.append(text("strong", success.title), text("p", success.detail));
    return;
  }
  const candidate = data.winnerAction;
  // The finish line scanned a duck whose racer is withdrawn or disqualified.
  // That duck was bagged before the withdrawal and is still in the water, so
  // this is a normal race-day outcome, not an error: name the duck, name the
  // status, and send the staffer straight back to the finish line.
  const ineligible = data.winnerIneligible;
  if (!candidate && ineligible) {
    // Whichever round it is, the heat this duck is in is the heat it cannot be
    // recorded for. The final is named as "the final" because that is what staff
    // call it; there is only ever one, and "Heat 1" for it reads like a
    // round-one heat.
    const heatLabel = ineligible.round === "FINAL" ? "the final" : "Heat " + ineligible.heatNumber;
    winnerAction.hidden = false;
    winnerAction.classList.add("ineligible");
    winnerAction.append(
      text("strong", "Duck #" + data.duck.visibleNumber + " is " + ineligibleStatusLabel(ineligible.registrationStatus)),
      text("p", ineligible.participantDisplayName + " cannot be recorded as "
        + (ineligible.round === "FINAL" ? "a podium place in the final" : "the " + heatLabel + " winner")
        + ", and this duck stays in its heat."),
    );
    // The whole heat is out, so there is no next duck worth scanning and the
    // remedy is the only thing left to say.
    if (heatHasNoEligibleRacer) {
      winnerAction.append(
        text("strong", "Nobody in " + heatLabel + " can win"),
        text("p", "Every racer in " + heatLabel + " is withdrawn or disqualified, so every duck in that"
          + " bag will be refused and no result can be recorded. Every duck stays in its bag."),
        text("p", "Ask the race director to reactivate a racer, then scan that duck's tag again."),
      );
      message.textContent = "Nobody in " + heatLabel + " can win."
        + " Ask the race director to reactivate a racer, then scan that duck's tag again.";
      return;
    }
    winnerAction.append(text("p", "Scan the next duck to pass the finish line."));
    message.textContent = "This duck cannot win. Scan the next duck to pass the finish line.";
    return;
  }
  if (!candidate) {
    winnerAction.hidden = true;
    return;
  }
  winnerAction.hidden = false;
  // The final awards places rather than a single winner, so the same scan asks a
  // different question. Everything before this point — the refusals, the
  // withdrawn-racer statement, the saved banner — is identical in both rounds.
  if (candidate.round === "FINAL" && candidate.podium) {
    renderPodiumAction(data, candidate);
    return;
  }
  winnerAction.append(
    text("strong", "Result waiting"),
    text("p", candidate.participantDisplayName + " and Duck #" + data.duck.visibleNumber + " are on the official Heat " + candidate.heatNumber + " roster."),
  );
  const button = text("button", "Mark Duck as Heat " + candidate.heatNumber + " Winner", "button station-control");
  button.type = "button";
  button.addEventListener("click", async () => {
    if (!await appConfirm(
      "Mark Duck #" + data.duck.visibleNumber + " as the official Heat " + candidate.heatNumber + " winner? This publishes immediately.",
      { danger: true, confirmLabel: "Mark winner" },
    )) return;
    button.disabled = true;
    staffDuckBusy += 1;
    const endBusy = globalThis.quickDucksLive.beginBusy();
    message.textContent = "Publishing the official Heat " + candidate.heatNumber + " winner…";
    try {
      await fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token) + "/heat-winner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          eventId: candidate.eventId,
          heatId: candidate.heatId,
          raceEntryId: candidate.raceEntryId,
          revision: candidate.revision,
        }),
      });
      winnerSuccess = {
        title: "Official winner saved",
        detail: "Duck #" + data.duck.visibleNumber + " is the official Heat " + candidate.heatNumber + " winner.",
      };
      await load();
      pageTitle.textContent = "Duck #" + data.duck.visibleNumber + " won Heat " + candidate.heatNumber;
      message.textContent = "Official winner saved. Live race screens have been notified.";
    } catch (error) {
      if (error.message !== "signed-out") {
        button.disabled = false;
        message.textContent = error.message;
      }
    } finally {
      staffDuckBusy = Math.max(0, staffDuckBusy - 1);
      endBusy();
      staffDuckSubscription?.resume();
    }
  });
  winnerAction.append(button);
};

// Scanning the duck someone is complaining about is the fastest way for staff
// to reach its record, so the moderation control lives here as well as in the
// participant console. The control is rendered only when the response carried
// the participant projection, which the API sends only to the roles the clear
// endpoint itself accepts.
const clearScannedDuckName = async (registrationId, button) => {
  if (!await appConfirm(
    "Clear this duck's chosen name? It goes back to showing its number everywhere. This is recorded in the audit trail.",
    { danger: true, confirmLabel: "Clear duck name" },
  )) return;
  button.disabled = true;
  message.textContent = "Clearing duck name…";
  staffDuckBusy += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  try {
    await fetchJson("/api/v1/staff/registrations/" + encodeURIComponent(registrationId) + "/clear-duck-name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID() }),
    });
    await load();
    message.textContent = "Duck name cleared. This duck now shows its number only.";
  } catch (error) {
    if (error.message !== "signed-out") {
      button.disabled = false;
      message.textContent = error.message;
    }
  } finally {
    staffDuckBusy -= 1;
    endBusy();
    staffDuckSubscription?.resume();
  }
};

const showDuckNameModeration = (participant) => {
  if (typeof participant.duckName !== "string" || participant.duckName.length === 0) return;
  addFact("Duck name", participant.duckNamePubliclyHidden === true
    ? participant.duckName + " (already hidden from public surfaces)"
    : participant.duckName);
  if (typeof participant.registrationId !== "string") return;
  const actions = text("div", "", "actions");
  const button = text("button", "Clear duck name", "button danger small");
  button.type = "button";
  button.dataset.clearDuckName = participant.registrationId;
  button.addEventListener("click", () => clearScannedDuckName(participant.registrationId, button));
  actions.append(button);
  summary.append(actions);
};

const showInspection = (data) => {
  const participant = data.assignment.participant || {};
  // A live refresh arrives immediately after pairing, because pairing itself
  // publishes the signal. Keep confirming the staff member's own action rather
  // than silently replacing it with a generic inspection view.
  const confirmed = justPairedCode !== null && participant.lookupCode === justPairedCode;
  pageTitle.textContent = confirmed
    ? "Duck #" + data.duck.visibleNumber + " paired"
    : "Inspect Duck #" + data.duck.visibleNumber;
  message.textContent = confirmed
    ? "Duck paired successfully."
    : "This duck is already paired. Review the assignment below.";
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  if (participant.firstName) addFact("Participant", participant.firstName + " " + participant.lastName);
  if (participant.lookupCode) addFact("Lookup code", participant.lookupCode);
  if (participant.registrationStatus) addFact("Registration", participant.registrationStatus.replaceAll("_", " ").toLowerCase());
  if (!data.assignment.active) addFact("Assignment", "closed");
  if (participant.email) addFact("Email", participant.email);
  if (participant.phone) addFact("Phone", participant.phone);
  showDuckNameModeration(participant);
};

const renderSelection = (registration) => {
  selectedRegistration = registration;
  const review = document.querySelector("[data-pairing-review]");
  review.replaceChildren();
  review.append(
    text("h3", registration.firstName + " " + registration.lastName),
    text("p", "Lookup code " + registration.lookupCode, "muted"),
    text("p", registration.email || "No email provided", "muted"),
    text("p", registration.phone || "No phone provided", "muted"),
  );
  document.querySelector("[data-confirm-pairing]").disabled = false;
};

// One pairing command shared by the confirm button, an exactly typed lookup
// code, and a scanned QR code. Each entry point only supplies the code; the
// guarded server command remains the single authority on whether the pairing
// is allowed.
const pairWithLookupCode = async (lookupCode) => {
  if (!currentEvent) return { ok: false, error: "There is no event currently accepting duck pairing." };
  staffDuckBusy += 1;
  const endBusy = globalThis.quickDucksLive.beginBusy();
  message.textContent = "Pairing duck and participant…";
  try {
    const result = await fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token) + "/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: currentEvent.id,
        lookupCode,
      }),
    });
    if (workArea) workArea.hidden = true;
    summary.replaceChildren();
    addFact("Duck", "#" + result.duck.visibleNumber);
    addFact("Participant", result.participant.firstName + " " + result.participant.lastName);
    // Both facts read the server's own heat. The round comes from the response
    // too, because a repair pairing can land in the final.
    addFact("Heat bag", result.heat
      ? (result.heat.round === "FINAL" ? "Final" : "Round one") + " · Heat " + result.heat.number
      : "Not assigned yet");
    showHeatBag(result);
    pageTitle.textContent = "Duck #" + result.duck.visibleNumber + " paired";
    message.textContent = result.replayed ? "This pairing was already saved." : "Duck paired successfully.";
    selectedRegistration = null;
    justPairedCode = result.participant.lookupCode;
    globalThis.quickDucksLive.markClean(root);
    return { ok: true };
  } catch (error) {
    if (error.message === "signed-out") return { ok: false, signedOut: true };
    message.textContent = error.message;
    return { ok: false, error: error.message };
  } finally {
    staffDuckBusy = Math.max(0, staffDuckBusy - 1);
    endBusy();
    staffDuckSubscription?.resume();
  }
};

const qrLaunch = document.querySelector("[data-qr-launch]");
const qrPanel = document.querySelector("[data-qr-scanner]");
const qrVideo = document.querySelector("[data-qr-video]");
const qrMessage = document.querySelector("[data-qr-message]");
const qrSupported = qrLaunch !== null && qrScannerSupported(globalThis);
let qrStream = null;
let qrDetector = null;
let qrTimer = null;
let qrScanning = false;
let qrStarting = false;
let qrSession = 0;
let qrVisibilityTimer = null;

const qrScheduleHiddenStop = () => {
  if (qrVisibilityTimer !== null) {
    clearTimeout(qrVisibilityTimer);
    qrVisibilityTimer = null;
  }
  // Do not time out a permission decision. Once startup settles, qrStart calls
  // this again and a genuinely backgrounded page still releases the camera.
  if (!document.hidden || qrStarting) return;
  qrVisibilityTimer = setTimeout(() => {
    qrVisibilityTimer = null;
    if (document.hidden) qrStop();
  }, 2000);
};

const qrReleaseCamera = () => {
  qrSession += 1;
  qrStarting = false;
  qrScanning = false;
  if (qrVisibilityTimer !== null) {
    clearTimeout(qrVisibilityTimer);
    qrVisibilityTimer = null;
  }
  if (qrTimer !== null) {
    clearTimeout(qrTimer);
    qrTimer = null;
  }
  if (qrStream !== null) {
    for (const track of qrStream.getTracks()) track.stop();
    qrStream = null;
  }
  if (qrVideo) qrVideo.srcObject = null;
};

const qrStop = (resumeRefresh = true) => {
  qrReleaseCamera();
  if (qrPanel && qrLaunch) {
    qrPanel.hidden = true;
    qrLaunch.hidden = !qrSupported;
  }
  if (resumeRefresh) staffDuckSubscription?.resume();
};

// Native detection where the browser has it, otherwise the bundled decoder
// over a downscaled centre crop. Both return the same shape, so the scan loop
// does not care which one is running.
const qrCreateDetector = async () => {
  const native = await qrNativeDetection(globalThis);
  if (native !== null) return native;
  const decode = await qrLoadDecoder(document, globalThis);
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return (video) => {
    const frame = qrCropFrame(video, context, 400);
    const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
    return found ? [{ rawValue: found.data }] : [];
  };
};

const qrTick = async () => {
  if (!qrScanning) return;
  try {
    if (qrVideo.readyState >= 2 && qrVideo.videoWidth > 0) {
      const codes = await qrDetector(qrVideo);
      for (const code of codes) {
        const lookupCode = qrParseParticipantPayload(code.rawValue);
        if (lookupCode !== null) {
          qrScanning = false;
          qrMessage.textContent = "Code scanned. Pairing…";
          qrStop(false);
          const outcome = await pairWithLookupCode(lookupCode);
          if (!outcome.ok && !outcome.signedOut) {
            message.textContent = outcome.error + " Scan again, or search for the participant manually.";
          }
          return;
        }
      }
      if (codes.length > 0) {
        qrMessage.textContent = "That is not a QuickDucks participant code. Ask for their registration screen and scan again, or cancel and search manually.";
      }
    }
  } catch {
    // Individual frames fail to decode constantly while the camera focuses.
    // Keep scanning rather than surfacing per-frame noise to staff.
  }
  if (qrScanning) qrTimer = setTimeout(qrTick, 250);
};

const qrStart = async () => {
  if (!currentEvent || qrStarting || qrScanning) return;
  const session = ++qrSession;
  qrStarting = true;
  // Block live refreshes from the first tap, including decoder loading and the
  // mobile permission prompt, rather than only after video playback begins.
  qrScanning = true;
  qrLaunch.hidden = true;
  qrPanel.hidden = false;
  qrMessage.textContent = "Starting the camera…";
  let candidateStream = null;
  try {
    const detector = await qrCreateDetector();
    if (session !== qrSession) return;
    candidateStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    // Cancellation invalidates this startup. Page visibility uses a grace
    // period below because mobile permission UI can briefly hide the document.
    if (session !== qrSession) {
      for (const track of candidateStream.getTracks()) track.stop();
      return;
    }
    qrDetector = detector;
    qrStream = candidateStream;
    candidateStream = null;
    qrVideo.srcObject = qrStream;
    // Permission has settled and a real stream now exists. From this point a
    // genuinely backgrounded page must release it even if play() is delayed.
    qrStarting = false;
    qrScheduleHiddenStop();
    await qrVideo.play();
    if (session !== qrSession) return;
    qrMessage.textContent = "Point the camera at the participant's QR code.";
    qrTick();
  } catch (error) {
    if (candidateStream !== null) {
      for (const track of candidateStream.getTracks()) track.stop();
    }
    if (session !== qrSession) return;
    qrReleaseCamera();
    qrMessage.textContent = qrCameraProblem(error);
    staffDuckSubscription?.resume();
  }
};

if (qrLaunch) {
  qrLaunch.querySelector("[data-scan-qr]").addEventListener("click", qrStart);
  document.querySelector("[data-qr-cancel]").addEventListener("click", () => {
    qrStop();
    message.textContent = "Find the participant, review both records, then confirm once.";
  });
}
addEventListener("pagehide", qrReleaseCamera);
document.addEventListener("visibilitychange", () => {
  qrScheduleHiddenStop();
});

// Staff arrive here holding a duck that needs a person, so the list is the
// default state and the search only narrows it. One endpoint answers both: an
// empty query lists everyone still waiting for a duck, and the server excludes
// anyone already paired from every response, so nothing in this file has to
// decide who is eligible.
const registrationSearchForm = document.querySelector("[data-registration-search]");
const registrationSearchInput = registrationSearchForm?.querySelector("[data-registration-search-input]") || null;
const registrationResults = document.querySelector("[data-registration-results]");
const registrationSearchStatus = document.querySelector("[data-registration-search-status]");
const registrationSearchDebounceMs = 250;
let registrationSearchSequence = 0;
let registrationSearchTimer = null;

const setRegistrationStatus = (value, isError) => {
  if (!registrationSearchStatus) return;
  registrationSearchStatus.className = isError ? "error-text" : "muted";
  registrationSearchStatus.textContent = value;
};

const clearRegistrationSelection = () => {
  selectedRegistration = null;
  const confirm = document.querySelector("[data-confirm-pairing]");
  if (confirm) confirm.disabled = true;
  document.querySelector("[data-pairing-review]")
    ?.replaceChildren(text("p", "Choose one registration to review.", "muted"));
};

const registrationRow = (registration) => {
  const contact = [registration.email, registration.phone].filter(Boolean).join(" · ")
    || "No email or phone provided";
  const button = text("button", "", "result-button");
  button.type = "button";
  button.append(
    text("strong", registration.firstName + " " + registration.lastName + " · " + registration.lookupCode),
    text("span", contact + " · waiting for a duck", "muted"),
  );
  button.addEventListener("click", () => renderSelection(registration));
  return button;
};

const describeRegistrationList = (body, query) => {
  const count = body.registrations.length;
  if (count === 0) {
    return query.length === 0
      ? "Every participant in this event already has a duck."
      : "No participant waiting for a duck matches that search. Anyone already paired is not listed here.";
  }
  const listed = count === 1
    ? "1 participant is waiting for a duck."
    : count + " participants are waiting for a duck.";
  return body.truncated === true
    ? "Showing the first " + count + " participants waiting for a duck. Type to narrow the list."
    : listed;
};

// A debounced keystroke only ever refreshes the list. Pairing on an exactly
// typed code is reserved for an explicit submit, so no one is paired mid-word.
const runRegistrationSearch = async (rawQuery, autoPair) => {
  if (!currentEvent || !registrationSearchForm || !registrationResults) return;
  const query = String(rawQuery == null ? "" : rawQuery).trim();
  const sequence = ++registrationSearchSequence;
  clearRegistrationSelection();
  try {
    const parameters = new URLSearchParams({ eventId: currentEvent.id, q: query });
    const body = await fetchJson("/api/v1/staff/registrations/search?" + parameters);
    if (sequence !== registrationSearchSequence) return;
    // markClean resumes queued live work, so only call it when this search
    // actually clears user input dirtiness. Automatic list loads are already
    // clean and must not queue the duck detail load again.
    if (globalThis.quickDucksLive.isDirty(registrationSearchForm)) {
      globalThis.quickDucksLive.markClean(registrationSearchForm);
    }
    // An exactly typed lookup code identifies one participant with no
    // ambiguity, so pair straight away instead of showing a one-row list to
    // click. The server never reports a paired participant, so a code that
    // already holds a duck simply is not found here.
    if (autoPair && body.exactMatch && body.exactMatch.assignedDuckNumber === null) {
      registrationResults.replaceChildren();
      setRegistrationStatus(
        "Exact code match: " + body.exactMatch.firstName + " " + body.exactMatch.lastName + ". Pairing…",
      );
      const outcome = await pairWithLookupCode(body.exactMatch.lookupCode);
      if (outcome.ok) {
        registrationSearchForm.reset();
        registrationResults.replaceChildren();
        setRegistrationStatus("");
      } else if (!outcome.signedOut) {
        setRegistrationStatus(outcome.error, true);
      }
      return;
    }
    registrationResults.replaceChildren(...body.registrations.map(registrationRow));
    setRegistrationStatus(describeRegistrationList(body, query));
  } catch (error) {
    if (sequence !== registrationSearchSequence) return;
    if (error.message !== "signed-out") {
      registrationResults.replaceChildren();
      setRegistrationStatus(error.message, true);
    }
  }
};

const queueRegistrationSearch = () => {
  if (!registrationSearchInput) return;
  clearTimeout(registrationSearchTimer);
  registrationSearchTimer = setTimeout(
    () => { void runRegistrationSearch(registrationSearchInput.value, false); },
    registrationSearchDebounceMs,
  );
};

// Enter on a phone must put the keyboard away. The form is never allowed to
// submit natively — that would reload the page and hand focus straight back to
// the field — so both the key and the submit event are cancelled and the input
// is blurred before the request goes out.
const submitRegistrationSearch = () => {
  if (!registrationSearchInput) return;
  clearTimeout(registrationSearchTimer);
  registrationSearchInput.blur();
  void runRegistrationSearch(registrationSearchInput.value, true);
};

if (registrationSearchInput && registrationSearchForm) {
  registrationSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitRegistrationSearch();
  });
  registrationSearchInput.addEventListener("input", queueRegistrationSearch);
  registrationSearchInput.addEventListener("search", queueRegistrationSearch);
  registrationSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRegistrationSearch();
  });
}

const showPairing = (data) => {
  pageTitle.textContent = "Pair Duck #" + data.duck.visibleNumber;
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  if (!data.pairingRequired) {
    message.textContent = "This duck cannot be paired in its current inventory or tag state.";
    return;
  }
  if (!workArea || !qrLaunch) {
    message.textContent = "This staff role can inspect this duck but cannot pair it.";
    return;
  }
  if (!currentEvent || !["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(currentEvent.status)) {
    message.textContent = "There is no event currently accepting duck pairing.";
    return;
  }
  message.textContent = qrSupported
    ? "Scan the participant's QR code, or find them by code or name."
    : "Find the participant by code or name, then confirm.";
  workArea.hidden = false;
  qrLaunch.hidden = !qrSupported;
  document.querySelector("[data-pairing-event]").textContent = currentEvent.name;
  // The unpaired list is the resting state of this screen, so it is painted
  // from whatever is currently typed rather than waiting for a first search.
  void runRegistrationSearch(registrationSearchInput?.value || "", false);
};

const load = async () => {
  try {
    const [eventResponse, duck] = await Promise.all([
      fetchJson("/api/v1/events/current"),
      fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token)),
    ]);
    // A refresh already in flight when scanning starts must not repaint the
    // pairing area and release the newly acquired camera.
    if (qrStarting || qrScanning) return;
    // Resolved before anything is painted, so the statement about this duck and
    // the statement about its heat land together rather than one appearing
    // under the staffer a moment later.
    const heatHasNoEligibleRacer = await winnerHeatHasNoEligibleRacer(duck);
    if (qrStarting || qrScanning) return;
    currentEvent = eventResponse.event;
    summary.replaceChildren();
    qrStop(false);
    if (workArea) workArea.hidden = true;
    if (duck.assignment) showInspection(duck);
    else showPairing(duck);
    renderWinnerAction(duck, heatHasNoEligibleRacer);
  } catch (error) {
    if (qrStarting || qrScanning) return;
    if (error.message !== "signed-out") {
      if (error.status === 403 || error.status === 404) {
        selectedRegistration = null;
        currentEvent = null;
        summary.replaceChildren();
        if (workArea) workArea.hidden = true;
        registrationSearchSequence += 1;
        clearTimeout(registrationSearchTimer);
        registrationResults?.replaceChildren();
        setRegistrationStatus("");
        document.querySelector("[data-pairing-review]")?.replaceChildren();
      }
      message.textContent = error.message;
    }
  }
};

const confirmPairing = document.querySelector("[data-confirm-pairing]");
if (confirmPairing) confirmPairing.addEventListener("click", async (event) => {
  if (!selectedRegistration || !currentEvent) return;
  const button = event.currentTarget;
  button.disabled = true;
  const outcome = await pairWithLookupCode(selectedRegistration.lookupCode);
  if (!outcome.ok && !outcome.signedOut) button.disabled = false;
});

staffDuckSubscription = globalThis.quickDucksLive.subscribe({
  domains: ["event", "participants", "ducks", "heats"],
  root,
  refresh: load,
  isBlocked: () => staffDuckBusy > 0 || selectedRegistration !== null || qrScanning,
});
`;

// Progressive enhancement that replaces visible native selects with an
// app-styled combobox trigger and listbox panel. The native select stays in
// the DOM as the form-associated programmatic source of truth: console code
// keeps reading and writing .value / .selectedIndex, rebuilding options with
// replaceChildren/new Option, toggling .disabled, and listening for "change".
export const appSelectHelpersScript = String.raw`
let appSelectInstanceCount = 0;

const appSelectPrototypeAccessor = (target, name) => {
  let prototype = Object.getPrototypeOf(target);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && (descriptor.get || descriptor.set)) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
};

const appSelectInterceptProperty = (select, name, onSet) => {
  const inherited = appSelectPrototypeAccessor(select, name);
  if (inherited !== null) {
    Object.defineProperty(select, name, {
      configurable: true,
      get() { return inherited.get.call(select); },
      set(value) { inherited.set.call(select, value); onSet(); },
    });
    return;
  }
  let stored = select[name];
  Object.defineProperty(select, name, {
    configurable: true,
    get() { return stored; },
    set(value) { stored = value; onSet(); },
  });
};

const appSelectOptionList = (select) => Array.from(select.options || []);

const appSelectOptionText = (option) => String(option.textContent ?? option.label ?? "").trim();

const appSelectFieldLabelText = (select) => {
  const explicit = typeof select.getAttribute === "function" ? select.getAttribute("aria-label") : null;
  if (explicit) return explicit;
  const label = typeof select.closest === "function" ? select.closest("label") : null;
  if (!label) return "";
  const parts = [];
  for (const node of Array.from(label.childNodes || [])) {
    if (node === select || (typeof node.contains === "function" && node.contains(select))) break;
    parts.push(String(node.textContent || ""));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

// Filtering compares on a folded form so "new york" finds "America/New_York"
// and "denver" finds "America/Denver". Matching is substring based because zone
// identifiers are read from the middle as often as from the start.
const appSelectFoldText = (value) => String(value)
  .toLowerCase()
  .replace(/[_/]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const appSelectMatchesFilter = (text, filter) => {
  const needle = appSelectFoldText(filter);
  if (needle === "") return true;
  return appSelectFoldText(text).includes(needle);
};

const createAppSelect = (select, context = {}) => {
  const doc = context.documentObject || document;
  const nativeValue = appSelectPrototypeAccessor(select, "value");
  const nativeSelectedIndex = appSelectPrototypeAccessor(select, "selectedIndex");
  const readValue = () => nativeValue && nativeValue.get ? nativeValue.get.call(select) : select.value;
  const writeSelectedIndex = (index) => {
    if (nativeSelectedIndex && nativeSelectedIndex.set) nativeSelectedIndex.set.call(select, index);
    else select.selectedIndex = index;
  };

  const baseId = "app-select-" + (appSelectInstanceCount += 1);
  const wrapper = doc.createElement("div");
  wrapper.className = "app-select";
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "app-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const valueText = doc.createElement("span");
  valueText.className = "app-select-value";
  const arrow = doc.createElement("span");
  arrow.className = "app-select-arrow";
  arrow.setAttribute("aria-hidden", "true");
  trigger.append(valueText, arrow);
  const panel = doc.createElement("div");
  panel.className = "app-select-panel";
  panel.hidden = true;

  // Long lists opt in to a filter input inside the panel. The panel then stops
  // being the listbox itself so the searchbox never sits inside listbox
  // semantics; short lists keep the original single-element structure.
  const searchable = typeof select.getAttribute === "function"
    && select.getAttribute("data-app-select-search") === "true";
  const fieldLabel = appSelectFieldLabelText(select);
  let searchInput = null;
  let emptyMessage = null;
  let listbox = panel;
  if (searchable) {
    panel.id = baseId + "-panel";
    const searchRow = doc.createElement("div");
    searchRow.className = "app-select-search";
    searchInput = doc.createElement("input");
    searchInput.type = "text";
    searchInput.id = baseId + "-search";
    searchInput.className = "app-select-search-input";
    searchInput.value = "";
    searchInput.setAttribute("role", "combobox");
    searchInput.setAttribute("aria-autocomplete", "list");
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.setAttribute("autocapitalize", "none");
    searchInput.setAttribute("autocorrect", "off");
    searchInput.setAttribute("spellcheck", "false");
    searchInput.setAttribute("placeholder", "Type to filter");
    searchInput.setAttribute("aria-label", fieldLabel ? "Filter " + fieldLabel : "Filter options");
    searchRow.append(searchInput);
    listbox = doc.createElement("div");
    listbox.className = "app-select-list";
    emptyMessage = doc.createElement("p");
    emptyMessage.className = "app-select-empty";
    emptyMessage.setAttribute("role", "status");
    emptyMessage.hidden = true;
    panel.append(searchRow, listbox, emptyMessage);
  }
  listbox.id = baseId + "-listbox";
  listbox.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", listbox.id);
  if (searchInput !== null) searchInput.setAttribute("aria-controls", listbox.id);

  if (fieldLabel) trigger.setAttribute("aria-label", fieldLabel);
  if (typeof select.getAttribute === "function") {
    const labelledBy = select.getAttribute("aria-labelledby");
    if (labelledBy) trigger.setAttribute("aria-labelledby", labelledBy);
    const describedBy = select.getAttribute("aria-describedby");
    if (describedBy) trigger.setAttribute("aria-describedby", describedBy);
  }

  const parent = select.parentNode || null;
  if (parent && typeof parent.insertBefore === "function") parent.insertBefore(wrapper, select);
  wrapper.append(select, trigger, panel);
  if (select.classList) select.classList.add("app-select-native");
  if (typeof select.setAttribute === "function") {
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");
  }

  let openState = false;
  let panelOptions = [];
  let highlighted = -1;
  let typeAheadBuffer = "";
  let typeAheadAt = 0;
  let filterText = "";

  // Whatever holds DOM focus while the panel is open owns aria-activedescendant.
  const highlightHost = () => searchInput !== null ? searchInput : trigger;

  const selectedNativeIndex = () => {
    const options = appSelectOptionList(select);
    const index = typeof select.selectedIndex === "number" ? select.selectedIndex : -1;
    if (index >= 0 && index < options.length) return index;
    return options.findIndex((option) => option.selected === true);
  };

  const syncTrigger = () => {
    const options = appSelectOptionList(select);
    const current = selectedNativeIndex();
    valueText.textContent = current >= 0 && options[current] ? appSelectOptionText(options[current]) : "";
    trigger.disabled = select.disabled === true;
    if (trigger.disabled && openState) close(false);
  };

  const applyHighlight = (index) => {
    highlighted = index;
    let activeElement = null;
    for (const entry of panelOptions) {
      const active = entry.index === index;
      if (entry.element.classList) entry.element.classList[active ? "add" : "remove"]("is-highlighted");
      if (active) activeElement = entry.element;
    }
    const host = highlightHost();
    if (activeElement === null) host.removeAttribute("aria-activedescendant");
    else {
      host.setAttribute("aria-activedescendant", activeElement.id);
      if (typeof activeElement.scrollIntoView === "function") activeElement.scrollIntoView({ block: "nearest" });
    }
  };

  const rebuildPanel = () => {
    listbox.replaceChildren();
    panelOptions = [];
    const current = selectedNativeIndex();
    appSelectOptionList(select).forEach((option, index) => {
      const label = appSelectOptionText(option);
      if (searchable && !appSelectMatchesFilter(label, filterText)) return;
      const item = doc.createElement("div");
      item.id = baseId + "-option-" + index;
      item.className = "app-select-option";
      item.setAttribute("role", "option");
      item.textContent = label;
      const disabled = option.disabled === true;
      if (disabled) item.setAttribute("aria-disabled", "true");
      item.setAttribute("aria-selected", index === current ? "true" : "false");
      if (index === current && item.classList) item.classList.add("is-selected");
      item.addEventListener("pointerdown", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
      });
      item.addEventListener("click", () => {
        if (disabled) return;
        commit(index);
        close(true);
      });
      listbox.append(item);
      panelOptions.push({ element: item, index, disabled, text: label });
    });
    if (emptyMessage !== null) {
      const nothingMatched = panelOptions.length === 0;
      emptyMessage.hidden = !nothingMatched;
      emptyMessage.textContent = nothingMatched ? "No match for “" + filterText + "”." : "";
    }
  };

  const enabledEntries = () => panelOptions.filter((entry) => !entry.disabled);

  const highlightSelectedOrFirst = () => {
    const current = selectedNativeIndex();
    const entries = enabledEntries();
    const selectedEntry = entries.find((entry) => entry.index === current);
    if (selectedEntry) {
      applyHighlight(selectedEntry.index);
      return;
    }
    applyHighlight(entries.length > 0 ? entries[0].index : -1);
  };

  const setFilter = (value) => {
    if (!searchable) return;
    filterText = String(value === undefined || value === null ? "" : value);
    if (searchInput !== null && searchInput.value !== filterText) searchInput.value = filterText;
    if (!openState) return;
    rebuildPanel();
    highlightSelectedOrFirst();
  };

  const open = () => {
    if (openState || select.disabled === true) return;
    filterText = "";
    if (searchInput !== null) {
      searchInput.value = "";
      searchInput.setAttribute("aria-expanded", "true");
    }
    rebuildPanel();
    openState = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    highlightSelectedOrFirst();
    if (searchInput !== null && typeof searchInput.focus === "function") searchInput.focus();
  };

  const close = (returnFocus) => {
    if (!openState) return;
    openState = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (searchInput !== null) {
      searchInput.removeAttribute("aria-activedescendant");
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.value = "";
    }
    filterText = "";
    typeAheadBuffer = "";
    if (returnFocus && typeof trigger.focus === "function") trigger.focus();
  };

  const commit = (index) => {
    const options = appSelectOptionList(select);
    const option = options[index];
    if (!option || option.disabled === true) return;
    const before = readValue();
    writeSelectedIndex(index);
    syncTrigger();
    if (readValue() !== before) select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const moveHighlight = (delta) => {
    const entries = enabledEntries();
    if (entries.length === 0) return;
    const position = entries.findIndex((entry) => entry.index === highlighted);
    const next = position === -1
      ? (delta > 0 ? 0 : entries.length - 1)
      : Math.min(entries.length - 1, Math.max(0, position + delta));
    applyHighlight(entries[next].index);
  };

  const typeAhead = (character, now) => {
    const time = typeof now === "number" ? now : Date.now();
    if (time - typeAheadAt > 700) typeAheadBuffer = "";
    typeAheadAt = time;
    typeAheadBuffer += character.toLowerCase();
    const entries = enabledEntries();
    if (entries.length === 0) return;
    const repeated = typeAheadBuffer.length > 1
      && typeAheadBuffer.split("").every((letter) => letter === typeAheadBuffer[0]);
    const needle = repeated ? typeAheadBuffer[0] : typeAheadBuffer;
    const position = entries.findIndex((entry) => entry.index === highlighted);
    const start = repeated || typeAheadBuffer.length === 1 ? position + 1 : Math.max(position, 0);
    for (let step = 0; step < entries.length; step += 1) {
      const entry = entries[(start + step + entries.length) % entries.length];
      if (entry.text.toLowerCase().startsWith(needle)) {
        applyHighlight(entry.index);
        return;
      }
    }
  };

  // One handler serves the trigger and the filter input. Inside the filter
  // input printable keys and Space belong to the text field, and Home/End move
  // the caret, so those keys keep their native behaviour there.
  const handleKeydown = (event, fromSearch) => {
    const key = event.key;
    const printable = typeof key === "string" && key.length === 1 && key !== " "
      && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!openState) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        open();
      } else if (printable) {
        open();
        if (searchable) {
          if (typeof event.preventDefault === "function") event.preventDefault();
          setFilter(key);
        } else {
          typeAhead(key);
        }
      }
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      moveHighlight(key === "ArrowDown" ? 1 : -1);
    } else if ((key === "Home" || key === "End") && !fromSearch) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      const entries = enabledEntries();
      const entry = key === "Home" ? entries[0] : entries[entries.length - 1];
      if (entry) applyHighlight(entry.index);
    } else if (key === "Enter" || (key === " " && !fromSearch)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (highlighted >= 0) commit(highlighted);
      close(true);
    } else if (key === "Escape") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      close(true);
    } else if (key === "Tab") {
      close(false);
    } else if (printable && !fromSearch) {
      typeAhead(key);
    }
  };

  const handleTriggerKeydown = (event) => handleKeydown(event, false);
  const handleSearchKeydown = (event) => handleKeydown(event, true);

  const handleDocumentPointerDown = (event) => {
    if (!openState) return;
    const target = event ? event.target : null;
    if (target && typeof wrapper.contains === "function" && wrapper.contains(target)) return;
    close(false);
  };

  const refresh = () => {
    syncTrigger();
    if (openState) {
      rebuildPanel();
      highlightSelectedOrFirst();
    }
  };

  trigger.addEventListener("keydown", handleTriggerKeydown);
  trigger.addEventListener("click", () => {
    if (openState) close(true);
    else open();
  });
  if (searchInput !== null) {
    searchInput.addEventListener("keydown", handleSearchKeydown);
    searchInput.addEventListener("input", () => setFilter(searchInput.value));
  }
  select.addEventListener("change", () => syncTrigger());
  select.addEventListener("focus", () => {
    if (typeof trigger.focus === "function") trigger.focus();
  });
  if (select.form && typeof select.form.addEventListener === "function") {
    select.form.addEventListener("reset", () => {
      if (typeof queueMicrotask === "function") queueMicrotask(refresh);
      else refresh();
    });
  }
  if (doc !== null && typeof doc.addEventListener === "function") {
    doc.addEventListener("pointerdown", handleDocumentPointerDown, true);
  }

  appSelectInterceptProperty(select, "value", refresh);
  appSelectInterceptProperty(select, "selectedIndex", refresh);
  let observer = null;
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(refresh);
    observer.observe(select, { attributes: true, childList: true, subtree: true });
  }
  syncTrigger();

  return {
    select,
    wrapper,
    trigger,
    panel,
    listbox,
    searchInput,
    emptyMessage,
    isSearchable: () => searchable,
    refresh,
    open,
    close: (returnFocus = true) => close(returnFocus),
    isOpen: () => openState,
    handleTriggerKeydown,
    handleSearchKeydown,
    handleDocumentPointerDown,
    typeAhead,
    setFilter,
    filterText: () => filterText,
    highlightedIndex: () => highlighted,
    optionElements: () => panelOptions.map((entry) => entry.element),
    disconnect: () => { if (observer !== null) observer.disconnect(); },
  };
};
`;

export const appSelectScript = appSelectHelpersScript + String.raw`
const appSelectEligible = (element) => element instanceof HTMLSelectElement
  && element.dataset.appSelectEnhanced !== "true"
  && !element.multiple
  && !(element.size > 1);

const appSelectEnhance = (element) => {
  if (!appSelectEligible(element)) return;
  element.dataset.appSelectEnhanced = "true";
  createAppSelect(element, { documentObject: document });
};

for (const element of document.querySelectorAll("select")) appSelectEnhance(element);

const appSelectAdditions = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof HTMLSelectElement) appSelectEnhance(node);
      else if (node && typeof node.querySelectorAll === "function") {
        for (const element of node.querySelectorAll("select")) appSelectEnhance(element);
      }
    }
  }
});
appSelectAdditions.observe(document.body, { childList: true, subtree: true });
`;

// App-styled date and date-time picker. The original text input remains the
// form-associated source of truth, so FormData, required validation, resets,
// and the staff console's programmatic .value writes keep their normal
// semantics without exposing a browser- or operating-system-specific picker.
export const appDatePickerHelpersScript = String.raw`
let appDateInstanceCount = 0;

const appDatePad = (value) => String(value).padStart(2, "0");

const appDateParse = (value, mode) => {
  const pattern = mode === "datetime"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = String(value || "").match(pattern);
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: mode === "datetime" ? Number(match[4]) : 0,
    minute: mode === "datetime" ? Number(match[5]) : 0,
  };
  const date = new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
  if (
    parts.year < 1
    || parts.month < 1
    || parts.month > 12
    || parts.day < 1
    || date.getFullYear() !== parts.year
    || date.getMonth() !== parts.month - 1
    || date.getDate() !== parts.day
    || parts.hour < 0
    || parts.hour > 23
    || parts.minute < 0
    || parts.minute > 59
  ) return null;
  return parts;
};

const appDateValue = (parts, mode) => {
  const date = String(parts.year).padStart(4, "0") + "-" + appDatePad(parts.month) + "-" + appDatePad(parts.day);
  return mode === "datetime" ? date + "T" + appDatePad(parts.hour) + ":" + appDatePad(parts.minute) : date;
};

const appDateDisplay = (value, mode, locale = "en-US") => {
  const parts = appDateParse(value, mode);
  if (!parts) return "";
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  return new Intl.DateTimeFormat(locale, mode === "datetime"
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" }).format(date);
};

const appDateMonthDisplay = (year, month, locale = "en-US") =>
  new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1, 12));

const appDateTimeDisplay = (hour, minute, locale = "en-US") =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, hour, minute, 0, 0));

const appDatePrototypeAccessor = (target, name) => {
  let prototype = Object.getPrototypeOf(target);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor && (descriptor.get || descriptor.set)) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
};

const appDateFieldLabel = (input) => {
  const explicit = typeof input.getAttribute === "function" ? input.getAttribute("aria-label") : null;
  if (explicit) return explicit;
  const label = typeof input.closest === "function" ? input.closest("label") : null;
  if (!label) return "Date";
  const parts = [];
  for (const node of Array.from(label.childNodes || [])) {
    if (node === input || (typeof node.contains === "function" && node.contains(input))) break;
    parts.push(String(node.textContent || ""));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim() || "Date";
};

const createAppDatePicker = (input, context = {}) => {
  const doc = context.documentObject || document;
  const mode = input.getAttribute("data-app-date-picker") === "datetime" ? "datetime" : "date";
  const nativeValue = appDatePrototypeAccessor(input, "value");
  const readValue = () => nativeValue && nativeValue.get ? nativeValue.get.call(input) : input.value;
  const writeValue = (value) => {
    if (nativeValue && nativeValue.set) nativeValue.set.call(input, value);
    else input.value = value;
  };
  const fieldLabel = appDateFieldLabel(input);
  const baseId = "app-date-" + (appDateInstanceCount += 1);
  const wrapper = doc.createElement("div");
  wrapper.className = "app-date-picker";
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "app-date-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", fieldLabel);
  if (input.required) trigger.setAttribute("aria-required", "true");
  const describedBy = input.getAttribute("aria-describedby");
  if (describedBy) trigger.setAttribute("aria-describedby", describedBy);
  const valueText = doc.createElement("span");
  valueText.className = "app-date-value";
  const icon = doc.createElement("span");
  icon.className = "app-date-icon";
  icon.setAttribute("aria-hidden", "true");
  trigger.append(valueText, icon);

  const panel = doc.createElement("div");
  panel.id = baseId + "-panel";
  panel.className = "app-date-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Choose " + fieldLabel);
  panel.hidden = true;
  trigger.setAttribute("aria-controls", panel.id);

  const header = doc.createElement("div");
  header.className = "app-date-header";
  const previous = doc.createElement("button");
  previous.type = "button";
  previous.className = "app-date-month-button";
  previous.textContent = "<";
  previous.setAttribute("aria-label", "Previous month");
  const heading = doc.createElement("h3");
  heading.className = "app-date-heading";
  heading.id = baseId + "-heading";
  panel.setAttribute("aria-labelledby", heading.id);
  const next = doc.createElement("button");
  next.type = "button";
  next.className = "app-date-month-button";
  next.textContent = ">";
  next.setAttribute("aria-label", "Next month");
  header.append(previous, heading, next);

  const weekdays = doc.createElement("div");
  weekdays.className = "app-date-weekdays";
  for (const label of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const weekday = doc.createElement("span");
    weekday.className = "app-date-weekday";
    weekday.textContent = label;
    weekdays.append(weekday);
  }
  const grid = doc.createElement("div");
  grid.className = "app-date-grid";

  let timeHourSelect = null;
  let timeMinuteSelect = null;
  let timePeriodSelect = null;
  if (mode === "datetime") {
    const time = doc.createElement("div");
    time.className = "app-date-time";
    const timeLabel = doc.createElement("span");
    timeLabel.className = "label-text";
    timeLabel.textContent = "Time";
    const timeFields = doc.createElement("div");
    timeFields.className = "app-date-time-fields";
    const timeField = (label, select) => {
      const field = doc.createElement("div");
      field.className = "app-date-time-field";
      const fieldLabel = doc.createElement("span");
      fieldLabel.textContent = label;
      select.setAttribute("aria-label", label);
      field.append(fieldLabel, select);
      return field;
    };
    timeHourSelect = doc.createElement("select");
    timeMinuteSelect = doc.createElement("select");
    timePeriodSelect = doc.createElement("select");
    timeFields.append(
      timeField("Hour", timeHourSelect),
      timeField("Minute", timeMinuteSelect),
      timeField("AM or PM", timePeriodSelect),
    );
    time.append(timeLabel, timeFields);
    panel.append(header, weekdays, grid, time);
  } else {
    panel.append(header, weekdays, grid);
  }

  const actions = doc.createElement("div");
  actions.className = "app-date-actions";
  const todayButton = doc.createElement("button");
  todayButton.type = "button";
  todayButton.className = "button secondary small";
  todayButton.textContent = "Today";
  actions.append(todayButton);
  let clearButton = null;
  if (!input.required) {
    clearButton = doc.createElement("button");
    clearButton.type = "button";
    clearButton.className = "button secondary small";
    clearButton.textContent = "Clear";
    actions.append(clearButton);
  }
  let applyButton = null;
  if (mode === "datetime") {
    applyButton = doc.createElement("button");
    applyButton.type = "button";
    applyButton.className = "button small";
    applyButton.textContent = "Apply";
    actions.append(applyButton);
  }
  panel.append(actions);

  const parent = input.parentNode || null;
  if (parent && typeof parent.insertBefore === "function") parent.insertBefore(wrapper, input);
  wrapper.append(input, trigger, panel);
  input.classList.add("app-date-native");
  input.setAttribute("tabindex", "-1");
  input.setAttribute("aria-hidden", "true");

  let openState = false;
  let viewYear = 0;
  let viewMonth = 0;
  let draft = null;
  let syncedValue = readValue();

  const nowParts = () => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: 9, minute: 0 };
  };

  const syncTrigger = () => {
    const value = readValue();
    const display = appDateDisplay(value, mode);
    const visibleValue = display || input.placeholder || (mode === "datetime" ? "Choose date and time" : "Choose date");
    valueText.textContent = visibleValue;
    trigger.setAttribute("aria-label", fieldLabel + ": " + visibleValue + (input.required ? ", required" : ""));
    trigger.setAttribute("aria-invalid", input.required && value === "" ? "true" : "false");
    trigger.classList.toggle("is-empty", display === "");
    trigger.disabled = input.disabled === true;
    syncedValue = value;
    if (trigger.disabled && openState) close(false);
  };

  const populateTimes = () => {
    if (timeHourSelect === null || timeMinuteSelect === null || timePeriodSelect === null || draft === null) return;
    const option = (value, text) => {
      const option = doc.createElement("option");
      option.value = String(value);
      option.textContent = String(text);
      return option;
    };
    const displayHour = draft.hour % 12 || 12;
    timeHourSelect.replaceChildren(...Array.from({ length: 12 }, (_unused, index) => option(index + 1, index + 1)));
    timeMinuteSelect.replaceChildren(...Array.from({ length: 60 }, (_unused, minute) => option(minute, appDatePad(minute))));
    timePeriodSelect.replaceChildren(option("AM", "AM"), option("PM", "PM"));
    timeHourSelect.value = String(displayHour);
    timeMinuteSelect.value = String(draft.minute);
    timePeriodSelect.value = draft.hour >= 12 ? "PM" : "AM";
  };

  const renderMonth = () => {
    heading.textContent = appDateMonthDisplay(viewYear, viewMonth);
    grid.replaceChildren();
    const firstWeekday = new Date(viewYear, viewMonth - 1, 1, 12).getDay();
    const dayCount = new Date(viewYear, viewMonth, 0, 12).getDate();
    const today = nowParts();
    let hasTabStop = false;
    for (let index = 0; index < firstWeekday; index += 1) {
      const blank = doc.createElement("span");
      blank.className = "app-date-blank";
      blank.setAttribute("aria-hidden", "true");
      grid.append(blank);
    }
    for (let day = 1; day <= dayCount; day += 1) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "app-date-day";
      button.textContent = String(day);
      const parts = { year: viewYear, month: viewMonth, day, hour: draft.hour, minute: draft.minute };
      const value = appDateValue(parts, "date");
      button.dataset.dateValue = value;
      button.setAttribute("aria-label", appDateDisplay(value, "date"));
      const selected = draft.year === viewYear && draft.month === viewMonth && draft.day === day;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
      if (selected) hasTabStop = true;
      if (today.year === viewYear && today.month === viewMonth && today.day === day) button.classList.add("is-today");
      button.addEventListener("click", () => {
        draft = parts;
        if (mode === "date") {
          commit();
          close(true);
          return;
        }
        renderMonth();
        const selectedDay = grid.querySelector('[aria-pressed="true"]');
        if (selectedDay) selectedDay.focus();
      });
      grid.append(button);
    }
    if (!hasTabStop) {
      const firstDay = grid.querySelector(".app-date-day");
      if (firstDay) firstDay.tabIndex = 0;
    }
  };

  const setView = (year, month) => {
    const normalized = new Date(year, month - 1, 1, 12);
    viewYear = normalized.getFullYear();
    viewMonth = normalized.getMonth() + 1;
    renderMonth();
  };

  const commit = () => {
    if (draft === null) return;
    if (timeHourSelect !== null && timeMinuteSelect !== null && timePeriodSelect !== null) {
      const hour = Number(timeHourSelect.value) % 12;
      draft.hour = hour + (timePeriodSelect.value === "PM" ? 12 : 0);
      draft.minute = Number(timeMinuteSelect.value);
    }
    const before = readValue();
    const value = appDateValue(draft, mode);
    writeValue(value);
    syncTrigger();
    if (value !== before) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const clear = () => {
    const before = readValue();
    writeValue("");
    syncTrigger();
    if (before !== "") {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close(true);
  };

  const open = () => {
    if (openState || input.disabled === true) return;
    draft = appDateParse(readValue(), mode) || nowParts();
    viewYear = draft.year;
    viewMonth = draft.month;
    populateTimes();
    renderMonth();
    openState = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const selected = grid.querySelector('[aria-pressed="true"]');
    if (selected && typeof selected.focus === "function") selected.focus();
  };

  const close = (returnFocus) => {
    if (!openState) return;
    openState = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    for (const select of [timeHourSelect, timeMinuteSelect, timePeriodSelect]) {
      if (select !== null) delete select.dataset.liveDirty;
    }
    if (returnFocus && typeof trigger.focus === "function") trigger.focus();
  };

  const refreshFromInput = () => {
    const changed = readValue() !== syncedValue;
    syncTrigger();
    if (changed && openState) close(true);
  };

  previous.addEventListener("click", () => setView(viewYear, viewMonth - 1));
  next.addEventListener("click", () => setView(viewYear, viewMonth + 1));
  todayButton.addEventListener("click", () => {
    draft = nowParts();
    setView(draft.year, draft.month);
    populateTimes();
    if (mode === "date") {
      commit();
      close(true);
    }
  });
  if (clearButton !== null) clearButton.addEventListener("click", clear);
  if (applyButton !== null) applyButton.addEventListener("click", () => {
    commit();
    close(true);
  });
  trigger.addEventListener("click", () => openState ? close(true) : open());
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "Enter", " "].includes(event.key) && !openState) {
      event.preventDefault();
      open();
    }
  });
  grid.addEventListener("keydown", (event) => {
    const current = event.target && event.target.dataset ? event.target.dataset.dateValue : null;
    const parts = appDateParse(current, "date");
    if (!parts) return;
    const movement = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (movement === undefined) return;
    event.preventDefault();
    const target = new Date(parts.year, parts.month - 1, parts.day + movement, 12);
    const targetParts = {
      year: target.getFullYear(), month: target.getMonth() + 1, day: target.getDate(), hour: 0, minute: 0,
    };
    const targetValue = appDateValue(targetParts, "date");
    if (targetParts.year !== viewYear || targetParts.month !== viewMonth) setView(targetParts.year, targetParts.month);
    const targetButton = grid.querySelector('[data-date-value="' + targetValue + '"]');
    if (targetButton) {
      for (const day of grid.querySelectorAll(".app-date-day")) day.tabIndex = -1;
      targetButton.tabIndex = 0;
      targetButton.focus();
    }
  });
  doc.addEventListener("keydown", (event) => {
    if (openState && event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  });
  input.addEventListener("focus", () => trigger.focus());
  input.addEventListener("change", refreshFromInput);
  input.addEventListener("invalid", () => {
    syncTrigger();
    trigger.focus();
    open();
  });
  if (input.form) input.form.addEventListener("reset", () => queueMicrotask(() => {
    syncTrigger();
    if (openState) close(true);
  }));
  doc.addEventListener("pointerdown", (event) => {
    if (openState && !wrapper.contains(event.target)) close(false);
  }, true);
  doc.addEventListener("focusin", (event) => {
    if (openState && !wrapper.contains(event.target)) close(false);
  }, true);

  const inherited = appDatePrototypeAccessor(input, "value");
  if (inherited !== null) {
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return inherited.get.call(input); },
      set(value) { inherited.set.call(input, value); refreshFromInput(); },
    });
  }
  syncTrigger();

  return {
    input,
    wrapper,
    trigger,
    panel,
    grid,
    timeSelects: [timeHourSelect, timeMinuteSelect, timePeriodSelect].filter(Boolean),
    open,
    close: (returnFocus = true) => close(returnFocus),
    commit,
    clear,
    refresh: refreshFromInput,
    isOpen: () => openState,
  };
};
`;

export const appDatePickerScript = appDatePickerHelpersScript + String.raw`
for (const input of document.querySelectorAll("input[data-app-date-picker]")) {
  if (input.dataset.appDateEnhanced === "true") continue;
  input.dataset.appDateEnhanced = "true";
  createAppDatePicker(input, { documentObject: document });
}
`;
