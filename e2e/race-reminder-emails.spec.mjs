import { expect, test } from "@playwright/test";

import {
  bootstrap,
  intakeDuck,
  pairDuck,
  seedState,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

test("an opted-in participant receives assignment and authoritative next-heat reminders", async ({ page }) => {
  // Two seeded racers plus the participant registered below make one valid
  // three-duck heat. Keep this event throughout the scenario: seedState resets
  // the database and must never be used as a mid-test advancement helper.
  const seeded = await seedState("registration", { participants: 2, heatSize: 3 });
  const { client } = await bootstrap();
  await expect.poll(async () => (await client.get("/__local/emails")).body.emails.length).toBeGreaterThan(0);
  await client.request("/__local/emails", { method: "DELETE", expect: [204] });

  const errors = watchBrowserErrors(page);
  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await registration.getByLabel("First name").fill("Reminder");
  await registration.getByLabel("Last name").fill("Racer");
  await registration.getByLabel(/Email/).fill("reminder.racer@example.test");
  await registration.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(/\/my-ducks$/);

  const card = page.locator("[data-registration-id]").filter({
    has: page.getByRole("heading", { name: "Reminder Racer", exact: true }),
  });
  await card.getByRole("button", { name: "Edit contact details" }).click();
  await card.getByRole("checkbox", {
    name: "Send operational race updates by email",
    exact: true,
  }).check();
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(card.locator("[data-contact-summary]")).toContainText("Email updates: Opted in");

  const registrations = await client.get(
    `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("Reminder Racer")}`,
  );
  const target = registrations.body.registrations.find((candidate) => candidate.firstName === "Reminder");
  expect(target).toBeTruthy();

  // The second seeded participant is deliberately left unpaired in the
  // registration fixture. Pair both outstanding racers without replacing the
  // event or bypassing any lifecycle/readiness handler.
  const secondDuck = await intakeDuck(client, seeded.eventId, 501);
  await pairDuck(client, seeded.eventId, secondDuck, seeded.participants[1]);
  const targetDuck = await intakeDuck(client, seeded.eventId, 502);
  await pairDuck(client, seeded.eventId, targetDuck, target);

  const targetEmails = async () => (await client.get("/__local/emails")).body.emails
    .filter((email) => email.to === "reminder.racer@example.test");
  await expect.poll(async () => (await targetEmails()).length).toBe(1);
  const assignment = (await targetEmails())[0];
  expect(assignment.from).toBe("race@quickducks.local");
  expect(assignment.subject).toContain("Duck #502 is assigned to Round One, Heat 1");
  expect(assignment.text).toContain("stay near the pond");

  await client.post(`/api/v1/staff/events/${seeded.eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  });
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  });
  await expect.poll(async () => (await targetEmails()).length).toBe(2);
  const heats = await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`);
  const heat = heats.body.heats.find((candidate) => candidate.round === "ROUND_ONE");
  await transitionHeat(client, seeded.eventId, heat, "ready");
  await transitionHeat(client, seeded.eventId, heat, "call");

  await expect.poll(async () => (await targetEmails()).length).toBe(2);
  const upcoming = (await targetEmails())[1];
  expect(upcoming.subject).toContain("Round One, Heat 1 is next to race");
  expect(upcoming.text).toContain("Please bring Duck #502 to the pond");
  expect(upcoming.text).not.toMatch(/\b\d{1,2}:\d{2}\b/);

  const serialized = JSON.stringify(await targetEmails());
  const unsubscribeUrl = assignment.text.match(/Unsubscribe this email address: (\S+)/)?.[1];
  expect(unsubscribeUrl).toBeTruthy();
  await page.goto(unsubscribeUrl);
  await expect(page.getByRole("heading", { name: "Email updates are off" })).toBeVisible();
  const ownershipProofs = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem("quickducks.participant-ownership.v1") || "{}")));
  for (const proof of ownershipProofs) expect(serialized).not.toContain(proof);
  expect(errors).toEqual([]);
});
