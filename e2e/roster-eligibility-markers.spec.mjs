import { expect, test } from "@playwright/test";

import {
  accountWith,
  changeRegistrationStatus,
  expectNoDocumentOverflow,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

// Staff see everyone; only public surfaces hide a racer who has left. A racer
// who withdraws or is disqualified keeps their slot on every staff roster,
// because their duck was sealed into that numbered heat bag when they were
// paired and it still goes down the river. What the staff surfaces must add is
// an unmissable marker, so the announcer does not call that name and the start
// line can reconcile the bag against who is actually racing.

const runningHeatWithRoster = async (token, eventId) => {
  const listed = await rawJson(`/api/v1/staff/events/${eventId}/heats`, { token });
  const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
  expect(running, "the seeded race leaves one heat running").toBeTruthy();
  const detail = await rawJson(`/api/v1/staff/events/${eventId}/heats/${running.id}`, { token });
  expect(detail.body.roster.length).toBeGreaterThanOrEqual(2);
  return { heat: running, roster: detail.body.roster };
};

const rowFor = (page, container, duckNumber) =>
  page.locator(`${container} li`).filter({ hasText: `Duck #${duckNumber}` });

test.describe("staff rosters mark racers who can no longer win", () => {
  test("the announcer and the start line mark a racer who leaves mid-round", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Round one, mid-race: one heat is published and one is on the water.
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { heat, roster } = await runningHeatWithRoster(admin.token, seeded.eventId);
    const leavingEntry = roster[0];
    const stayingEntry = roster[1];
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === leavingEntry.duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    const leavingName = `${leaving.firstName} ${leaving.lastName}`;

    // --- Announcer -------------------------------------------------------
    await signIn(page, admin.email, "/staff/announcer");
    const announcerRow = rowFor(page, "[data-announcer-roster]", leaving.visibleNumber);
    await expect(announcerRow).toContainText(leavingName);
    await expect(announcerRow.locator(".roster-flag")).toHaveCount(0);

    // No reload: the station subscribes to the participants domain and repaints
    // from the authoritative roster by itself.
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    await expect(announcerRow.locator(".roster-flag")).toHaveText(
      "Do not announce · Withdrawn",
      { timeout: 20_000 },
    );
    await expect(announcerRow.locator(".roster-flag-note")).toHaveText(
      "The duck stays in its heat bag and still races, but cannot be recorded as a winner.",
    );
    // The racer is marked, never hidden: staff still have to account for that
    // duck, so the slot, the name, and the duck number all stay put.
    await expect(announcerRow).toContainText(leavingName);
    await expect(announcerRow).toContainText(`Duck #${leaving.visibleNumber}`);
    await expect(page.locator("[data-announcer-roster] li")).toHaveCount(roster.length);
    // Every other racer on the same roster is untouched.
    const untouched = rowFor(page, "[data-announcer-roster]", stayingEntry.duck.visibleNumber);
    await expect(untouched.locator(".roster-flag")).toHaveCount(0);

    // --- Start line ------------------------------------------------------
    await page.goto("/staff/start-line");
    const startRow = rowFor(page, "[data-station-roster]", leaving.visibleNumber);
    await expect(startRow).toContainText(leavingName);
    await expect(startRow.locator(".roster-flag")).toHaveText("Racer out · Withdrawn");
    await expect(startRow.locator(".roster-flag-note")).toHaveText(
      "The duck stays in its heat bag and still races, but cannot be recorded as a winner.",
    );
    await expect(page.locator("[data-station-roster] li")).toHaveCount(roster.length);

    // A disqualification on the same station reads with its own real status
    // word, live, with no reload and no heat transition in between.
    const barred = seeded.participants.find((participant) =>
      participant.visibleNumber === stayingEntry.duck.visibleNumber
    );
    await changeRegistrationStatus(admin.token, barred.registrationId, "disqualify");
    const barredRow = rowFor(page, "[data-station-roster]", barred.visibleNumber);
    await expect(barredRow.locator(".roster-flag")).toHaveText(
      "Racer out · Disqualified",
      { timeout: 20_000 },
    );
    // Nothing moved: the heat still holds every entry in its original slot.
    const after = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`, {
      token: admin.token,
    });
    expect(after.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    expect(errors).toEqual([]);
  });

  test("marked rosters still fit a 320px phone at the water's edge", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { heat, roster } = await runningHeatWithRoster(admin.token, seeded.eventId);
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === roster[0].duck.visibleNumber
    );
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, admin.email, "/staff/announcer");
    await expect(page.locator("[data-announcer-roster] .roster-flag").first()).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.goto("/staff/start-line");
    await expect(page.locator("[data-station-roster] .roster-flag").first()).toBeVisible();
    await expectNoDocumentOverflow(page);

    // The console carries the same marker on its heat roster, in a much denser
    // layout beside the race-entry UUID, so it is the hardest narrow-width case.
    // The Admin console is a menu bar over separate views, so the heats view is
    // reached through its own hash rather than by scrolling.
    await page.goto("/staff#heats");
    const heatButton = page.locator("[data-heat-list]")
      .getByRole("button", { name: `Heat ${heat.number} ·` });
    await expect(heatButton).toBeVisible();
    await heatButton.click();
    // The heat list repaints on every live signal, so a click can land on a card
    // that is being replaced and open nothing, or open the heat that took its
    // place. The detail heading is the console's own statement of which heat is
    // actually open, so the roster assertion below waits for it and retries the
    // click rather than reading whichever roster happened to be painted.
    const openHeat = page.locator("[data-heat-name]");
    await expect(async () => {
      if (!(await openHeat.textContent() ?? "").includes(`Heat ${heat.number}`)) {
        await heatButton.click();
      }
      await expect(openHeat).toContainText(`Heat ${heat.number}`, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const consoleRow = page.locator("[data-heat-roster] li")
      .filter({ hasText: `Duck #${leaving.visibleNumber}` });
    await expect(consoleRow.locator(".roster-flag")).toHaveText("Cannot win · Withdrawn");
    await expectNoDocumentOverflow(page);

    expect(errors).toEqual([]);
  });

  test("event readiness reports a withdrawn racer as a note, not a blocker", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Registration closed: every heat is planned and round one has not started,
    // which is exactly where the Start round one card is still upcoming.
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const leaving = seeded.participants.find((participant) => participant.visibleNumber === 105);
    expect(leaving).toBeTruthy();

    await signIn(page, admin.email);
    const startRoundOne = page.locator("[data-event-readiness] .data-card")
      .filter({ hasText: "Start round one" });
    await expect(startRoundOne).toBeVisible();
    await expect(startRoundOne.locator(".readiness-note")).toHaveCount(0);
    await expect(startRoundOne.locator(".status-chip.ready")).toBeVisible();

    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");
    await page.getByRole("button", { name: "Refresh event" }).click();

    await expect(startRoundOne.locator(".readiness-note")).toHaveText(
      "1 racer on a round-one roster is withdrawn or disqualified. That duck stays in its"
      + " heat bag and races as normal, but cannot be recorded as a winner.",
    );
    // Informational only: the transition is still Ready and still offered.
    await expect(startRoundOne.locator(".status-chip.ready")).toBeVisible();
    await expect(startRoundOne.locator(".status-chip.blocked")).toHaveCount(0);
    await expect(startRoundOne.getByRole("button", { name: "Start round one" })).toBeEnabled();
    // A note never wears the blocking-reason treatment.
    await expect(startRoundOne.locator("p.muted")).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
