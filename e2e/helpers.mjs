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
  const privateToken = randomToken();
  const response = await client.post("/api/v1/registrations", {
    eventId,
    commandId: crypto.randomUUID(),
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

export const rejectSensitiveKeys = (value) => {
  const forbidden = new Set([
    "email", "phone", "lookupCode", "privateToken", "privateStatusPath",
    "notes", "location", "storageLocation", "audit", "tagToken",
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
