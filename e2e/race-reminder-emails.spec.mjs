import { expect, test } from "@playwright/test";

import {
  bootstrap,
  intakeDuck,
  pairDuck,
  seedState,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

test("an opted-in participant receives independent registration, assignment, and next-heat notifications", async ({ page }) => {
  // Two seeded racers plus the participant registered below make one valid
  // three-duck heat. Keep this event throughout the scenario: seedState resets
  // the database and must never be used as a mid-test advancement helper.
  const seeded = await seedState("registration", { participants: 2, heatSize: 3 });
  const { client } = await bootstrap();
  await expect.poll(async () => (await client.get("/__local/emails")).body.emails.length).toBeGreaterThan(0);
  await client.request("/__local/notifications", { method: "DELETE", expect: [204] });

  const errors = watchBrowserErrors(page);
  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await registration.getByLabel("First name").fill("Reminder");
  await registration.getByLabel("Last name").fill("Racer");
  await registration.getByLabel(/Email/).fill("reminder.racer@example.test");
  await registration.getByLabel(/Phone/).fill("(817) 320-6150");
  await registration.getByRole("checkbox", {
    name: "Send operational race updates by email",
    exact: true,
  }).check();
  await registration.getByRole("checkbox", {
    name: "Send operational race updates by SMS",
    exact: true,
  }).check();
  await registration.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(/\/my-ducks$/);

  const targetNotifications = async () => (await client.get("/__local/notifications")).body;
  await expect.poll(async () => (await targetNotifications()).emails
    .filter((email) => email.to === "reminder.racer@example.test").length).toBe(1);
  await expect.poll(async () => (await targetNotifications()).sms
    .filter((message) => message.to === "+18173206150").length).toBe(1);

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
  await expect.poll(async () => (await targetEmails()).length).toBe(2);
  const assignment = (await targetEmails())[1];
  expect(assignment.from).toBe("race@quickducks.local");
  expect(assignment.subject).toContain("Duck #502 is assigned to Round One, Heat 1");
  expect(assignment.text).toContain("stay near the pond");

  await client.post(`/api/v1/staff/events/${seeded.eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  });
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  });
  await expect.poll(async () => (await targetEmails()).length).toBe(3);
  const upcoming = (await targetEmails())[2];
  expect(upcoming.subject).toContain("Round One, Heat 1 is next");
  expect(upcoming.text).toContain("Please bring Duck #502 to the pond");
  expect(upcoming.text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
  const heats = await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`);
  const heat = heats.body.heats.find((candidate) => candidate.round === "ROUND_ONE");
  await transitionHeat(client, seeded.eventId, heat, "ready");
  await transitionHeat(client, seeded.eventId, heat, "call");

  await expect.poll(async () => (await targetEmails()).length).toBe(3);
  const targetSms = (await targetNotifications()).sms.filter((message) => message.to === "+18173206150");
  expect(targetSms).toHaveLength(3);
  expect(targetSms.every((message) => message.body.includes("Reply STOP to opt out."))).toBe(true);

  const serialized = JSON.stringify(await targetEmails());
  const ownershipProofs = await page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem("quickducks.participant-ownership.v1") || "{}")));
  for (const proof of ownershipProofs) expect(serialized).not.toContain(proof);
  const unsubscribeUrl = (await targetEmails())[0].text.match(
    /Unsubscribe from participant email updates: (https?:\/\/\S+)/,
  )?.[1];
  expect(unsubscribeUrl).toBeTruthy();
  await page.goto(unsubscribeUrl);
  await expect(page.getByRole("heading", { name: "Stop participant email updates?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop email updates" }).click();
  await expect(page.getByRole("heading", { name: "Email updates stopped" })).toBeVisible();
  expect(errors).toEqual([]);
});
