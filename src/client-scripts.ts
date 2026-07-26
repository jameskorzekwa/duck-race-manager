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

export const staffDuckScript = String.raw`
const root = document.querySelector("[data-staff-duck]");
const token = root.dataset.token;
const pageTitle = document.querySelector("[data-staff-title]");
const summary = document.querySelector("[data-duck-summary]");
const workArea = document.querySelector("[data-pairing-work]");
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

const showInspection = (data) => {
  const participant = data.assignment.participant;
  pageTitle.textContent = "Inspect Duck #" + data.duck.visibleNumber;
  message.textContent = "This duck is already paired. Review the assignment below.";
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  addFact("Participant", participant.firstName + " " + participant.lastName);
  addFact("Lookup code", participant.lookupCode);
  addFact("Registration", participant.registrationStatus.replaceAll("_", " ").toLowerCase());
  if (participant.email) addFact("Email", participant.email);
  if (participant.phone) addFact("Phone", participant.phone);
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

load();
`;
