export const registrationScript = String.raw`
const form = document.querySelector("[data-registration-form]");
const eventName = document.querySelector("[data-event-name]");
const eventDate = document.querySelector("[data-event-date]");
const formMessage = document.querySelector("[data-form-message]");
const submitButton = form.querySelector("button[type='submit']");
const emailInput = form.elements.email;
const emailLabel = document.querySelector("[data-email-label]");
const protectionReady = form.dataset.protectionReady === "true";
let currentEvent = null;
let pendingCommand = null;

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

fetch("/api/v1/events/current", { headers: { accept: "application/json" } })
  .then((response) => response.ok ? response.json() : Promise.reject())
  .then(({ event }) => {
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
  })
  .catch(() => {
    eventName.textContent = "Race details unavailable";
    eventDate.textContent = "Please refresh and try again.";
    submitButton.disabled = true;
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
    emailNotificationsEnabled: data.get("email_notifications_enabled") === "on",
    duckKeepPreference: data.get("duck_keep_preference"),
    turnstileToken,
    clientTimestamp: new Date().toISOString(),
  };

  submitButton.disabled = true;
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
    location.assign(body.privateStatusPath);
  } catch {
    setMessage("The network interrupted registration. Try again; the same request will be retried safely.", true);
    submitButton.disabled = false;
  }
});
`;

