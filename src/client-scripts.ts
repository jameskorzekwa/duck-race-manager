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
const returnReview = document.querySelector("[data-return-review]");
const returnTitle = document.querySelector("[data-return-title]");
const returnMessage = document.querySelector("[data-return-message]");
const returnSummary = document.querySelector("[data-return-summary]");
const numberedDispositionForm = document.querySelector("[data-numbered-disposition-form]");
const purgeReadyForm = document.querySelector("[data-purge-ready-form]");
const cancelPurgeReadyForm = document.querySelector("[data-cancel-purge-ready-form]");
const staffAccess = document.querySelector("[data-staff-access]");
const staffAccessForm = document.querySelector("[data-staff-access-form]");
const staffAccessMessage = document.querySelector("[data-staff-access-message]");
const staffAccessList = document.querySelector("[data-staff-access-list]");
const isSystemAdmin = returnReview.dataset.systemAdmin === "true";
let reviewEvent = null;

const reviewFact = (label, value) => {
  const fact = document.createElement("div");
  fact.className = "fact";
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value;
  fact.append(term, description);
  returnSummary.append(fact);
};

const staffText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};

const reviewFetch = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.assign("/staff");
    throw new Error("signed-out");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
};

const loadReturnReview = async () => {
  const body = await reviewFetch("/api/v1/staff/events/return-review");
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
  reviewFact("Event status", reviewEvent.status.replaceAll("_", " ").toLowerCase());
  reviewFact("Physical ducks", String(body.review.totalDucks));
  reviewFact("Unresolved", String(body.review.unresolvedDucks));
  if (body.review.unresolvedDuckNumbers.length > 0) {
    reviewFact("Unresolved duck numbers", body.review.unresolvedDuckNumbers.join(", "));
  }
  const dispositionSummary = Object.entries(body.review.dispositions)
    .map(([name, count]) => name.replaceAll("_", " ").toLowerCase() + ": " + count)
    .join(" · ");
  reviewFact("Dispositions", dispositionSummary || "None recorded");

  const blocked = body.review.unresolvedDucks > 0
    || body.review.unreleasedDucks > 0
    || body.review.hasBlockingHeat
    || body.review.hasActiveAssignment;
  if (reviewEvent.status === "ARCHIVED") {
    returnMessage.textContent = "This event is read-only and purge-ready.";
    if (isSystemAdmin) cancelPurgeReadyForm.hidden = false;
  } else {
    numberedDispositionForm.hidden = false;
    numberedDispositionForm.querySelector("button").disabled = false;
    returnMessage.textContent = blocked
      ? "Finish every disposition, reservation, assignment, and racing result before purge readiness."
      : "All automated gates pass. An administrator can complete the final review.";
    if (isSystemAdmin) {
      purgeReadyForm.hidden = false;
      purgeReadyForm.querySelector("button").disabled = blocked;
    }
  }
};

const loadStaffProfiles = async () => {
  if (!staffAccess) return;
  const body = await reviewFetch("/api/v1/staff/profiles");
  staffAccessList.replaceChildren();
  for (const profile of body.staff) {
    const card = staffText("article", "", "staff-access-card");
    const identity = staffText("div", "");
    identity.append(
      staffText("p", profile.displayName || profile.email),
      staffText("p", profile.email, "muted"),
    );
    card.append(
      identity,
      staffText("span", profile.role === "ADMIN" ? "Administrator" : "Regular staff", "role-tag"),
    );
    staffAccessList.append(card);
  }
  staffAccessMessage.textContent = body.staff.length === 1
    ? "1 authorized staff account."
    : body.staff.length + " authorized staff accounts.";
};

if (staffAccessForm) staffAccessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  button.disabled = true;
  staffAccessMessage.textContent = "Creating Cognito account and staff access…";
  try {
    const result = await reviewFetch("/api/v1/staff/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        email: String(values.get("email")),
        displayName: String(values.get("displayName")),
        role: String(values.get("role")),
      }),
    });
    form.reset();
    await loadStaffProfiles();
    staffAccessMessage.textContent = result.staff.displayName + " can now sign in as "
      + (result.staff.role === "ADMIN" ? "an administrator." : "regular staff.");
  } catch (error) {
    if (error.message !== "signed-out") staffAccessMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

numberedDispositionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const values = new FormData(form);
  const visibleNumber = String(values.get("visibleNumber"));
  button.disabled = true;
  returnMessage.textContent = "Saving physical disposition…";
  try {
    const result = await reviewFetch(
      "/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id)
        + "/ducks/" + encodeURIComponent(visibleNumber) + "/dispositions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          disposition: String(values.get("disposition")),
        }),
      },
    );
    form.reset();
    await loadReturnReview();
    returnMessage.textContent = "Duck #" + result.duck.visibleNumber + " disposition saved.";
  } catch (error) {
    if (error.message !== "signed-out") returnMessage.textContent = error.message;
    button.disabled = false;
  }
});

purgeReadyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  returnMessage.textContent = "Validating final return gates…";
  try {
    await reviewFetch("/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id) + "/purge-ready", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        returnReviewCompleted: true,
        permanentDeletionAcknowledged: true,
      }),
    });
    await loadReturnReview();
    returnMessage.textContent = "Event marked purge-ready. Normal race changes are now disabled.";
  } catch (error) {
    if (error.message !== "signed-out") returnMessage.textContent = error.message;
    button.disabled = false;
  }
});

cancelPurgeReadyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const reason = new FormData(form).get("reason");
  button.disabled = true;
  returnMessage.textContent = "Reopening return processing…";
  try {
    await reviewFetch("/api/v1/staff/events/" + encodeURIComponent(reviewEvent.id) + "/purge-ready/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), reason: String(reason) }),
    });
    form.reset();
    await loadReturnReview();
    returnMessage.textContent = "Return processing reopened for correction.";
  } catch (error) {
    if (error.message !== "signed-out") returnMessage.textContent = error.message;
    button.disabled = false;
  }
});

loadReturnReview().catch((error) => {
  if (error.message !== "signed-out") {
    returnReview.hidden = false;
    returnMessage.textContent = "Return review is temporarily unavailable.";
  }
});
loadStaffProfiles().catch((error) => {
  if (staffAccess && error.message !== "signed-out") {
    staffAccessMessage.textContent = "Staff access is temporarily unavailable.";
  }
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
