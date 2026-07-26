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

export const registrationScript = registrationHandoffHelpersScript + String.raw`
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
    emailNotificationsEnabled: false,
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
    const handoff = registrationCreateHandoff(body);
    if (handoff === null) {
      setMessage("Registration was saved, but its private status details were invalid. Ask race staff for help before leaving this page.", true);
      return;
    }
    try { registrationStoreHandoff(globalThis.sessionStorage, handoff); } catch {}
    location.assign("/my-ducks?registered=" + encodeURIComponent(handoff.registrationId));
  } catch {
    setMessage("The network interrupted registration. Try again; the same request will be retried safely.", true);
    submitButton.disabled = false;
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

export const participantScript = participantHandoffHelpersScript + String.raw`
const participantNav = document.querySelector("[data-my-ducks-nav]");
const participantRoot = document.querySelector("[data-my-ducks-page]");
const participantFreshness = document.querySelector("[data-my-ducks-freshness]");
const participantSuccess = document.querySelector("[data-registration-success]");
const participantSections = Array.from(document.querySelectorAll("[data-participant-section]"));
let participantRegisteredId = participantRoot
  ? new URLSearchParams(location.search).get("registered")
  : null;
let participantCurrentId = null;
let participantPrivateStatusPath = null;
let participantHasLoaded = false;
let participantVersion = null;
let participantRefreshRunning = null;
let participantRefreshQueued = false;
let participantPollTimer = null;
let participantReconnectTimer = null;
let participantReconnectAttempt = 0;
let participantSocket = null;
let participantConnected = false;

const participantText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};

const participantHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase()
  .replace(/^./, (character) => character.toUpperCase());
const participantRoundLabel = (round) => round === "FINAL" ? "Final" : "Round one";
const participantHeatStatus = (status) => ({
  PLANNED: "Coming up",
  LOADING: "Ducks are being prepared",
  READY: "Ready to call",
  CALLING: "Calling racers now",
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

const participantAddRaceFacts = (card, status) => {
  if (!status) {
    card.append(participantText("p", "Race status is not currently public.", "muted"));
    return;
  }
  const facts = participantText("dl", "", "facts");
  participantAddFact(facts, "Duck", status.duck
    ? "Duck #" + status.duck.visibleNumber
    : "Waiting for duck assignment");
  const assigned = status.assignedHeat.final || status.assignedHeat.roundOne;
  participantAddFact(facts, "Assigned heat", assigned
    ? (status.assignedHeat.final ? "Final" : "Round one") + " · Heat " + assigned.number
    : "Heat not assigned yet");
  participantAddFact(facts, "Race activity", status.currentHeat
    ? participantRoundLabel(status.currentHeat.round) + " · Heat " + status.currentHeat.number
      + " · " + participantHeatStatus(status.currentHeat.status)
    : "No heat is active right now");
  participantAddFact(facts, "Race status", participantHumanize(status.outcome));
  card.append(facts);
};

const participantCard = (registration) => {
  const current = registration.registrationId === participantCurrentId;
  const card = participantText("article", "", "duck-card participant-card" + (current ? " is-current" : ""));
  card.dataset.registrationId = registration.registrationId;
  if (current) {
    card.tabIndex = -1;
    card.setAttribute("aria-current", "true");
    card.append(participantText("span", "Just registered", "success-tag"));
  }
  card.append(
    participantText("h3", registration.firstName + " " + registration.lastName),
    participantText("p", "Staff lookup code: " + registration.lookupCode),
    participantText("p", "Registration: " + participantHumanize(registration.registrationStatus), "muted"),
  );
  participantAddRaceFacts(card, registration.raceStatus);
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

const participantRenderSection = (kind, registrations) => {
  const section = participantSections.find((item) => item.dataset.participantSection === kind);
  const track = section.querySelector("[data-participant-track]");
  const empty = section.querySelector("[data-carousel-empty]");
  const controls = section.querySelector("[data-carousel-controls]");
  track.replaceChildren(...registrations.map(participantCard));
  const hasRegistrations = registrations.length > 0;
  track.hidden = !hasRegistrations;
  controls.hidden = !hasRegistrations;
  empty.hidden = hasRegistrations;
  empty.textContent = kind === "awaiting"
    ? "No participants are waiting for a duck."
    : "No paired ducks are saved on this device yet.";
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
    participantCurrentId = justRegistered.registrationId;
    if (participantPrivateStatusPath === null) {
      let handoff = null;
      try {
        handoff = participantConsumeHandoff(globalThis.sessionStorage, justRegistered.registrationId, location.origin);
      } catch {}
      if (handoff !== null) participantPrivateStatusPath = handoff.privateStatusPath;
    }
  }
  if (participantCurrentId && !registrations.some((registration) => registration.registrationId === participantCurrentId)) {
    participantCurrentId = null;
    participantSuccess.hidden = true;
  }
  if (version !== participantVersion || justRegistered) {
    participantVersion = version;
    participantRenderSection("awaiting", registrations.filter((registration) => !registration.paired));
    participantRenderSection("paired", registrations.filter((registration) => registration.paired));
  }
  participantFreshness.textContent = registrations.length === 0
    ? "No registrations are saved on this device yet."
    : "Updated just now.";
  if (!justRegistered) return;

  participantSuccess.replaceChildren(
    participantText("strong", "Registration saved. "),
    participantText("span", justRegistered.firstName + " " + justRegistered.lastName + " is highlighted below."),
  );
  if (participantPrivateStatusPath !== null) {
    const privateLink = participantText("a", "Open private status", "card-link");
    privateLink.href = participantPrivateStatusPath;
    participantSuccess.append(participantText("span", " "), privateLink);
  }
  participantSuccess.hidden = false;
  participantRegisteredId = null;
  const card = Array.from(document.querySelectorAll("[data-registration-id]"))
    .find((item) => item.dataset.registrationId === justRegistered.registrationId);
  if (card) requestAnimationFrame(() => {
    card.focus({ preventScroll: true });
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    participantCleanRegisteredQuery();
  });
  else participantCleanRegisteredQuery();
};

const participantFetch = async () => {
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
    if (participantNav) participantNav.hidden = !body.hasRegistrations;
    return;
  }
  if (!body || !Array.isArray(body.registrations)) throw new Error("invalid collection response");
  participantHasLoaded = true;
  if (participantNav) participantNav.hidden = body.registrations.length === 0;
  if (!document.hidden) participantRender(body.registrations);
};

const participantRefreshWork = async () => {
  try {
    await participantFetch();
  } catch {
    if (participantFreshness) participantFreshness.textContent = "Saved registrations are temporarily unavailable. This page will keep checking.";
  }
};

const participantRefresh = () => {
  if (document.hidden) return Promise.resolve(false);
  if (participantRefreshRunning) {
    participantRefreshQueued = true;
    return participantRefreshRunning;
  }
  participantRefreshRunning = (async () => {
    try {
      do {
        participantRefreshQueued = false;
        await participantRefreshWork();
      } while (participantRefreshQueued && !document.hidden);
      return true;
    } finally {
      participantRefreshRunning = null;
    }
  })();
  return participantRefreshRunning;
};

const participantPausePolling = () => {
  if (participantPollTimer !== null) clearTimeout(participantPollTimer);
  participantPollTimer = null;
};

const participantSchedulePolling = (connected = participantConnected) => {
  participantConnected = connected;
  participantPausePolling();
  if (document.hidden) return;
  participantPollTimer = setTimeout(async () => {
    participantPollTimer = null;
    try {
      if (!document.hidden) await participantRefresh();
    } finally {
      participantSchedulePolling();
    }
  }, participantConnected ? 30000 : 5000);
};

const participantReconnectDelay = () => {
  const base = Math.min(1000 * (2 ** participantReconnectAttempt), 15000);
  participantReconnectAttempt = Math.min(participantReconnectAttempt + 1, 4);
  return Math.round(Math.min(15000, base * (0.8 + (0.4 * Math.random()))));
};

const participantConnect = () => {
  if (!("WebSocket" in globalThis) || document.hidden) {
    participantConnected = false;
    participantSchedulePolling(false);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/api/v1/live");
  participantSocket = socket;
  socket.addEventListener("open", () => {
    participantReconnectAttempt = 0;
    participantConnected = true;
    participantSchedulePolling(true);
    if (participantHasLoaded) participantFreshness.textContent = "Updates are arriving live.";
  });
  socket.addEventListener("message", () => { participantRefresh(); });
  socket.addEventListener("close", () => {
    if (participantSocket === socket) participantSocket = null;
    participantConnected = false;
    participantSchedulePolling(false);
    participantFreshness.textContent = participantHasLoaded
      ? "Reconnecting; this page is still checking for updates."
      : "Saved registrations are temporarily unavailable. This page will keep checking.";
    clearTimeout(participantReconnectTimer);
    if (!document.hidden) participantReconnectTimer = setTimeout(participantConnect, participantReconnectDelay());
  });
  socket.addEventListener("error", () => { socket.close(); });
};

if (participantRoot) {
  if (participantRegisteredId && !participantRegistrationIdPattern.test(participantRegisteredId)) {
    participantRegisteredId = null;
    participantCleanRegisteredQuery();
  }
  participantRefresh();
  participantSchedulePolling(false);
  participantConnect();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      participantPausePolling();
      clearTimeout(participantReconnectTimer);
      return;
    }
    participantRefresh();
    participantSchedulePolling(participantConnected);
    if (participantSocket === null) participantConnect();
  });
} else {
  participantFetch().catch(() => {});
}
`;

export const liveRuntimeHelpersScript = String.raw`
const livePollDelay = (connected) => connected ? 30000 : 5000;
const liveReconnectDelay = (attempt, randomValue = Math.random()) => {
  const base = Math.min(1000 * (2 ** attempt), 15000);
  return Math.round(Math.min(15000, base * (0.8 + (0.4 * randomValue))));
};
const liveSuccessfulFreshness = (secondaryResults) => secondaryResults.some((result) => result.status === "rejected")
  ? "The public race board is current, but personal details are delayed. This page will keep checking."
  : "Updated just now.";
