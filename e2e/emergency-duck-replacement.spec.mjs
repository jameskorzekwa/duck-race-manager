import { expect, test } from "@playwright/test";

import {
  bootstrap,
  confirmAction,
  expectHorizontallyCentered,
  expectNoDocumentOverflow,
  intakeDuck,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const mobileWidths = [320, 375, 430];

const replacementPayload = (eventId, candidate, inspection, incidentType = "LOST") => ({
  commandId: crypto.randomUUID(),
  eventId,
  raceEntryId: candidate.raceEntryId,
  expectedAssignmentId: candidate.currentAssignment.id,
  expectedReplacementReservationId: inspection.duck.reservationId,
  expectedEventStatus: candidate.event.status,
  expectedEventRevision: candidate.event.revision,
  expectedHeatId: candidate.currentHeat.id,
  expectedHeatRevision: candidate.currentHeat.revision,
  expectedRegistrationRevision: candidate.registrationRevision,
  expectedRaceEntryRevision: candidate.raceEntryRevision,
  expectedCurrentDuckRevision: candidate.currentAssignment.duckRevision,
  expectedReplacementDuckRevision: inspection.duck.revision,
  incidentType,
});

const exerciseReplacement = async (page, state, spareNumber) => {
  const seeded = await seedState(state, { participants: 9, heatSize: 3 });
  const { admin, client } = await bootstrap();
  const spare = await intakeDuck(client, seeded.eventId, spareNumber);
  const candidates = await rawJson(
    `/api/v1/staff/registrations/replacement-search?eventId=${seeded.eventId}&q=`,
    { token: admin.token },
  );
  expect(candidates.status).toBe(200);
  expect(candidates.body.candidates.length).toBeGreaterThan(0);
  const candidate = candidates.body.candidates[0];
  const participantName = `${candidate.participant.firstName} ${candidate.participant.lastName}`;
  const oldDuckLabel = `Duck #${candidate.currentAssignment.duckNumber}`;
  const newDuckLabel = `Duck #${spare.visibleNumber}`;
  const errors = watchBrowserErrors(page);

  await signIn(page, admin.email, `/staff/ducks/${spare.tagToken}`);
  await expect(page.getByRole("heading", { name: `Last resort for a lost or damaged duck` })).toBeVisible();
  await expect(page.getByText("This is only a last resort for a lost or damaged duck.", { exact: false })).toBeVisible();
  await expect(page.locator("[data-replacement-duck]")).toContainText(`Duck #${spare.visibleNumber}`);

  const search = page.getByLabel("Paired participant name or current duck number");
  await search.fill(participantName);
  await page.getByRole("button", { name: "Find paired participant" }).click();
  await page.getByRole("button", { name: new RegExp(`${participantName}.*${oldDuckLabel}`) }).click();
  const review = page.locator("[data-replacement-review]");
  await expect(review).toContainText(participantName);
  await expect(review).toContainText(oldDuckLabel);
  await expect(review).toContainText(newDuckLabel);
  await expect(review).toContainText(state === "final" ? "Final · Heat" : "Round One · Heat");
  await page.getByLabel("The current duck is lost").check();
  const replacementConfirmation = page.locator("[data-replacement-confirmation]");
  const replacementButton = page.getByRole("button", { name: "Confirm emergency replacement" });
  for (const width of mobileWidths) {
    await page.setViewportSize({ width, height: 900 });
    await expectHorizontallyCentered(replacementButton, replacementConfirmation);
    await expectNoDocumentOverflow(page);
  }

  let replacementRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/v1/staff/ducks/${spare.tagToken}/replacement`
      && request.method() === "POST") replacementRequests += 1;
  });
  await replacementButton.click();
  const dialog = page.getByRole("dialog", { name: "Confirm action" });
  await expect(dialog).toContainText(participantName);
  await expect(dialog).toContainText(oldDuckLabel);
  await expect(dialog).toContainText(newDuckLabel);
  await expect(dialog).toContainText("last resort for a lost or damaged duck");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(replacementRequests).toBe(0);

  await replacementButton.click();
  await confirmAction(page, "Replace duck");
  await expect(page.getByRole("heading", { name: `${newDuckLabel} replaced ${oldDuckLabel}` })).toBeVisible();
  await expect(page.locator("[data-staff-message]")).toContainText("Emergency replacement saved");
  expect(replacementRequests).toBe(1);

  const newInspection = await rawJson(`/api/v1/staff/ducks/${spare.tagToken}`, { token: admin.token });
  const oldParticipant = seeded.participants.find((participant) =>
    participant.visibleNumber === candidate.currentAssignment.duckNumber
  );
  const oldInspection = await rawJson(`/api/v1/staff/ducks/${oldParticipant.tagToken}`, { token: admin.token });
  expect(newInspection.status).toBe(200);
  expect(newInspection.body.assignment.raceEntryId).toBe(candidate.raceEntryId);
  expect(oldInspection.status).toBe(200);
  expect(oldInspection.body.assignment).toBeNull();
  expect(oldInspection.body.winnerAction).toBeNull();

  await page.setViewportSize({ width: 320, height: 900 });
  await expectNoDocumentOverflow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectNoDocumentOverflow(page);
  expect(errors).toEqual([]);
};

test("Round One replacement is an explicit last-resort scan workflow", async ({ page }) => {
  await exerciseReplacement(page, "round-one", 901);
});

test("Final replacement preserves finalist context and invalidates the old tag", async ({ page }) => {
  await exerciseReplacement(page, "final", 902);
});

test("a stale browser fails closed and refreshes the authoritative replacement", async ({ page }) => {
  const seeded = await seedState("round-one", { participants: 9, heatSize: 3 });
  const { admin, client } = await bootstrap();
  const staleSpare = await intakeDuck(client, seeded.eventId, 911);
  const winningSpare = await intakeDuck(client, seeded.eventId, 912);
  const search = await rawJson(
    `/api/v1/staff/registrations/replacement-search?eventId=${seeded.eventId}&q=`,
    { token: admin.token },
  );
  const candidate = search.body.candidates[0];
  const participantName = `${candidate.participant.firstName} ${candidate.participant.lastName}`;
  const errors = watchBrowserErrors(page);

  await signIn(page, admin.email, `/staff/ducks/${staleSpare.tagToken}`);
  await page.getByLabel("Paired participant name or current duck number").fill(participantName);
  await page.getByRole("button", { name: "Find paired participant" }).click();
  await page.getByRole("button", { name: new RegExp(participantName) }).click();
  await page.getByLabel("The current duck is damaged").check();

  const winningInspection = await rawJson(`/api/v1/staff/ducks/${winningSpare.tagToken}`, {
    token: admin.token,
  });
  const competing = await rawJson(`/api/v1/staff/ducks/${winningSpare.tagToken}/replacement`, {
    token: admin.token,
    method: "POST",
    body: replacementPayload(seeded.eventId, candidate, winningInspection.body, "DAMAGED"),
  });
  expect(competing.status).toBe(201);

  await page.getByRole("button", { name: "Confirm emergency replacement" }).click();
  await confirmAction(page, "Replace duck");
  await expect(page.locator("[data-staff-message]")).toContainText("Authoritative pairing and heat details have been refreshed");
  await expect(page.getByRole("heading", { name: /replaced Duck/ })).toHaveCount(0);
  const authoritative = await rawJson(`/api/v1/staff/ducks/${winningSpare.tagToken}`, { token: admin.token });
  expect(authoritative.body.assignment.raceEntryId).toBe(candidate.raceEntryId);
  const staleInspection = await rawJson(`/api/v1/staff/ducks/${staleSpare.tagToken}`, { token: admin.token });
  expect(staleInspection.body.assignment).toBeNull();

  // Chromium reports the intentional HTTP conflict as a resource console error.
  // Assert that exact expected conflict, then keep every other browser error fatal.
  const expectedConflicts = errors.filter((error) => error.includes("409 (Conflict)"));
  expect(expectedConflicts).toHaveLength(1);
  expect(errors.filter((error) => !error.includes("409 (Conflict)"))).toEqual([]);
});
