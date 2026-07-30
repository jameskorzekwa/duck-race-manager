import { expect } from "@playwright/test";

import { localPreviewTurnstileToken } from "../src/local-preview.ts";
import { createClient, randomToken, seed } from "../scripts/seed-local.mjs";

export const baseUrl = "http://localhost:8787";

export const seedState = (state, options = {}) => seed({
  url: baseUrl,
  state,
  participants: options.participants ?? 9,
  heatSize: options.heatSize ?? 3,
});

export const bootstrap = async () => {
  const client = createClient(baseUrl);
  const response = await client.post("/__local/staff", undefined, {
    anonymous: true,
    label: "bootstrap local staff",
  });
  const admin = response.body.accounts.find((account) => account.isSystemAdmin);
  if (!admin) throw new Error("Local staff bootstrap returned no administrator.");
  client.setToken(admin.token);
  return { accounts: response.body.accounts, admin, client };
};

export const accountWith = (accounts, role) => {
  const account = accounts.find((candidate) => candidate.roles.includes(role));
  if (!account) throw new Error(`Local staff bootstrap returned no ${role} account.`);
  return account;
};

export const signIn = async (page, email, returnTo = "/staff") => {
  await page.goto(returnTo);
  if (await page.getByRole("link", { name: "Continue to secure sign in" }).isVisible().catch(() => false)) {
    await page.getByRole("link", { name: "Continue to secure sign in" }).click();
    await page.getByRole("link", { name: new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[?#])`));
};

export const confirmAction = async (page, label = "Confirm") => {
  const dialog = page.getByRole("dialog", { name: "Confirm action" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: label, exact: true }).click();
};

export const watchBrowserErrors = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
};

export const expectNoDocumentOverflow = async (page) => {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
};

export const registerParticipant = async (client, eventId, index, overrides = {}) => {
  const firstName = overrides.firstName ?? `Racer${index}`;
  const lastName = overrides.lastName ?? "Example";
  const commandId = overrides.commandId ?? crypto.randomUUID();
  const privateToken = randomToken();
  const response = await client.post("/api/v1/registrations", {
    eventId,
    commandId,
    privateToken,
    firstName,
    lastName,
    email: `racer${index}@example.test`,
    phone: `+1555020${String(index).padStart(4, "0")}`,
    emailNotificationsEnabled: false,
    turnstileToken: localPreviewTurnstileToken,
  }, { anonymous: true, label: `register synthetic racer ${index}` });
  return {
    firstName,
    lastName,
    privateToken,
    registrationId: response.body.registrationId,
    lookupCode: response.body.lookupCode,
  };
};

export const intakeDuck = async (client, eventId, visibleNumber) => {
  const tagToken = randomToken();
  const response = await client.post("/api/v1/staff/inventory/ducks", {
    commandId: crypto.randomUUID(),
    eventId,
    visibleNumber,
    tagToken,
    physicallyPresent: true,
    location: "Synthetic E2E intake",
  }, { label: `intake synthetic duck ${visibleNumber}` });
  return { tagToken, visibleNumber: response.body.duck.visibleNumber };
};

export const pairDuck = (client, eventId, duck, participant) => client.post(
  `/api/v1/staff/ducks/${duck.tagToken}/assignments`,
  { commandId: crypto.randomUUID(), eventId, lookupCode: participant.lookupCode },
  { label: `pair synthetic duck ${duck.visibleNumber}` },
);

export const transitionHeat = async (client, eventId, heat, operation) => {
  const response = await client.post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/${operation}`, {
    commandId: crypto.randomUUID(),
    revision: heat.revision,
  }, { label: `${operation} synthetic heat ${heat.number}` });
  Object.assign(heat, response.body.heat);
  return response.body.heat;
};

export const finalizeHeat = async (client, eventId, heat, results) => {
  const response = await client.post(`/api/v1/staff/events/${eventId}/heats/${heat.id}/results/finalize`, {
    commandId: crypto.randomUUID(),
    revision: heat.revision,
    results,
  }, { label: `finalize synthetic heat ${heat.number}` });
  Object.assign(heat, response.body.heat);
  return response.body.heat;
};

export const rawJson = async (path, { token, method = "GET", body, origin = baseUrl } = {}) => {
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (origin !== null) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
    headers: response.headers,
  };
};

// Ends a participant's current duck assignment through the inventory API. The
// registration keeps the ended assignment row and its heat place, which is
// exactly the state that makes `currentlyPaired` false while `deletable` stays
// false — the case the staff console used to get wrong.
export const unassignDuck = async (token, eventId, registrationId) => {
  const ducks = await rawJson("/api/v1/staff/inventory/ducks", { token });
  expect(ducks.status).toBe(200);
  const duck = ducks.body.ducks.find((candidate) =>
    candidate.assignment !== null && candidate.participant?.registrationId === registrationId
  );
  expect(duck, `no current assignment for ${registrationId}`).toBeTruthy();
  const response = await rawJson(`/api/v1/staff/inventory/assignments/${duck.assignment.id}/unassign`, {
    token,
    method: "POST",
    body: {
      commandId: crypto.randomUUID(),
      eventId,
      expectedRevision: duck.revision,
      releaseReservation: false,
      reason: "Playwright verifies the unassigned-but-undeletable console rule.",
    },
  });
  expect(response.status, `unassign ${duck.visibleNumber}: ${JSON.stringify(response.body)}`).toBe(201);
  return duck;
};

// Withdrawal, disqualification, and reactivation through the same staff API the
// console posts to, revision and all. Nothing here writes SQL, so a spec can
// only reach states the application itself allows: if the server refuses the
// transition the spec fails here rather than silently testing a fiction.
export const changeRegistrationStatus = async (token, registrationId, operation) => {
  const current = await rawJson(`/api/v1/staff/registrations/${registrationId}`, { token });
  expect(current.status, `load ${registrationId} before ${operation}`).toBe(200);
  const response = await rawJson(`/api/v1/staff/registrations/${registrationId}/${operation}`, {
    token,
    method: "POST",
    body: { commandId: crypto.randomUUID(), expectedRevision: current.body.registration.revision },
  });
  expect(response.status, `${operation} ${registrationId}: ${JSON.stringify(response.body)}`).toBe(201);
  return response.body.registration;
};

// The public board as the browser sees it, reduced to the two things a
// withdrawal must never disturb: which heats exist, and the exact order of the
// racers and duck numbers inside them.
export const publicBoardShape = async () => {
  const board = await rawJson("/api/v1/race-board");
  expect(board.status).toBe(200);
  const heats = [...board.body.event.roundOneHeats, ...board.body.event.finalHeats];
  return {
    heats: heats.map((heat) => ({
      round: heat.round,
      number: heat.number,
      roster: heat.roster.map((entry) => `${entry.participantDisplayName}|${entry.duckNumber}|${entry.place}`),
    })),
    podium: board.body.event.podium.map((entry) =>
      `${entry.place}|${entry.participantDisplayName}|${entry.duckNumber}`
    ),
  };
};

export const rejectSensitiveKeys = (value) => {
  const forbidden = new Set([
    "email", "phone", "lookupCode", "privateToken", "privateStatusPath",
    "emailNotificationsEnabled", "smsNotificationsEnabled", "ownershipProof",
    "email_notifications_enabled", "sms_notifications_enabled", "ownershipProofHash",
    "ownership_proof_hash", "notes", "location", "storageLocation", "audit", "tagToken",
  ]);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      expect(forbidden.has(key), `public response exposed ${key}`).toBe(false);
      visit(child);
    }
  };
  visit(value);
};