const liveCreateRefreshQueue = (work, isHidden) => {
  let running = null;
  let queued = false;
  return () => {
    if (isHidden()) return Promise.resolve(false);
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          queued = false;
          await work();
        } while (queued && !isHidden());
        return true;
      } finally {
        running = null;
      }
    })();
    return running;
  };
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

export const liveScript = liveRuntimeHelpersScript + String.raw`
const liveBoardRoot = document.querySelector("[data-live-board]");
const liveBoardTitle = document.querySelector("[data-live-board-title]");
const liveBoardSummary = document.querySelector("[data-live-board-summary]");
const liveBoardContent = document.querySelector("[data-live-board-content]");
const liveFreshness = document.querySelector("[data-live-freshness]");
let liveReconnectAttempt = 0;
let liveReconnectTimer = null;
let liveSocket = null;
let liveConnected = false;
let liveBoardVersion = null;

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
const liveHeatStatus = (status) => ({
  PLANNED: "Coming up",
  LOADING: "Ducks are being prepared",
  READY: "Ready to call",
  CALLING: "Calling racers now",
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

const liveRaceFacts = (container, status, includeParticipant) => {
  if (!status) {
    container.append(liveText("p", "Race status is not currently public.", "muted"));
    return;
  }
  const facts = liveText("dl", "", "facts");
  if (includeParticipant) liveAddFact(facts, "Participant", status.participantDisplayName);
  liveAddFact(facts, "Duck", status.duck ? "Duck #" + status.duck.visibleNumber : "Waiting for duck assignment");
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
      row.append(
        liveText("span", entry.participantDisplayName),
        liveText("span", (entry.duckNumber === null ? "Duck number pending" : "Duck #" + entry.duckNumber)
          + (entry.place === null ? "" : " · " + livePlaceLabel(entry.place) + " place")),
      );
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
    liveBoardTitle.textContent = "No race is live right now.";
    liveBoardSummary.textContent = "The board will be ready when registration opens for the next event.";
    liveBoardContent.append(liveText("p", "There are no race heats to show yet.", "empty-state"));
    return;
  }
  const event = board.event;
  liveBoardTitle.textContent = event.name;
  liveBoardSummary.textContent = event.currentHeat
    ? liveRoundLabel(event.currentHeat.round) + " Heat " + event.currentHeat.number + " · " + liveHeatStatus(event.currentHeat.status)
    : event.roundOneHeats.length + event.finalHeats.length === 0
      ? "Heats have not been posted yet."
      : "No heat is active right now. The latest official results are below.";
  if (event.podium.length > 0) {
    const podium = liveText("section", "", "board-round");
    podium.append(liveText("h3", "Official podium"));
    const places = liveText("div", "", "podium");
    for (const entry of event.podium) {
      places.append(liveText("p", livePlaceLabel(entry.place) + " · " + entry.participantDisplayName
        + (entry.duckNumber === null ? "" : " · Duck #" + entry.duckNumber), "podium-place"));
    }
    podium.append(places);
    liveBoardContent.append(podium);
  }
  if (event.roundOneHeats.length > 0) liveBoardContent.append(liveRound("Round one", event.roundOneHeats, event.currentHeat));
  if (event.finalHeats.length > 0) liveBoardContent.append(liveRound("Final", event.finalHeats, event.currentHeat));
  if (event.roundOneHeats.length === 0 && event.finalHeats.length === 0) {
    liveBoardContent.append(liveText("p", "Participants can still use this page before heats are made.", "empty-state"));
  }
};

const liveFetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error("refresh failed");
  return response.json();
};

const liveRefreshPersonal = async () => {
  const personal = document.querySelector("[data-live-personal]");
  if (!personal) return;
  const pathParts = location.pathname.split("/");
  const token = pathParts.length === 3 ? pathParts[2] : "";
  if (!token) return;
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
    return;
  }
  const body = await liveFetchJson("/api/v1/ducks/" + encodeURIComponent(token));
  if (document.hidden) return;
  personal.replaceChildren();
  if (body.destination === "RACE_STATUS") liveRaceFacts(personal, body.raceStatus, true);
  else personal.append(liveText("p", "This duck does not have public race status right now.", "muted"));
};

const liveRefreshWork = async () => {
  try {
    const board = await liveFetchJson("/api/v1/race-board");
    const secondary = await Promise.allSettled([
      liveRefreshPersonal(),
    ]);
    if (document.hidden) return;
    liveRenderBoard(board);
    liveFreshness.textContent = liveSuccessfulFreshness(secondary);
  } catch {
    liveFreshness.textContent = "Updates are delayed. This page will keep checking.";
  }
};
const liveRefresh = liveCreateRefreshQueue(liveRefreshWork, () => document.hidden);
const livePoller = liveCreatePollScheduler(liveRefresh, () => document.hidden);

const liveConnect = () => {
  if (!("WebSocket" in globalThis) || document.hidden) {
    liveConnected = false;
    livePoller.schedule(false);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/api/v1/live");
  liveSocket = socket;
  socket.addEventListener("open", () => {
    liveReconnectAttempt = 0;
    liveConnected = true;
    livePoller.schedule(true);
    liveFreshness.textContent = "Updates are arriving live.";
  });
  socket.addEventListener("message", () => { liveRefresh(); });
  socket.addEventListener("close", () => {
    if (liveSocket === socket) liveSocket = null;
    liveConnected = false;
    livePoller.schedule(false);
    liveFreshness.textContent = "Reconnecting; this page is still checking for updates.";
    const delay = liveReconnectDelay(liveReconnectAttempt);
    liveReconnectAttempt = Math.min(liveReconnectAttempt + 1, 4);
    clearTimeout(liveReconnectTimer);
    if (!document.hidden) liveReconnectTimer = setTimeout(liveConnect, delay);
  });
  socket.addEventListener("error", () => { socket.close(); });
};

if (liveBoardRoot) {
  liveRefresh();
  livePoller.schedule(false);
  liveConnect();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      livePoller.pause();
      clearTimeout(liveReconnectTimer);
      return;
    }
    liveRefresh();
    livePoller.schedule(liveConnected);
    if (liveSocket === null) liveConnect();
  });
}
`;