export const staffHomeScript = String.raw`
const operationsRoot = document.querySelector("[data-operations-root]");
const isSystemAdmin = operationsRoot.dataset.systemAdmin === "true";
const consoleMessage = document.querySelector("[data-console-message]");
const eventSelect = document.querySelector("[data-event-select]");
let currentEvent = null;
let currentEventDetail = null;
let selectedRegistration = null;
let selectedDuck = null;
let selectedHeat = null;
let pendingHeatPlan = null;
let reviewEvent = null;

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
  setMessage(loadingMessage);
  try {
    const result = await operation();
    setMessage("Saved. Current data has been refreshed.");
    return result;
  } catch (error) {
    if (error.message !== "signed-out") setMessage(error.message, true);
    return null;
  } finally {
    button.disabled = false;
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

const eventSummary = document.querySelector("[data-event-summary]");
const readinessList = document.querySelector("[data-event-readiness]");
const eventConfigCard = document.querySelector("[data-event-config-card]");
const eventConfigForm = document.querySelector("[data-event-config-form]");
const deleteDraftCard = document.querySelector("[data-delete-draft-card]");
const deleteDraftForm = document.querySelector("[data-delete-draft-form]");

const lifecycleLabels = {
  "open-registration": "Open registration",
  "close-registration": "Close registration",
  "reopen-registration": "Reopen registration",
  "start-round-one": "Start round one",
  "start-final": "Start final",
  complete: "Complete event",
  "start-return-processing": "Start return processing",
};

const renderReadiness = (readiness) => {
  readinessList.replaceChildren();
  for (const [action, state] of Object.entries(readiness)) {
    const card = text("div", "", "data-card");
    card.append(text("h3", lifecycleLabels[action] || humanize(action)));
    card.append(text("span", state.allowed ? "Ready" : "Blocked", "status-chip " + (state.allowed ? "ready" : "blocked")));
    if (state.requiresAdmin) card.append(text("span", "Administrator", "status-chip"));
    for (const blocker of state.blockers) card.append(text("p", blocker, "muted"));
    if (!state.requiresAdmin || isSystemAdmin) {
      const button = text("button", lifecycleLabels[action] || humanize(action), "button small");
      button.type = "button";
      button.disabled = !state.allowed;
      button.addEventListener("click", async () => {
        if (!confirm("Run “" + button.textContent + "” for " + currentEvent.name + "?")) return;
        await perform(button, "Running event transition…", async () => {
          await api(
            "/api/v1/staff/events/" + encodeURIComponent(currentEvent.id) + "/" + action,
            commandOptions("POST", { commandId: crypto.randomUUID() }),
          );
          await loadEvents(currentEvent.id);
        });
      });
      card.append(button);
    }
    readinessList.append(card);
  }
};

const renderEvent = (detail, readiness) => {
  currentEvent = detail.event;
  currentEventDetail = detail;
  showFacts(eventSummary, [
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
    eventConfigForm.elements.slug.value = currentEvent.slug;
    eventConfigForm.elements.eventDate.value = currentEvent.eventDate || "";
    eventConfigForm.elements.timezone.value = currentEvent.timezone;
    eventConfigForm.elements.registrationOpensAt.value = toLocalInput(currentEvent.registrationOpensAt);
    eventConfigForm.elements.registrationClosesAt.value = toLocalInput(currentEvent.registrationClosesAt);
    eventConfigForm.elements.emailRequired.checked = currentEvent.emailRequired;
    eventConfigForm.elements.heatAssignmentMode.value = currentEvent.heatAssignmentMode;
    eventConfigForm.elements.roundOneHeatCapacity.value = currentEvent.roundOneHeatCapacity;
    eventConfigForm.elements.finalHeatCapacity.value = currentEvent.finalHeatCapacity;
    eventConfigForm.elements.publicNamePolicy.value = currentEvent.publicNamePolicy;
  }
  if (deleteDraftCard) {
    deleteDraftCard.hidden = currentEvent.status !== "DRAFT";
    deleteDraftForm.elements.confirmation.placeholder = "DELETE " + currentEvent.name;
  }
};

const loadEvents = async (preferredId) => {
  const body = await api("/api/v1/staff/events", { headers: { accept: "application/json" } });
  eventSelect.replaceChildren();
  if (body.events.length === 0) {
    eventSelect.append(new Option("No event exists", ""));
    currentEvent = null;
    eventSummary.replaceChildren(empty("Create a draft event to begin."));
    readinessList.replaceChildren(empty("No lifecycle is available."));
    setMessage("No event dataset exists. An administrator can create one.");
    const loads = [loadInventory(), loadReturnReview()];
    if (isSystemAdmin) loads.push(loadStaffProfiles());
    await Promise.allSettled(loads);
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
  const [detail, readiness] = await Promise.all([
    api("/api/v1/staff/events/" + encodeURIComponent(eventId)),
    api("/api/v1/staff/events/" + encodeURIComponent(eventId) + "/readiness"),
  ]);
  renderEvent(detail, readiness);
  const loads = [loadParticipants(), loadInventory(), loadHeats(), loadFinalists(), loadReturnReview()];
  if (isSystemAdmin) loads.push(loadSupportSummary(), loadNotifications(), loadAudit(), loadPurgeGate(), loadStaffProfiles());
  const results = await Promise.allSettled(loads);
  const failed = results.filter((result) => result.status === "rejected");
  setMessage(failed.length === 0
    ? "All operation areas are current."
    : failed.length + " operation area" + (failed.length === 1 ? " is" : "s are") + " temporarily unavailable.", failed.length > 0);
};

eventSelect.addEventListener("change", () => {
  if (eventSelect.value) loadEvent(eventSelect.value).catch((error) => setMessage(error.message, true));
});
document.querySelector("[data-refresh-event]").addEventListener("click", () => {
  if (eventSelect.value) loadEvent(eventSelect.value).catch((error) => setMessage(error.message, true));
});

const eventCreateForm = document.querySelector("[data-event-create-form]");
if (eventCreateForm) eventCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Creating draft event…", async () => {
    const result = await api("/api/v1/staff/events", commandOptions("POST", {
      commandId: crypto.randomUUID(),
      name: String(values.get("name")),
      slug: String(values.get("slug")),
      eventDate: String(values.get("eventDate")),
    }));
    form.reset();
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
        slug: String(values.get("slug")),
        eventDate: String(values.get("eventDate")) || null,
        timezone: String(values.get("timezone")),
        registrationOpensAt: fromLocalInput(String(values.get("registrationOpensAt"))),
        registrationClosesAt: fromLocalInput(String(values.get("registrationClosesAt"))),
        emailRequired: values.get("emailRequired") === "on",
        heatAssignmentMode: String(values.get("heatAssignmentMode")),
        roundOneHeatCapacity: Number(values.get("roundOneHeatCapacity")),
        finalHeatCapacity: Number(values.get("finalHeatCapacity")),
        publicNamePolicy: String(values.get("publicNamePolicy")),
      }),
    );
    await loadEvents(currentEvent.id);
  });
});

if (deleteDraftForm) deleteDraftForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const confirmation = String(new FormData(form).get("confirmation"));
  if (!confirm("Delete this empty draft? This cannot be undone.")) return;
  await perform(button, "Checking and deleting empty draft…", async () => {
    await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()),
      commandOptions("DELETE", { commandId: crypto.randomUUID(), revision: currentEvent.revision, confirmation }),
    );
    currentEvent = null;
    await loadEvents();
  });
});

const participantFilterForm = document.querySelector("[data-participant-filter-form]");
const participantList = document.querySelector("[data-participant-list]");
const participantDetail = document.querySelector("[data-participant-detail]");
const participantFacts = document.querySelector("[data-participant-facts]");
const participantEditForm = document.querySelector("[data-participant-edit-form]");
const participantActions = document.querySelector("[data-participant-actions]");

const participantQuery = () => {
  const values = new FormData(participantFilterForm);
  const parameters = new URLSearchParams({ limit: "200" });
  for (const name of ["q", "status", "createdVia", "assignment"]) {
    const value = String(values.get(name) || "");
    if (value) parameters.set(name, value);
  }
  return parameters;
};

const loadParticipants = async () => {
  if (!currentEvent) return;
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
    button.addEventListener("click", () => loadParticipantDetail(registration.registrationId)
      .catch((error) => setMessage(error.message, true)));
    participantList.append(button);
  }
};

const addParticipantAction = (label, className, action) => {
  const button = text("button", label, className);
  button.type = "button";
  button.addEventListener("click", action);
  participantActions.append(button);
};

const changeParticipantStatus = async (operation, label, dangerous, button) => {
  if (dangerous && !confirm(label + " for " + selectedRegistration.firstName + " " + selectedRegistration.lastName + "?")) return;
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
    ["Duck", registration.assignment ? "#" + registration.assignment.duck.visibleNumber : "Unassigned"],
    ["Race entry", registration.raceEntryId],
    ["Revision", registration.revision],
  ]);
  participantEditForm.elements.firstName.value = registration.firstName;
  participantEditForm.elements.lastName.value = registration.lastName;
  participantEditForm.elements.email.value = registration.email || "";
  participantEditForm.elements.phone.value = registration.phone || "";
  participantEditForm.elements.emailNotificationsEnabled.checked = registration.emailNotificationsEnabled;
  participantEditForm.elements.duckKeepPreference.value = registration.duckKeepPreference;
  participantEditForm.elements.notes.value = registration.notes || "";
  participantActions.replaceChildren();
  addParticipantAction("Use for duck assignment", "button secondary small", () => {
    document.querySelector("[data-inventory-assign-form]").elements.raceEntryId.value = registration.raceEntryId;
    document.querySelector("#inventory").scrollIntoView({ behavior: "smooth" });
  });
  if (["SUBMITTED", "ACTIVE"].includes(registration.status)) {
    addParticipantAction("Withdraw", "button danger small", (event) => changeParticipantStatus("withdraw", "Withdraw participant", true, event.currentTarget));
    if (isSystemAdmin) addParticipantAction("Disqualify", "button danger small", (event) => changeParticipantStatus("disqualify", "Disqualify participant", true, event.currentTarget));
  }
  if (isSystemAdmin && ["WITHDRAWN", "DISQUALIFIED"].includes(registration.status)) {
    addParticipantAction("Reactivate", "button small", (event) => {
      const button = event.currentTarget;
      if (!confirm("Reactivate this participant?")) return;
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
};

const loadParticipantDetail = async (registrationId) => {
  const body = await api("/api/v1/staff/registrations/" + encodeURIComponent(registrationId));
  renderParticipantDetail(body.registration);
};

participantFilterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadParticipants().catch((error) => setMessage(error.message, true));
});

document.querySelector("[data-walkup-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const resultTarget = document.querySelector("[data-walkup-result]");
  const values = new FormData(form);
  await perform(button, "Creating walk-up registration…", async () => {
    const privateToken = randomPrivateToken();
    const result = await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/registrations",
      commandOptions("POST", {
        commandId: crypto.randomUUID(),
        privateToken,
        firstName: String(values.get("firstName")),
        lastName: String(values.get("lastName")),
        email: String(values.get("email")) || null,
        phone: String(values.get("phone")) || null,
        emailNotificationsEnabled: values.get("emailNotificationsEnabled") === "on",
        duckKeepPreference: String(values.get("duckKeepPreference")),
        notes: String(values.get("notes")) || null,
        clientTimestamp: new Date().toISOString(),
      }),
    );
    const link = text("a", "Open private participant status");
    link.href = result.privateStatusPath;
    link.target = "_blank";
    link.rel = "noopener";
    resultTarget.replaceChildren(text("strong", "Lookup code: " + result.registration.lookupCode + " · "), link);
    form.reset();
    await loadParticipants();
    renderParticipantDetail(result.registration);
  });
});

participantEditForm.addEventListener("submit", async (event) => {
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
        emailNotificationsEnabled: values.get("emailNotificationsEnabled") === "on",
        duckKeepPreference: String(values.get("duckKeepPreference")),
        notes: String(values.get("notes")) || null,
      }),
    );
    renderParticipantDetail(result.registration);
    await loadParticipants();
  });
});

const inventoryList = document.querySelector("[data-inventory-list]");
const inventoryDetail = document.querySelector("[data-inventory-detail]");
const inventoryFacts = document.querySelector("[data-inventory-facts]");
const inventoryHistory = document.querySelector("[data-inventory-history]");
const inventoryEditForm = document.querySelector("[data-inventory-edit-form]");
const unassignForm = document.querySelector("[data-inventory-unassign-form]");
const releaseReservationForm = document.querySelector("[data-reservation-release-form]");

const loadInventory = async () => {
  const body = await api("/api/v1/staff/inventory/ducks");
  inventoryList.replaceChildren();
  if (body.ducks.length === 0) inventoryList.append(empty("No ducks are in inventory."));
  for (const duck of body.ducks) {
    const eventLabel = duck.reservation && !duck.reservation.releasedAt ? " · " + duck.reservation.event.name : "";
    const button = text("button", "Duck #" + duck.visibleNumber + " · " + humanize(duck.inventoryStatus) + eventLabel, "result-button");
    button.type = "button";
    button.addEventListener("click", () => loadDuckDetail(duck.id).catch((error) => setMessage(error.message, true)));
    inventoryList.append(button);
  }
};

const historyCard = (title, detail) => {
  const card = text("div", "", "data-card");
  card.append(text("h3", title), text("p", detail, "muted"));
  return card;
};

const renderDuckDetail = (body) => {
  selectedDuck = body.duck;
  const duck = body.duck;
  inventoryDetail.hidden = false;
  document.querySelector("[data-inventory-name]").textContent = "Duck #" + duck.visibleNumber;
  showFacts(inventoryFacts, [
    ["Inventory", humanize(duck.inventoryStatus)],
    ["Condition", humanize(duck.condition)],
    ["Location", duck.location || "Not set"],
    ["Tag", duck.tag ? humanize(duck.tag.status) : "No tag"],
    ["Reservation", duck.reservation ? duck.reservation.event.name + (duck.reservation.releasedAt ? " · released" : " · active") : "None"],
    ["Participant", duck.participant ? duck.participant.firstName + " " + duck.participant.lastName : "Unassigned"],
    ["Heat", duck.heat ? humanize(duck.heat.round) + " " + duck.heat.number : "None"],
    ["Revision", duck.revision],
  ]);
  inventoryEditForm.elements.visibleNumber.value = duck.visibleNumber;
  inventoryEditForm.elements.condition.value = duck.condition;
  inventoryEditForm.elements.location.value = duck.location || "";
  inventoryEditForm.elements.notes.value = duck.notes || "";
  unassignForm.hidden = !duck.assignment;
  releaseReservationForm.hidden = !duck.reservation || Boolean(duck.reservation.releasedAt) || Boolean(duck.assignment);
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
    inventoryHistory.append(historyCard("Assignment · " + item.participant.firstName + " " + item.participant.lastName, item.validTo ? "Closed " + item.validTo : "Active since " + item.validFrom));
  }
  if (!inventoryHistory.childElementCount) inventoryHistory.append(empty("No inventory history is recorded."));
};

const loadDuckDetail = async (duckId) => {
  const body = await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(duckId));
  renderDuckDetail(body);
};

const refreshSelectedDuck = async () => {
  const duckId = selectedDuck.id;
  await Promise.all([loadInventory(), loadDuckDetail(duckId), loadParticipants()]);
};

document.querySelector("[data-refresh-inventory]").addEventListener("click", () => loadInventory()
  .catch((error) => setMessage(error.message, true)));

document.querySelector("[data-inventory-intake-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Saving physical inventory intake…", async () => {
    const result = await api("/api/v1/staff/inventory/ducks", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(),
      visibleNumber: Number(values.get("visibleNumber")), tagToken: String(values.get("tagToken")),
      condition: String(values.get("condition")), location: String(values.get("location")) || null,
      notes: String(values.get("notes")) || null, physicallyPresent: values.get("physicallyPresent") === "on",
    }));
    form.reset();
    await loadInventory();
    await loadDuckDetail(result.duck.id);
  });
});

inventoryEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Saving inventory changes…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id), commandOptions("PATCH", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision,
      visibleNumber: Number(values.get("visibleNumber")), condition: String(values.get("condition")),
      location: String(values.get("location")) || null, notes: String(values.get("notes")) || null,
    }));
    await refreshSelectedDuck();
  });
});

document.querySelector("[data-tag-replace-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  if (!confirm("Retire the current tag and activate this verified replacement?")) return;
  await perform(button, "Replacing active tag…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/tags/replace", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision,
      tagToken: String(values.get("tagToken")), physicalTagVerified: values.get("physicalTagVerified") === "on",
    }));
    form.reset();
    await refreshSelectedDuck();
  });
});

document.querySelector("[data-tag-retire-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  if (!confirm("Retire this tag without a replacement? The duck will be quarantined.")) return;
  await perform(button, "Retiring active tag…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/tags/retire", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision,
      reason: String(values.get("reason")), physicalTagRemoved: values.get("physicalTagRemoved") === "on",
    }));
    form.reset();
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

document.querySelector("[data-inventory-assign-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  if (!selectedDuck) {
    setMessage("Select an inventory duck first.", true);
    return;
  }
  if (!confirm("Assign Duck #" + selectedDuck.visibleNumber + " to this race entry?")) return;
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
  if (!confirm("Unassign Duck #" + selectedDuck.visibleNumber + " from its participant?")) return;
  await perform(button, "Unassigning duck…", async () => {
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
  if (!confirm("Release Duck #" + selectedDuck.visibleNumber + " from this event?")) return;
  await perform(button, "Releasing reservation…", async () => {
    await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(selectedDuck.id) + "/reservations/release", commandOptions("POST", {
      commandId: crypto.randomUUID(), eventId: currentEventId(), expectedRevision: selectedDuck.revision, reason,
    }));
    form.reset();
    await refreshSelectedDuck();
  });
});

const heatList = document.querySelector("[data-heat-list]");
const heatDetail = document.querySelector("[data-heat-detail]");
const heatFacts = document.querySelector("[data-heat-facts]");
const heatRoster = document.querySelector("[data-heat-roster]");
const heatResults = document.querySelector("[data-heat-results]");
const heatControls = document.querySelector("[data-heat-controls]");
const finalistList = document.querySelector("[data-finalist-list]");
const planResult = document.querySelector("[data-plan-result]");
const planCommitButton = document.querySelector("[data-plan-commit]");

const loadHeats = async () => {
  if (!currentEvent) return;
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

const addRosterForm = (body) => {
  if (body.heat.status !== "PLANNED" || body.heat.rosterLocked) return;
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

const resultForm = (body, mode) => {
  const form = text("form", "", "operation-card");
  form.append(text("h3", mode === "finalize" ? "Finalize result" : "Correct published result"));
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
    : Array.from({ length: Math.min(3, body.roster.length) }, (_, index) => index + 1);
  const selects = [];
  for (const place of places) {
    const label = text("label", place === 1 ? "First place" : place === 2 ? "Second place" : "Third place");
    const select = document.createElement("select");
    select.required = true;
    select.append(new Option("Choose roster entry", ""));
    for (const entry of body.roster) {
      select.append(new Option(
        entry.participant.firstName + " " + entry.participant.lastName + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : ""),
        entry.raceEntryId,
      ));
    }
    const published = body.results.find((result) => result.place === place);
    if (published) select.value = published.raceEntryId;
    label.append(select);
    form.append(label);
    selects.push([place, select]);
  }
  const button = text("button", mode === "finalize" ? "Publish final result" : "Publish corrected result", mode === "finalize" ? "button" : "button danger");
  button.type = "submit";
  form.append(button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!confirm((mode === "finalize" ? "Publish" : "Replace") + " this official heat result?")) return;
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
  const transition = {
    PLANNED: ["lock", "Lock roster"], LOADING: ["ready", "Mark ready"], READY: ["call", "Call heat"],
    CALLING: ["start", "Start heat"], RUNNING: ["finish", "Finish heat"],
  }[body.heat.status];
  if (transition) {
    const button = text("button", transition[1], "button small");
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!confirm(transition[1] + "?")) return;
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
  const announcerButton = text("button", "Load announcer roster", "button secondary small");
  announcerButton.type = "button";
  announcerButton.addEventListener("click", async () => {
    await perform(announcerButton, "Loading announcer roster…", async () => {
      const result = await api(
        "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/" + encodeURIComponent(selectedHeat.id) + "/announcer-roster",
      );
      heatRoster.replaceChildren();
      for (const entry of result.roster) heatRoster.append(text("li", "Slot " + entry.slotNumber + " · " + entry.displayName + " · Duck #" + entry.duckNumber));
    });
  });
  heatControls.append(announcerButton);
  addRosterForm(body);
  if (body.heat.status === "AWAITING_RESULT") heatControls.append(resultForm(body, "finalize"));
  if (body.heat.status === "FINALIZED" && body.results.length > 0) {
    heatControls.append(resultForm(body, "correct"));
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
      if (!confirm("Reopen this published result and remove downstream finalist promotion when applicable?")) return;
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
  for (const entry of body.roster) heatRoster.append(text("li", "Slot " + entry.slotNumber + " · " + entry.participant.firstName + " " + entry.participant.lastName + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · No duck")));
  if (body.roster.length === 0) heatRoster.append(empty("This heat has no roster entries."));
  heatResults.replaceChildren();
  for (const result of body.results) heatResults.append(historyCard("Place " + result.place + " · Duck #" + result.duck.visibleNumber, result.participant.firstName + " " + result.participant.lastName));
  if (body.results.length === 0) heatResults.append(empty("No result has been published."));
  renderHeatControls(body);
};

document.querySelector("[data-refresh-heats]").addEventListener("click", () => loadHeats().catch((error) => setMessage(error.message, true)));

document.querySelector("[data-plan-preview]").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  await perform(button, "Building balanced heat preview…", async () => {
    pendingHeatPlan = await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/round-one/plan-preview",
      { method: "POST", headers: { accept: "application/json" } },
    );
    planResult.replaceChildren();
    for (const heat of pendingHeatPlan.heats) planResult.append(historyCard("Heat " + heat.number + " · " + heat.size + " ducks", heat.entries.map((entry) => "#" + entry.duck.visibleNumber + " " + entry.participant.firstName + " " + entry.participant.lastName).join(" · ")));
    planCommitButton.disabled = false;
  });
});

planCommitButton.addEventListener("click", async () => {
  if (!pendingHeatPlan || !confirm("Commit this exact balanced plan? Rosters become operational race data.")) return;
  await perform(planCommitButton, "Committing balanced heat plan…", async () => {
    await api(
      "/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/heats/round-one/plan-commit",
      commandOptions("POST", { commandId: crypto.randomUUID(), fingerprint: pendingHeatPlan.fingerprint }),
    );
    pendingHeatPlan = null;
    planCommitButton.disabled = true;
    await loadEvents(currentEvent.id);
  });
});

const loadFinalists = async () => {
  if (!currentEvent) return;
  const body = await api("/api/v1/staff/events/" + encodeURIComponent(currentEvent.id) + "/finalists");
  finalistList.replaceChildren();
  finalistList.append(text("p", body.verification.verified ? "Finalist roster verified." : "Finalist roster is not yet verified.", body.verification.verified ? "status-chip ready" : "status-chip blocked"));
  for (const finalist of body.finalists) finalistList.append(historyCard("Slot " + finalist.slotNumber + " · Duck #" + finalist.duck.visibleNumber, finalist.participant.firstName + " " + finalist.participant.lastName + " · won Heat " + finalist.qualifiedFrom.heatNumber + (finalist.podiumPlace ? " · podium " + finalist.podiumPlace : "")));
};
document.querySelector("[data-refresh-finalists]").addEventListener("click", () => loadFinalists().catch((error) => setMessage(error.message, true)));

const returnReview = document.querySelector("[data-return-review]");
const returnTitle = document.querySelector("[data-return-title]");
const returnMessage = document.querySelector("[data-return-message]");
const returnSummary = document.querySelector("[data-return-summary]");
const numberedDispositionForm = document.querySelector("[data-numbered-disposition-form]");
const purgeReadyForm = document.querySelector("[data-purge-ready-form]");
const cancelPurgeReadyForm = document.querySelector("[data-cancel-purge-ready-form]");

const loadReturnReview = async () => {
  const body = await api("/api/v1/staff/events/return-review");
  reviewEvent = body.event;
  numberedDispositionForm.hidden = true;
  purgeReadyForm.hidden = true;
  cancelPurgeReadyForm.hidden = true;
  returnSummary.replaceChildren();
  if (!reviewEvent) {
    returnReview.hidden = true;
    return;
  }
  returnReview.hidden = false;
  returnTitle.textContent = reviewEvent.name;
  const dispositions = Object.entries(body.review.dispositions).map(([name, count]) => humanize(name) + ": " + count).join(" · ");
  showFacts(returnSummary, [["Event status", humanize(reviewEvent.status)], ["Physical ducks", body.review.totalDucks], ["Unresolved", body.review.unresolvedDucks], ["Unreleased", body.review.unreleasedDucks], ["Dispositions", dispositions || "None recorded"]]);
  if (body.review.unresolvedDuckNumbers.length > 0) addFact(returnSummary, "Unresolved numbers", body.review.unresolvedDuckNumbers.join(", "));
  const blocked = body.review.unresolvedDucks > 0 || body.review.unreleasedDucks > 0 || body.review.hasBlockingHeat || body.review.hasActiveAssignment;
  if (reviewEvent.status === "ARCHIVED") {
    setMessage("This event is read-only and purge-ready.", false, returnMessage);
    if (isSystemAdmin) cancelPurgeReadyForm.hidden = false;
  } else {
    numberedDispositionForm.hidden = false;
    setMessage(blocked ? "Finish every disposition, reservation, assignment, and active heat." : "All automated return gates pass.", blocked, returnMessage);
    if (isSystemAdmin) {
      purgeReadyForm.hidden = false;
      purgeReadyForm.querySelector("button").disabled = blocked;
    }
  }
};

numberedDispositionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  await perform(button, "Saving physical disposition…", async () => {
    await api(
      "/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id) + "/ducks/" + encodeURIComponent(String(values.get("visibleNumber"))) + "/dispositions",
      commandOptions("POST", { commandId: crypto.randomUUID(), disposition: String(values.get("disposition")) }),
    );
    form.reset();
    await Promise.all([loadReturnReview(), loadInventory()]);
  });
});

purgeReadyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  if (!confirm("Mark this event purge-ready and disable normal race changes?")) return;
  await perform(button, "Validating final return gates…", async () => {
    await api("/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id) + "/purge-ready", commandOptions("POST", {
      commandId: crypto.randomUUID(), returnReviewCompleted: true, permanentDeletionAcknowledged: true,
    }));
    await Promise.all([loadEvents(reviewEvent.id), loadReturnReview()]);
  });
});

cancelPurgeReadyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const reason = String(new FormData(form).get("reason"));
  await perform(button, "Reopening return processing…", async () => {
    await api("/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id) + "/purge-ready/cancel", commandOptions("POST", { commandId: crypto.randomUUID(), reason }));
    form.reset();
    await loadEvents(reviewEvent.id);
  });
});

const returnBatchId = document.querySelector("[data-return-batch-id]");
const returnBatchMessage = document.querySelector("[data-return-batch-message]");
document.querySelector("[data-create-return-batch]").addEventListener("click", async (event) => {
  await perform(event.currentTarget, "Starting return batch…", async () => {
    const result = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/return-batches", commandOptions("POST", { commandId: crypto.randomUUID() }));
    returnBatchId.value = result.batch.id;
    setMessage("Batch " + result.batch.id + " is open.", false, returnBatchMessage);
  });
});

document.querySelector("[data-return-batch-item-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  const batchId = returnBatchId.value.trim();
  if (!batchId) {
    setMessage("Start a batch or enter its ID first.", true, returnBatchMessage);
    return;
  }
  await perform(button, "Adding duck to return batch…", async () => {
    const result = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/return-batches/" + encodeURIComponent(batchId) + "/items", commandOptions("POST", {
      commandId: crypto.randomUUID(), visibleNumber: Number(values.get("visibleNumber")), disposition: String(values.get("disposition")),
    }));
    form.elements.visibleNumber.value = "";
    setMessage("Staged Duck #" + result.item.visibleNumber + " as " + humanize(result.item.disposition) + ".", false, returnBatchMessage);
  });
});

document.querySelector("[data-undo-return-item]").addEventListener("click", async (event) => {
  const batchId = returnBatchId.value.trim();
  if (!batchId) {
    setMessage("Start a batch or enter its ID first.", true, returnBatchMessage);
    return;
  }
  await perform(event.currentTarget, "Undoing latest return item…", async () => {
    const result = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/return-batches/" + encodeURIComponent(batchId) + "/undo-last", commandOptions("POST", { commandId: crypto.randomUUID() }));
    setMessage("Undid staged Duck #" + result.item.visibleNumber + ".", false, returnBatchMessage);
  });
});

document.querySelector("[data-finalize-return-batch]").addEventListener("click", async (event) => {
  const batchId = returnBatchId.value.trim();
  if (!batchId) {
    setMessage("Start a batch or enter its ID first.", true, returnBatchMessage);
    return;
  }
  if (!confirm("Finalize this return batch? Every staged disposition will become authoritative.")) return;
  await perform(event.currentTarget, "Finalizing return batch…", async () => {
    const result = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/return-batches/" + encodeURIComponent(batchId) + "/finalize", commandOptions("POST", { commandId: crypto.randomUUID() }));
    setMessage("Finalized " + result.batch.itemCount + " return items.", false, returnBatchMessage);
    returnBatchId.value = "";
    await Promise.all([loadReturnReview(), loadInventory()]);
  });
});

const supportSummary = document.querySelector("[data-support-summary]");
const notificationList = document.querySelector("[data-notification-list]");
const notificationAttempts = document.querySelector("[data-notification-attempts]");
const auditList = document.querySelector("[data-audit-list]");
const purgeGate = document.querySelector("[data-purge-gate]");
const purgeClaimForm = document.querySelector("[data-purge-claim-form]");
const finalPurgeForm = document.querySelector("[data-final-purge-form]");

const loadSupportSummary = async () => {
  if (!isSystemAdmin || !currentEvent) return;
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/summary");
  showFacts(supportSummary, [
    ["Total blockers", body.blockerCount], ["Registration", body.areas.registration.blockerCount],
    ["Inventory", body.areas.duck.blockerCount], ["Heats", body.areas.heat.blockerCount],
    ["Returns", body.areas.return.blockerCount], ["Notifications", body.areas.notification.blockerCount],
  ]);
};

const notificationAction = async (notification, action, reason, button) => {
  const label = action === "retry" ? "Retry" : action === "suppress" ? "Suppress" : "Cancel";
  if (!confirm(label + " this notification?")) return;
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
  if (!isSystemAdmin || !currentEvent) return;
  const form = document.querySelector("[data-notification-filter-form]");
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
  if (!isSystemAdmin || !currentEvent) return;
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/audit?limit=200");
  auditList.replaceChildren();
  for (const item of body.events) auditList.append(historyCard(humanize(item.action), item.occurredAt + " · " + (item.actorDisplayName || humanize(item.actorType)) + (item.code ? " · " + item.code : "")));
  if (body.events.length === 0) auditList.append(empty("No audit events are recorded."));
};

const loadPurgeGate = async () => {
  if (!isSystemAdmin || !currentEvent) return;
  const body = await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEvent.id) + "/purge-gate");
  const blockerText = Object.entries(body.blockers).filter(([, value]) => value === true || Number(value) > 0).map(([name, value]) => humanize(name) + ": " + value).join(" · ");
  showFacts(purgeGate, [["Gate", body.ready ? "Ready" : "Blocked"], ["Blockers", blockerText || "None"], ["Claim", body.claim ? humanize(body.claim.status) : "Not claimed"], ["Claimed by", body.claim && body.claim.claimedBy ? body.claim.claimedBy : "None"]]);
  purgeClaimForm.hidden = !body.ready;
  finalPurgeForm.hidden = !body.claim || body.claim.status !== "PURGING";
  const expected = "DELETE " + body.event.name;
  purgeClaimForm.elements.confirmation.placeholder = expected;
  finalPurgeForm.elements.confirmation.placeholder = expected;
};

if (isSystemAdmin) {
  document.querySelector("[data-refresh-support]").addEventListener("click", () => loadSupportSummary().catch((error) => setMessage(error.message, true)));
  document.querySelector("[data-refresh-purge-gate]").addEventListener("click", () => loadPurgeGate().catch((error) => setMessage(error.message, true)));
  document.querySelector("[data-notification-filter-form]").addEventListener("submit", (event) => { event.preventDefault(); loadNotifications().catch((error) => setMessage(error.message, true)); });
  document.querySelector("[data-refresh-audit]").addEventListener("click", () => loadAudit().catch((error) => setMessage(error.message, true)));
  purgeClaimForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const confirmation = String(new FormData(form).get("confirmation"));
    if (!confirm("Claim this event for permanent purge? Support mutations will be frozen.")) return;
    await perform(button, "Claiming permanent purge…", async () => {
      await api("/api/v1/staff/support/events/" + encodeURIComponent(currentEventId()) + "/purge-claim", commandOptions("POST", { commandId: crypto.randomUUID(), confirmation }));
      await loadPurgeGate();
    });
  });
  finalPurgeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const confirmation = String(new FormData(form).get("confirmation"));
    if (!confirm("Permanently delete the complete race dataset now? This cannot be undone.")) return;
    await perform(button, "Permanently deleting race dataset…", async () => {
      await api("/api/v1/staff/events/" + encodeURIComponent(currentEventId()) + "/purge", commandOptions("POST", { confirmation }));
      location.assign("/staff");
    });
  });
}

const staffAccess = document.querySelector("[data-staff-access]");
const staffAccessForm = document.querySelector("[data-staff-access-form]");
const staffAccessMessage = document.querySelector("[data-staff-access-message]");
const staffAccessList = document.querySelector("[data-staff-access-list]");

const staffLifecycle = async (profile, action, role, button) => {
  const description = action === "role" ? "change this account role" : action + " this staff account";
  if (!confirm("Really " + description + "?")) return;
  await perform(button, "Updating staff access…", async () => {
    const payload = { commandId: crypto.randomUUID() };
    if (action === "role") payload.role = role;
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
    const controls = text("div", "", "actions");
    const role = document.createElement("select");
    role.setAttribute("aria-label", "Role for " + (profile.displayName || profile.email));
    role.append(new Option("Regular staff", "STAFF"), new Option("Administrator", "ADMIN"));
    role.value = profile.role;
    const saveRole = text("button", "Save role", "button secondary small"); saveRole.type = "button";
    saveRole.addEventListener("click", () => staffLifecycle(profile, "role", role.value, saveRole));
    const activeAction = profile.active === false ? "reactivate" : "deactivate";
    const activeButton = text("button", profile.active === false ? "Reactivate" : "Deactivate", profile.active === false ? "button small" : "button danger small");
    activeButton.type = "button";
    activeButton.addEventListener("click", () => staffLifecycle(profile, activeAction, null, activeButton));
    controls.append(role, saveRole, activeButton);
    card.append(identity, text("span", profile.role === "ADMIN" ? "Administrator" : "Regular staff", "role-tag"), controls);
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
    const result = await api("/api/v1/staff/profiles", commandOptions("POST", {
      commandId: crypto.randomUUID(), email: String(values.get("email")), displayName: String(values.get("displayName")), role: String(values.get("role")),
    }));
    form.reset();
    await loadStaffProfiles();
    setMessage(result.staff.displayName + " can now sign in.", false, staffAccessMessage);
  });
});

loadEvents().catch((error) => {
  if (error.message !== "signed-out") setMessage(error.message, true);
});
`;