export const startLineScript = liveRuntimeHelpersScript + stationStateHelpersScript + String.raw`
const startRoot = document.querySelector("[data-start-line]");
const startFreshness = document.querySelector("[data-station-freshness]");
const startEvent = document.querySelector("[data-station-event]");
const startHeatTitle = document.querySelector("[data-station-heat]");
const startFacts = document.querySelector("[data-station-facts]");
const startRoster = document.querySelector("[data-station-roster]");
const startAction = document.querySelector("[data-station-action]");
const startMessage = document.querySelector("[data-station-message]");
let startReconnectAttempt = 0;
let startReconnectTimer = null;
let startSocket = null;
let startConnected = false;
let startRenderKey = null;

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
const startCommand = (path, revision) => startApi(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ commandId: crypto.randomUUID(), revision }),
});
const startRender = (event, detail) => {
  const renderKey = stationHeatRenderKey(event, detail);
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
    startRoster.append(startText("li", "Slot " + entry.slotNumber + " · " + entry.participant.firstName + " " + entry.participant.lastName
      + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · Duck not assigned")));
  }
  if (detail.roster.length === 0) startRoster.append(startText("li", "This heat has no roster entries."));
  startAction.replaceChildren();
  const transition = {
    PLANNED: ["lock", "Lock roster"],
    LOADING: ["ready", "Mark heat ready"],
    READY: ["call", "Call this heat"],
    CALLING: ["start", "Start this heat"],
  }[detail.heat.status];
  if (!transition) {
    startMessage.textContent = detail.heat.status === "AWAITING_RESULT"
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
      if (!confirm(readback)) return;
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
      startFreshness.textContent = "Updated just now.";
      return;
    }
    const listed = await startApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats");
    if (document.hidden) return;
    const heat = startPickHeat(listed.heats, event.status === "FINAL" ? "FINAL" : "ROUND_ONE");
    if (!heat) {
      startEmpty(event.name + " has no unfinished heat in this round.");
      startFreshness.textContent = "Updated just now.";
      return;
    }
    const detail = await startApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats/" + encodeURIComponent(heat.id));
    if (document.hidden) return;
    startRender(event, detail);
    startFreshness.textContent = "Updated just now.";
  } catch (error) {
    if (error.message !== "signed-out") {
      startFreshness.textContent = "Updates are delayed. This page will keep checking.";
      startMessage.textContent = error.message;
    }
  }
};
const startLoad = liveCreateRefreshQueue(startLoadWork, () => document.hidden);
const startPoller = liveCreatePollScheduler(startLoad, () => document.hidden);
const startConnect = () => {
  if (!("WebSocket" in globalThis) || document.hidden) {
    startConnected = false;
    startPoller.schedule(false);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/api/v1/live");
  startSocket = socket;
  socket.addEventListener("open", () => {
    startReconnectAttempt = 0;
    startConnected = true;
    startPoller.schedule(true);
    startFreshness.textContent = "Updates are arriving live.";
  });
  socket.addEventListener("message", () => { startLoad(); });
  socket.addEventListener("close", () => {
    if (startSocket === socket) startSocket = null;
    startConnected = false;
    startPoller.schedule(false);
    startFreshness.textContent = "Reconnecting; this station is still checking for updates.";
    const delay = liveReconnectDelay(startReconnectAttempt);
    startReconnectAttempt = Math.min(startReconnectAttempt + 1, 4);
    clearTimeout(startReconnectTimer);
    if (!document.hidden) startReconnectTimer = setTimeout(startConnect, delay);
  });
  socket.addEventListener("error", () => { socket.close(); });
};
if (startRoot) {
  startLoad();
  startPoller.schedule(false);
  startConnect();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      startPoller.pause();
      clearTimeout(startReconnectTimer);
      return;
    }
    startLoad();
    startPoller.schedule(startConnected);
    if (startSocket === null) startConnect();
  });
}
`;

export const finishSelectionValidationScript = String.raw`
const finishSelectionProblem = (selected, roster, raceEntryId) => {
  if (selected.some((item) => item.raceEntryId === raceEntryId)) return "duplicate";
  if (!roster.some((entry) => entry.raceEntryId === raceEntryId)) return "wrong-heat";
  return null;
};
`;

export const finishHandoffHelpersScript = String.raw`
const finishParseHandoff = (search) => {
  const parameters = new URLSearchParams(search);
  const tag = parameters.get("tag");
  const eventId = parameters.get("eventId");
  const heatId = parameters.get("heatId");
  const revisionText = parameters.get("revision");
  const expiresText = parameters.get("expiresAt");
  const revision = revisionText === null ? NaN : Number(revisionText);
  const expiresAt = expiresText === null ? NaN : Number(expiresText);
  if (
    !tag || !/^[A-Za-z0-9_-]{22,128}$/.test(tag)
    || !eventId || eventId.length > 128 || !heatId || heatId.length > 128
    || !Number.isSafeInteger(revision) || revision < 0
    || !Number.isFinite(expiresAt)
  ) return null;
  return { tag, eventId, heatId, revision, expiresAt };
};
const finishBuildHandoffSearch = (stored, tag) => {
  if (
    !stored || stored.returnPath !== "/staff/finish-line"
    || typeof stored.eventId !== "string" || stored.eventId.length === 0 || stored.eventId.length > 128
    || typeof stored.heatId !== "string" || stored.heatId.length === 0 || stored.heatId.length > 128
    || !Number.isSafeInteger(stored.revision) || stored.revision < 0
    || !Number.isFinite(stored.expiresAt)
    || !/^[A-Za-z0-9_-]{22,128}$/.test(tag)
  ) return null;
  return new URLSearchParams({
    tag,
    eventId: stored.eventId,
    heatId: stored.heatId,
    revision: String(stored.revision),
    expiresAt: String(stored.expiresAt),
  }).toString();
};
const finishHandoffProblem = (handoff, current, now = Date.now()) => {
  if (!handoff) return "invalid";
  if (handoff.expiresAt <= now) return "expired";
  if (!current || handoff.eventId !== current.eventId || handoff.heatId !== current.heatId) return "wrong-heat";
  if (handoff.revision !== current.revision) return "stale-revision";
  if (current.status !== "AWAITING_RESULT") return "not-awaiting";
  return null;
};
const finishHandoffMessage = (problem) => ({
  invalid: "That handoff was invalid. Return to this finish station and scan the duck again.",
  expired: "That handoff expired. Scan the duck again from the current finish station.",
  "wrong-heat": "That scan belongs to a different heat. Check the displayed heat and scan the duck again.",
  "stale-revision": "The heat changed after that scan. Review the current heat and scan the duck again.",
  "not-awaiting": "Mark the displayed heat finished, then scan the duck again.",
})[problem] || "The scan could not be used. Review the current heat and scan the duck again.";
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

export const finishLineScript = liveRuntimeHelpersScript + stationStateHelpersScript
  + finishSelectionValidationScript + finishHandoffHelpersScript + finishScanSerializationScript
  + finishNfcHelpersScript + String.raw`
const finishRoot = document.querySelector("[data-finish-line]");
const finishFreshness = document.querySelector("[data-station-freshness]");
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
const finishStorageKey = "quickducks.finishStation";
let finishEvent = null;
let finishHeat = null;
let finishRosterEntries = [];
let finishSelected = [];
let finishReconnectAttempt = 0;
let finishReconnectTimer = null;
let finishSocket = null;
let finishConnected = false;
let finishRenderKey = null;
let finishScanBusy = false;
const finishInitialSearch = location.search;
let finishPendingHandoff = finishParseHandoff(finishInitialSearch);
let finishPendingHandoffProblem = finishInitialSearch && finishPendingHandoff === null ? "invalid" : null;
if (finishInitialSearch) history.replaceState(null, "", location.pathname);