export const staffDuckScript = String.raw`
const root = document.querySelector("[data-staff-duck]");
const token = root.dataset.token;
const pageTitle = document.querySelector("[data-staff-title]");
const summary = document.querySelector("[data-duck-summary]");
const workArea = document.querySelector("[data-pairing-work]");
const dispositionArea = document.querySelector("[data-disposition-work]");
const dispositionForm = document.querySelector("[data-disposition-form]");
const dispositionMessage = document.querySelector("[data-disposition-message]");
const message = document.querySelector("[data-staff-message]");
let currentEvent = null;
let selectedRegistration = null;

const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
};

const addFact = (label, value) => {
  const fact = text("div", "", "fact");
  fact.append(text("dt", label), text("dd", value));
  summary.append(fact);
};

const showDisposition = (data) => {
  if (!data.event || !["COMPLETED", "RETURN_PROCESSING"].includes(data.event.status)) return false;
  dispositionArea.hidden = false;
  dispositionArea.dataset.eventId = data.event.id;
  document.querySelector("[data-disposition-event]").textContent = data.event.name;
  const select = dispositionForm.elements.disposition;
  const button = document.querySelector("[data-confirm-disposition]");
  button.disabled = false;
  if (data.disposition) {
    select.value = data.disposition;
    button.textContent = "Save disposition correction";
    dispositionMessage.textContent = "Current disposition: " + data.disposition.replaceAll("_", " ").toLowerCase() + ".";
  } else {
    button.textContent = "Record physical disposition";
    dispositionMessage.textContent = "Confirm the physical duck before recording this final outcome.";
  }
  message.textContent = "Review this duck, then record its confirmed physical disposition.";
  return true;
};

const showInspection = (data) => {
  const participant = data.assignment.participant;
  pageTitle.textContent = "Inspect Duck #" + data.duck.visibleNumber;
  message.textContent = "This duck is already paired. Review the assignment below.";
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  addFact("Participant", participant.firstName + " " + participant.lastName);
  addFact("Lookup code", participant.lookupCode);
  addFact("Registration", participant.registrationStatus.replaceAll("_", " ").toLowerCase());
  if (!data.assignment.active) addFact("Assignment", "closed");
  if (data.disposition) addFact("Disposition", data.disposition.replaceAll("_", " ").toLowerCase());
  if (participant.email) addFact("Email", participant.email);
  if (participant.phone) addFact("Phone", participant.phone);
  showDisposition(data);
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

const showPairing = (data) => {
  pageTitle.textContent = "Pair Duck #" + data.duck.visibleNumber;
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  if (showDisposition(data)) return;
  if (!data.pairingRequired) {
    message.textContent = "This duck cannot be paired in its current inventory or tag state.";
    return;
  }
  if (!currentEvent || !["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(currentEvent.status)) {
    message.textContent = "There is no event currently accepting duck pairing.";
    return;
  }
  message.textContent = "Find the participant, review both records, then confirm once.";
  workArea.hidden = false;
  document.querySelector("[data-pairing-event]").textContent = currentEvent.name;
};

const load = async () => {
  try {
    const [eventResponse, duck] = await Promise.all([
      fetchJson("/api/v1/events/current"),
      fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token)),
    ]);
    currentEvent = eventResponse.event;
    summary.replaceChildren();
    workArea.hidden = true;
    dispositionArea.hidden = true;
    dispositionMessage.textContent = "";
    if (duck.assignment) showInspection(duck);
    else showPairing(duck);
  } catch (error) {
    if (error.message !== "signed-out") message.textContent = error.message;
  }
};

document.querySelector("[data-registration-search]").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentEvent) return;
  const query = new FormData(event.currentTarget).get("query");
  const results = document.querySelector("[data-registration-results]");
  results.replaceChildren();
  selectedRegistration = null;
  document.querySelector("[data-confirm-pairing]").disabled = true;
  try {
    const parameters = new URLSearchParams({ eventId: currentEvent.id, q: String(query) });
    const body = await fetchJson("/api/v1/staff/registrations/search?" + parameters);
    if (body.registrations.length === 0) {
      results.append(text("p", "No matching registration was found.", "muted"));
      return;
    }
    for (const registration of body.registrations) {
      const assignment = registration.assignedDuckNumber === null
        ? "unpaired"
        : "already paired with Duck #" + registration.assignedDuckNumber;
      const button = text("button", registration.firstName + " " + registration.lastName + " · " + registration.lookupCode + " · " + assignment, "result-button");
      button.type = "button";
      button.disabled = registration.assignedDuckNumber !== null;
      button.addEventListener("click", () => renderSelection(registration));
      results.append(button);
    }
  } catch (error) {
    if (error.message !== "signed-out") results.append(text("p", error.message, "error-text"));
  }
});

document.querySelector("[data-confirm-pairing]").addEventListener("click", async (event) => {
  if (!selectedRegistration || !currentEvent) return;
  event.currentTarget.disabled = true;
  message.textContent = "Pairing duck and participant…";
  try {
    const result = await fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token) + "/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: currentEvent.id,
        lookupCode: selectedRegistration.lookupCode,
      }),
    });
    workArea.hidden = true;
    summary.replaceChildren();
    addFact("Duck", "#" + result.duck.visibleNumber);
    addFact("Participant", result.participant.firstName + " " + result.participant.lastName);
    addFact("Heat", result.heat ? "Round one · Heat " + result.heat.number : "Assignment pending");
    pageTitle.textContent = "Duck #" + result.duck.visibleNumber + " paired";
    message.textContent = result.replayed ? "This pairing was already saved." : "Duck paired successfully.";
  } catch (error) {
    if (error.message !== "signed-out") {
      message.textContent = error.message;
      event.currentTarget.disabled = false;
    }
  }
});

dispositionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("[data-confirm-disposition]");
  const disposition = new FormData(event.currentTarget).get("disposition");
  button.disabled = true;
  dispositionMessage.textContent = "Saving physical disposition…";
  try {
    const result = await fetchJson("/api/v1/staff/ducks/" + encodeURIComponent(token) + "/dispositions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        eventId: dispositionArea.dataset.eventId,
        disposition: String(disposition),
      }),
    });
    await load();
    dispositionMessage.textContent = result.replayed
      ? "This disposition was already saved."
      : "Disposition saved. Inventory is now " + result.inventoryStatus.replaceAll("_", " ").toLowerCase() + ".";
  } catch (error) {
    if (error.message !== "signed-out") dispositionMessage.textContent = error.message;
    button.disabled = false;
  }
});

load();
`;