const finishText = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value == null ? "" : String(value);
  if (className) element.className = className;
  return element;
};
const finishHumanize = (value) => String(value || "").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase());
const finishPlaceLabel = (place) => place === 1 ? "1st place" : place === 2 ? "2nd place" : "3rd place";
const finishKeepContext = () => {
  if (!finishEvent || !finishHeat || !["RUNNING", "AWAITING_RESULT"].includes(finishHeat.status)) return;
  try {
    localStorage.setItem(finishStorageKey, JSON.stringify({
      returnPath: "/staff/finish-line",
      eventId: finishEvent.id,
      heatId: finishHeat.id,
      revision: finishHeat.revision,
      expiresAt: Date.now() + 60 * 1000,
    }));
  } catch {}
};
const finishClearContext = () => { try { localStorage.removeItem(finishStorageKey); } catch {} };
const finishApi = async (url, options) => {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname + location.search));
    throw new Error("signed-out");
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body && body.error ? body.error : "The race could not be refreshed.");
  return body;
};
const finishAddFact = (label, value) => {
  const fact = finishText("div", "", "fact");
  fact.append(finishText("dt", label), finishText("dd", value));
  finishFacts.append(fact);
};
const finishRequiredPlaces = () => !finishHeat ? 0 : finishHeat.round === "ROUND_ONE" ? 1 : Math.min(3, finishRosterEntries.length);
const finishSetScanBusy = (busy) => {
  finishScanBusy = busy;
  for (const control of finishScanForm.querySelectorAll("input, button")) control.disabled = busy;
  finishNfcButton.disabled = busy;
  for (const control of finishSelections.querySelectorAll("button")) control.disabled = busy;
  const required = finishRequiredPlaces();
  finishSubmit.disabled = busy || finishHeat === null || finishHeat.status !== "AWAITING_RESULT" || finishSelected.length !== required;
};
const finishRenderSelections = () => {
  const focusedRaceEntry = finishSelections.contains(document.activeElement)
    ? document.activeElement.dataset.raceEntryId
    : null;
  finishSelections.replaceChildren();
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
    });
    card.append(remove);
    finishSelections.append(card);
    if (focusedRaceEntry === selection.raceEntryId) remove.focus();
  }
  const required = finishRequiredPlaces();
  finishSubmit.disabled = finishScanBusy || finishHeat === null || finishHeat.status !== "AWAITING_RESULT" || finishSelected.length !== required;
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
    finishRenderSelections();
    finishScanForm.elements.duck.value = "";
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
  if (finishSelected.length >= finishRequiredPlaces()) {
    finishMessage.textContent = "Every required place is filled. Remove a selection to change it.";
    return;
  }
  try {
    return await finishRunSerializedSelection(value);
  } catch (error) {
    if (error.message !== "signed-out") finishMessage.textContent = error.message;
  }
};
const finishRender = (event, detail) => {
  const renderKey = stationHeatRenderKey(event, detail);
  if (renderKey === finishRenderKey) {
    finishKeepContext();
    return;
  }
  const changedHeatContext = !finishHeat
    || finishHeat.id !== detail.heat.id
    || finishHeat.revision !== detail.heat.revision
    || finishHeat.status !== detail.heat.status;
  const restoreActionFocus = finishAction.contains(document.activeElement);
  finishRenderKey = renderKey;
  finishEvent = event;
  finishHeat = detail.heat;
  finishRosterEntries = detail.roster;
  if (changedHeatContext) finishSelected = [];
  else finishSelected = finishSelected.filter((selection) => finishRosterEntries.some((entry) => entry.raceEntryId === selection.raceEntryId));
  finishEventLabel.textContent = event.name + " · " + finishHumanize(event.status);
  finishHeatTitle.textContent = (finishHeat.round === "FINAL" ? "Final" : "Round one") + " · Heat " + finishHeat.number;
  finishFacts.replaceChildren();
  finishAddFact("Heat status", finishHumanize(finishHeat.status));
  finishAddFact("Required result", finishHeat.round === "ROUND_ONE" ? "One winner" : finishRequiredPlaces() + " podium places");
  finishRoster.replaceChildren();
  for (const entry of finishRosterEntries) {
    finishRoster.append(finishText("li", "Slot " + entry.slotNumber + " · " + entry.participant.firstName + " " + entry.participant.lastName
      + (entry.duck ? " · Duck #" + entry.duck.visibleNumber : " · Duck not assigned")));
  }
  finishAction.replaceChildren();
  finishScanForm.hidden = finishHeat.status !== "AWAITING_RESULT";
  if (finishHeat.status === "RUNNING") {
    const button = finishText("button", "Mark heat finished", "button station-control");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      finishMessage.textContent = "Marking the heat finished…";
      try {
        await finishApi("/api/v1/staff/events/" + encodeURIComponent(finishEvent.id) + "/heats/" + encodeURIComponent(finishHeat.id) + "/finish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: crypto.randomUUID(), revision: finishHeat.revision }),
        });
        await finishLoad();
        finishMessage.textContent = "Heat finished. Select every required place, review it, then submit once.";
      } catch (error) {
        if (error.message !== "signed-out") finishMessage.textContent = error.message;
        button.disabled = false;
      }
    });
    finishAction.append(button);
    if (restoreActionFocus) button.focus();
    finishMessage.textContent = "When the race physically finishes, press the one finish button.";
  } else {
    finishMessage.textContent = "Select " + finishRequiredPlaces() + " distinct " + (finishRequiredPlaces() === 1 ? "duck" : "ducks") + ", then review every place before submitting.";
  }
  finishRenderSelections();
  finishKeepContext();
};
const finishEmpty = (message) => {
  const emptyKey = "empty:" + message;
  if (finishRenderKey === emptyKey) return;
  finishRenderKey = emptyKey;
  finishEvent = null;
  finishHeat = null;
  finishRosterEntries = [];
  finishSelected = [];
  finishEventLabel.textContent = message;
  finishHeatTitle.textContent = "No heat needs the finish line";
  finishFacts.replaceChildren();
  finishRoster.replaceChildren(finishText("li", "A running or just-finished heat will appear here."));
  finishAction.replaceChildren();
  finishScanForm.hidden = true;
  finishRenderSelections();
  finishMessage.textContent = "This station will keep checking for a running heat.";
};
const finishConsumeHandoff = async () => {
  if (finishPendingHandoffProblem) {
    const problem = finishPendingHandoffProblem;
    finishPendingHandoffProblem = null;
    finishMessage.textContent = finishHandoffMessage(problem);
    return;
  }
  if (!finishPendingHandoff) return;
  const handoff = finishPendingHandoff;
  finishPendingHandoff = null;
  const problem = finishHandoffProblem(handoff, finishEvent && finishHeat ? {
    eventId: finishEvent.id,
    heatId: finishHeat.id,
    revision: finishHeat.revision,
    status: finishHeat.status,
  } : null);
  if (problem) {
    finishMessage.textContent = finishHandoffMessage(problem);
    return;
  }
  await finishSelectValue(location.origin + "/t/" + handoff.tag);
};
const finishLoadWork = async () => {
  finishKeepContext();
  try {
    const events = await finishApi("/api/v1/staff/events");
    if (document.hidden) return;
    const event = events.events.find((item) => ["ROUND_ONE", "FINAL"].includes(item.status));
    if (!event) {
      finishEmpty("No race round is active right now.");
      finishFreshness.textContent = "Updated just now.";
      await finishConsumeHandoff();
      return;
    }
    const listed = await finishApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats");
    if (document.hidden) return;
    const round = event.status === "FINAL" ? "FINAL" : "ROUND_ONE";
    const heat = finishPickHeat(listed.heats, round);
    if (!heat) {
      finishEmpty(event.name + " has no running heat or result waiting.");
      finishFreshness.textContent = "Updated just now.";
      await finishConsumeHandoff();
      return;
    }
    const detail = await finishApi("/api/v1/staff/events/" + encodeURIComponent(event.id) + "/heats/" + encodeURIComponent(heat.id));
    if (document.hidden) return;
    finishRender(event, detail);
    finishFreshness.textContent = "Updated just now.";
    await finishConsumeHandoff();
  } catch (error) {
    if (error.message !== "signed-out") {
      finishFreshness.textContent = "Updates are delayed. This station will keep checking.";
      finishMessage.textContent = error.message;
    }
  }
};
const finishLoad = liveCreateRefreshQueue(finishLoadWork, () => document.hidden);
const finishPoller = liveCreatePollScheduler(finishLoad, () => document.hidden);
finishScanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await finishSelectValue(finishScanForm.elements.duck.value);
});
finishSubmit.addEventListener("click", async () => {
  if (!finishEvent || !finishHeat || finishScanBusy || finishSelected.length !== finishRequiredPlaces()) return;
  const readback = finishSelected.map((selection) => finishPlaceLabel(selection.place) + ": "
    + selection.participantDisplayName + ", Duck #" + selection.visibleNumber).join("; ");
  if (!confirm("Submit this official result now? Read back: " + readback + ". This publishes immediately.")) return;
  const captured = {
    eventId: finishEvent.id,
    heatId: finishHeat.id,
    revision: finishHeat.revision,
    results: finishSelected.map((selection) => ({ raceEntryId: selection.raceEntryId, place: selection.place })),
  };
  finishSubmit.disabled = true;
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
    finishClearContext();
    finishSelected = [];
    await finishLoad();
    finishMessage.textContent = "Official result saved. The station has moved to the next available heat.";
  } catch (error) {
    if (error.message !== "signed-out") finishMessage.textContent = error.message;
    finishSubmit.disabled = false;
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
const finishConnect = () => {
  if (!("WebSocket" in globalThis) || document.hidden) {
    finishConnected = false;
    finishPoller.schedule(false);
    return;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/api/v1/live");
  finishSocket = socket;
  socket.addEventListener("open", () => {
    finishReconnectAttempt = 0;
    finishConnected = true;
    finishPoller.schedule(true);
    finishFreshness.textContent = "Updates are arriving live.";
  });
  socket.addEventListener("message", () => { finishLoad(); });
  socket.addEventListener("close", () => {
    if (finishSocket === socket) finishSocket = null;
    finishConnected = false;
    finishPoller.schedule(false);
    finishFreshness.textContent = "Reconnecting; this station is still checking for updates.";
    const delay = liveReconnectDelay(finishReconnectAttempt);
    finishReconnectAttempt = Math.min(finishReconnectAttempt + 1, 4);
    clearTimeout(finishReconnectTimer);
    if (!document.hidden) finishReconnectTimer = setTimeout(finishConnect, delay);
  });
  socket.addEventListener("error", () => { socket.close(); });
};
if (finishRoot) {
  finishKeepContext();
  finishLoad();
  finishPoller.schedule(false);
  finishConnect();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      finishPoller.pause();
      clearTimeout(finishReconnectTimer);
      return;
    }
    finishLoad();
    finishPoller.schedule(finishConnected);
    if (finishSocket === null) finishConnect();
  });
}
`;

export const inventoryIntakeHelpersScript = String.raw`
const intakePreRaceStatuses = new Set(["DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"]);

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
  eventId, location, recover, start, classify, write, confirm, refresh,
  accepted, message, state, feedback, changed = () => {},
  commandId = () => crypto.randomUUID(),
  scheduleReady = (callback) => setTimeout(callback, 900),
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

  const alreadyRegistered = () => {
    pending = null;
    nextStartCommandId = commandId();
    accepted({ outcome: "already" });
    feedback("already");
    state("ready");
    message("This duck is already registered in inventory. Ready to scan the next duck.", true);
    changed();
    void refresh().catch(() => {});
    return { accepted: true, outcome: "already" };
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
          return alreadyRegistered();
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
        await confirm({
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

export const inventoryIntakeScript = inventoryIntakeHelpersScript + String.raw`
const intakeRoot = document.querySelector("[data-inventory-intake]");
const intakeEventSelect = document.querySelector("[data-intake-event]");
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
const intakeAppOrigin = intakeRoot.dataset.appOrigin;
let intakeAddedCount = 0;
let intakeSelectedEvent = null;
let intakeStarted = false;
let intakeStarting = false;
let intakeSupported = false;
let intakeEventsAvailable = false;
let intakeAudio = null;
let intakeTakeoverCandidate = null;
let intakeNfcStation = null;
let intakeMachine = null;

const intakeApi = async (url, options) => {
  const response = await fetch(url, { ...options, cache: "no-store" });
  if (response.status === 401) {
    location.assign("/staff?returnTo=" + encodeURIComponent(location.pathname));
    throw new Error("signed-out");
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body && body.error ? body.error : "The station request failed.");
    error.status = response.status;
    throw error;
  }
  return body;
};

const intakeSetMessage = (value, isError = false) => {
  intakeMessage.textContent = value;
  intakeMessage.classList.toggle("error-text", isError);
};

const intakeSetState = (value) => {
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

const intakeUpdateControls = () => {
  const active = intakeStarted && intakeNfcStation?.isActive() === true;
  const pending = intakeMachine?.hasPending() === true;
  const busy = intakeMachine?.isBusy() === true;
  const running = active || intakeStarting;
  intakeNfcButton.disabled = !intakeSupported || !intakeEventsAvailable || running;
  intakeNfcButton.textContent = active ? "NFC provisioning active" : "Start NFC provisioning";
  intakeEndNfcButton.hidden = !active;
  intakeEndNfcButton.disabled = !active || busy || pending;
  intakeEventSelect.disabled = !intakeEventsAvailable || running || pending;
  intakeLocation.disabled = running;
};

const intakePost = (path, body) => intakeApi(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const intakeOfferTakeover = (record) => {
  intakeTakeoverCandidate = intakeSafeTakeoverCandidate(record);
  intakeTakeoverPanel.hidden = intakeTakeoverCandidate === null;
  intakeTakeoverMessage.textContent = intakeTakeoverCandidate === null
    ? ""
    : "Pending Duck #" + intakeTakeoverCandidate.visibleNumber + " has had no ownership activity for at least 10 minutes.";
};

const intakeRefreshStation = async () => {
  const eventId = intakeEventSelect.value;
  if (!eventId) {
    intakeSelectedEvent = null;
    intakeReservedCount.textContent = "0";
    return;
  }
  const detail = await intakeApi("/api/v1/staff/events/" + encodeURIComponent(eventId));
  intakeSelectedEvent = detail.event;
  intakeReservedCount.textContent = String(detail.summary.eventDucks);
  if (!intakePreRaceStatuses.has(detail.event.status)) {
    intakeSetState("error");
    intakeSetMessage("NFC provisioning is closed for the selected event.", true);
  }
};

const intakeAddHistory = ({ outcome }) => {
  if (intakeHistory.children.length === 1 && intakeHistory.firstElementChild.textContent.startsWith("No ducks")) {
    intakeHistory.replaceChildren();
  }
  const item = document.createElement("li");
  item.textContent = outcome === "added" ? "Sticker provisioned and reserved" : "Already provisioned; count unchanged";
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

intakeMachine = intakeCreateProvisioningMachine({
  eventId: () => intakeEventSelect.value,
  location: () => intakeLocation.value.trim(),
  recover: async (eventId) => {
    const body = await intakeApi("/api/v1/staff/inventory/provisioning?eventId=" + encodeURIComponent(eventId));
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
});

intakeTakeoverButton.addEventListener("click", async () => {
  const candidate = intakeTakeoverCandidate;
  if (candidate === null || intakeMachine.isBusy() || intakeMachine.hasPending()) return;
  if (!window.confirm(
    "Take over pending Duck #" + candidate.visibleNumber
    + "? Continue only if the previous provisioning station has been abandoned."
  )) return;
  intakeTakeoverButton.disabled = true;
  intakeSetMessage("Taking ownership of the abandoned pending sticker.", false);
  try {
    const recovered = await intakePost("/api/v1/staff/inventory/provisioning/takeover", {
      commandId: crypto.randomUUID(),
      eventId: intakeEventSelect.value,
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
  }
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
      : "Ready. Tap the first blank writable sticker.", false);
  },
});

const intakeRecoverSelected = async () => {
  intakeMachine.resetForEvent();
  await intakeRefreshStation();
  if (!intakeEventSelect.value) return;
  const pending = await intakeMachine.recover();
  intakeSetMessage(pending
    ? "A pending sticker is waiting. Press Start, then retap that same sticker."
    : "Press Start once, then tap one blank writable sticker per duck.", false);
  intakeUpdateControls();
};

const intakeLoadEvents = async () => {
  const body = await intakeApi("/api/v1/staff/events");
  const available = body.events.filter((event) => intakePreRaceStatuses.has(event.status));
  intakeEventsAvailable = available.length > 0;
  intakeEventSelect.replaceChildren();
  if (available.length !== 1) {
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = available.length ? "Select an event" : "No events accepting provisioning";
    intakeEventSelect.append(prompt);
  }
  for (const event of available) {
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = event.name + " · " + event.status.replaceAll("_", " ").toLowerCase();
    intakeEventSelect.append(option);
  }
  if (available.length === 1) intakeEventSelect.value = available[0].id;
  await intakeRecoverSelected();
  intakeUpdateControls();
};

intakeEventSelect.addEventListener("change", async () => {
  if (intakeStarted) return;
  try {
    await intakeRecoverSelected();
  } catch {
    intakeSetMessage("The selected event could not be refreshed. Stay online and try again.", true);
  }
});

let intakeTopLevel = false;
try { intakeTopLevel = window.top === window.self; } catch {}
intakeSupported = "NDEFReader" in globalThis && isSecureContext && intakeTopLevel;
if (!intakeSupported) {
  intakeSetState("error");
  intakeSetMessage("This station requires current Android Chrome, an NFC-capable device, HTTPS, a top-level tab, and a visible page. There is no manual fallback.", true);
}
intakeUpdateControls();

intakeNfcButton.addEventListener("click", async () => {
  if (!intakeSupported || intakeStarted || intakeStarting) return;
  if (
    !intakeSelectedEvent
    || intakeSelectedEvent.id !== intakeEventSelect.value
    || !intakePreRaceStatuses.has(intakeSelectedEvent.status)
  ) {
    intakeSetState("error");
    intakeSetMessage("Select an available draft or registration-stage event before starting.", true);
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
  intakeSetMessage("NFC provisioning ended. Press Start to resume when ready.", false);
  intakeUpdateControls();
});

intakeLoadEvents().catch(() => intakeSetMessage("The station could not load events. Stay online, then refresh this page.", true));
`;

export const staffHomeScript = String.raw`
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
const canReturns = hasRole("RETURN_STEWARD") || hasRole("RACE_DIRECTOR");
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
    if (canDirectRace && (!state.requiresAdmin || isSystemAdmin)) {
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
    const loads = [];
    if (canInventory) loads.push(loadInventory());
    if (canReturns) loads.push(loadReturnReview());
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
  const detail = await api("/api/v1/staff/events/" + encodeURIComponent(eventId));
  const readiness = canRaceRead
    ? await api("/api/v1/staff/events/" + encodeURIComponent(eventId) + "/readiness")
    : { readiness: {} };
  renderEvent(detail, readiness);
  const loads = [];
  if (canRegistration) loads.push(loadParticipants());
  if (canInventory) loads.push(loadInventory());
  if (canRaceRead) loads.push(loadHeats(), loadFinalists());
  if (canReturns) loads.push(loadReturnReview());
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
  participantEditForm.elements.duckKeepPreference.value = registration.duckKeepPreference;
  participantEditForm.elements.notes.value = registration.notes || "";
  participantActions.replaceChildren();
  if (canInventory) {
    addParticipantAction("Use for duck assignment", "button secondary small", () => {
      document.querySelector("[data-inventory-assign-form]").elements.raceEntryId.value = registration.raceEntryId;
      document.querySelector("#inventory").scrollIntoView({ behavior: "smooth" });
    });
  }
  if (["SUBMITTED", "ACTIVE"].includes(registration.status)) {
    addParticipantAction("Withdraw", "button danger small", (event) => changeParticipantStatus("withdraw", "Withdraw participant", true, event.currentTarget));
    if (canDirectRace) addParticipantAction("Disqualify", "button danger small", (event) => changeParticipantStatus("disqualify", "Disqualify participant", true, event.currentTarget));
  }
  if (canDirectRace && ["WITHDRAWN", "DISQUALIFIED"].includes(registration.status)) {
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
        emailNotificationsEnabled: false,
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
        emailNotificationsEnabled: false,
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
    ["Participant", duck.participant
      ? duck.participant.firstName
        ? duck.participant.firstName + " " + duck.participant.lastName
        : "Assigned race entry " + duck.participant.raceEntryId
      : "Unassigned"],
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
    const participant = item.participant.firstName
      ? item.participant.firstName + " " + item.participant.lastName
      : "Race entry " + item.participant.raceEntryId;
    inventoryHistory.append(historyCard("Assignment · " + participant, item.validTo ? "Closed " + item.validTo : "Active since " + item.validFrom));
  }
  if (!inventoryHistory.childElementCount) inventoryHistory.append(empty("No inventory history is recorded."));
};

const loadDuckDetail = async (duckId) => {
  const body = await api("/api/v1/staff/inventory/ducks/" + encodeURIComponent(duckId));
  renderDuckDetail(body);
};

const refreshSelectedDuck = async () => {
  const duckId = selectedDuck.id;
  const loads = [loadInventory(), loadDuckDetail(duckId)];
  if (canRegistration) loads.push(loadParticipants());
  await Promise.all(loads);
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
  if (!canDirectRace) return;
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
    const readback = selects.map(([place, select]) => {
      const label = place === 1 ? "First place" : place === 2 ? "Second place" : "Third place";
      return label + ": " + (select.selectedOptions[0]?.textContent || "not selected");
    }).join("; ");
    const action = mode === "finalize" ? "Publish this official result now" : "Replace the official result now";
    if (!confirm(action + "? Read back: " + readback + ". This changes the public result immediately.")) return;
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
      if (!confirm(confirmation)) return;
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
  if (canTakeResults && body.heat.status === "AWAITING_RESULT") heatControls.append(resultForm(body, "finalize"));
  if (canDirectRace && body.heat.status === "FINALIZED" && body.results.length > 0) {
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
    const loads = [loadReturnReview()];
    if (canInventory) loads.push(loadInventory());
    await Promise.all(loads);
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
    const loads = [loadReturnReview()];
    if (canInventory) loads.push(loadInventory());
    await Promise.all(loads);
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
const staffRoleLabels = {
  REGISTRATION: "Registration",
  DUCK_MANAGER: "Duck manager",
  ANNOUNCER: "Announcer",
  HEAT_RUNNER: "Heat runner",
  RESULT_TAKER: "Result taker",
  RETURN_STEWARD: "Return steward",
  RACE_DIRECTOR: "Race director",
};

const roleSetControl = (selectedRoles) => {
  const fieldset = document.createElement("fieldset");
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
  if (!confirm("Really " + description + "?")) return;
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
    const controls = text("div", "", "actions");
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

loadEvents().catch((error) => {
  if (error.message !== "signed-out") setMessage(error.message, true);
});
`;

export const staffDuckScript = finishHandoffHelpersScript + String.raw`
const finishStationStorageKey = "quickducks.finishStation";
const finishStationTagMatch = location.pathname.match(/^\/staff\/ducks\/([A-Za-z0-9_-]{22,128})$/);
let finishStationHandoff = false;
try {
  const stored = JSON.parse(localStorage.getItem(finishStationStorageKey) || "null");
  const handoffSearch = finishStationTagMatch
    ? finishBuildHandoffSearch(stored, finishStationTagMatch[1])
    : null;
  if (handoffSearch === null) localStorage.removeItem(finishStationStorageKey);
  else {
    localStorage.removeItem(finishStationStorageKey);
    finishStationHandoff = true;
    location.replace("/staff/finish-line?" + handoffSearch);
  }
} catch {
  try { localStorage.removeItem(finishStationStorageKey); } catch {}
}
if (!finishStationHandoff) {
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
  if (!data.permissions.recordDisposition || !data.event || !["COMPLETED", "RETURN_PROCESSING"].includes(data.event.status)) return false;
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
  const participant = data.assignment.participant || {};
  pageTitle.textContent = "Inspect Duck #" + data.duck.visibleNumber;
  message.textContent = "This duck is already paired. Review the assignment below.";
  addFact("Duck", "#" + data.duck.visibleNumber);
  addFact("Inventory", data.duck.inventoryStatus.replaceAll("_", " ").toLowerCase());
  if (participant.firstName) addFact("Participant", participant.firstName + " " + participant.lastName);
  if (participant.lookupCode) addFact("Lookup code", participant.lookupCode);
  if (participant.registrationStatus) addFact("Registration", participant.registrationStatus.replaceAll("_", " ").toLowerCase());
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
      const contact = [registration.email, registration.phone].filter(Boolean).join(" · ") || "No email or phone provided";
      const button = text("button", "", "result-button");
      button.type = "button";
      button.disabled = registration.assignedDuckNumber !== null;
      button.append(
        text("strong", registration.firstName + " " + registration.lastName + " · " + registration.lookupCode),
        text("span", contact + " · " + assignment, "muted"),
      );
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
}
`;
