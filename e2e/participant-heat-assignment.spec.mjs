import { expect, test } from "@playwright/test";

import {
  bootstrap,
  changeRegistrationStatus,
  expectNoDocumentOverflow,
  intakeDuck,
  pairDuck,
  rawJson,
  seedState,
  signIn,
  transitionHeat,
  finalizeHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

// Selecting a participant has to answer "which numbered bag is this duck in",
// because that is the question a staffer standing at the pond is actually
// holding the duck to ask. A bare heat number is not an answer once a final
// exists, and a blank field is worse than a slow one: it reads as "no heat"
// when it may only mean "not loaded".
//
// These specs drive the real Admin console against a real seeded race, so the
// value on screen is the one the server committed rather than one the browser
// worked out for itself.

// Exactly the route the Admin console's own specs take: pick the view from the
// menu bar and wait for the list the view loads by itself. Nothing here presses
// a reload control, so the rows under test are the ones the console renders on
// its ordinary path rather than a state only this spec can reach.
const openParticipantsView = async (page, email) => {
  await signIn(page, email);
  await page.getByRole("navigation", { name: "Admin views" })
    .getByRole("link", { name: "Participants", exact: true }).click();
  await expect(page.locator("[data-participant-list] button").first()).toBeVisible();
};

const participantRow = (page, lookupCode) =>
  page.locator("[data-participant-list] button").filter({ hasText: lookupCode });

// The one fact under test, located through its own term rather than by position,
// so reordering the fact list cannot silently make this assert something else.
const heatValue = (page) => page
  .locator("[data-participant-facts] .fact")
  .filter({ has: page.locator("dt", { hasText: /^Heat$/ }) })
  .locator("dd");

const selectParticipant = async (page, lookupCode) => {
  await participantRow(page, lookupCode).click();
  await expect(page.locator("[data-participant-detail]")).toBeVisible();
};

test.describe("the heat assignment in the participant detail panel", () => {
  test("names the round and heat for a paired participant and says so for an unpaired one", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Registration open: two thirds of the participants are paired and the rest
    // are still queueing, so both states exist in one real race.
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();

    const listed = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/registrations?limit=200`,
      { token: admin.token },
    );
    expect(listed.status).toBe(200);
    const assigned = listed.body.registrations.find((registration) =>
      registration.heatAssignments.length === 1
    );
    const unassigned = listed.body.registrations.find((registration) =>
      registration.heatAssignments.length === 0
    );
    expect(assigned, "the seeded race has a paired participant").toBeTruthy();
    expect(unassigned, "the seeded race has an unpaired participant").toBeTruthy();
    expect(assigned.heatAssignments[0].round).toBe("ROUND_ONE");

    await openParticipantsView(page, admin.email);

    // The paired participant names the round and the committed heat number. If
    // the browser had counted list positions instead of rendering the server's
    // answer, this is where a real duck would be sent to the wrong bag.
    await selectParticipant(page, assigned.lookupCode);
    await expect(heatValue(page))
      .toHaveText(`Round One · Heat ${assigned.heatAssignments[0].heatNumber} (upcoming)`);
    await expectNoDocumentOverflow(page);

    // The unpaired participant states it outright. A blank would render as the
    // generic "None" and read as a loading failure.
    await selectParticipant(page, unassigned.lookupCode);
    await expect(heatValue(page)).toHaveText("Not assigned to a heat");

    // Pairing elsewhere publishes a live signal. Keep this exact panel open: it
    // must re-fetch and repaint itself rather than requiring a close/reopen.
    const duck = await intakeDuck(client, seeded.eventId, 701);
    await pairDuck(client, seeded.eventId, duck, unassigned);
    const paired = await rawJson(`/api/v1/staff/registrations/${unassigned.registrationId}`, {
      token: admin.token,
    });
    expect(paired.status).toBe(200);
    expect(paired.body.registration.heatAssignments).toHaveLength(1);

    await expect(heatValue(page))
      .toHaveText(`Round One · Heat ${paired.body.registration.heatAssignments[0].heatNumber} (upcoming)`);

    expect(errors).toEqual([]);
  });

  test("distinguishes the round-one and final places of an advanced participant", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Round one is complete and the finalists are promoted, so a round-one
    // winner genuinely holds a place in two rounds at once.
    const seeded = await seedState("final");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();

    // The final seed stops at CALLING. Start it so this scenario proves the
    // current label separately from the pre-start upcoming scenario below.
    const heats = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(heats.status).toBe(200);
    const finalHeat = heats.body.heats.find((heat) => heat.round === "FINAL");
    expect(finalHeat).toBeTruthy();
    await transitionHeat(client, seeded.eventId, finalHeat, "start");

    const listed = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/registrations?limit=200`,
      { token: admin.token },
    );
    expect(listed.status).toBe(200);
    // Every participant is still exactly one row, even though the finalists
    // below hold two heat places each.
    expect(listed.body.registrations).toHaveLength(seeded.participants.length);

    const finalist = listed.body.registrations.find((registration) =>
      registration.heatAssignments.length === 2
    );
    expect(finalist, "the seeded final has a promoted finalist").toBeTruthy();
    const roundOne = finalist.heatAssignments.find((entry) => entry.round === "ROUND_ONE");
    const final = finalist.heatAssignments.find((entry) => entry.round === "FINAL");
    expect(roundOne).toBeTruthy();
    expect(final).toBeTruthy();

    const stillInRoundOne = listed.body.registrations.find((registration) =>
      registration.heatAssignments.length === 1
    );
    expect(stillInRoundOne, "a non-finalist keeps only its round-one place").toBeTruthy();

    await openParticipantsView(page, admin.email);
    await selectParticipant(page, finalist.lookupCode);

    // Both places are shown, the live one first and marked, and each is named
    // with its round so neither number can be read as the other.
    const shown = heatValue(page);
    await expect(shown).toHaveText(
      `Final · Heat ${final.heatNumber} (current) · advanced from Round One · Heat ${roundOne.heatNumber} (completed)`,
    );
    await expect(shown).toContainText("Final");
    await expect(shown).toContainText("Round One");
    await expectNoDocumentOverflow(page);

    // A participant who did not advance is not given a final place.
    await selectParticipant(page, stillInRoundOne.lookupCode);
    await expect(heatValue(page))
      .toHaveText(`Round One · Heat ${stillInRoundOne.heatAssignments[0].heatNumber} (completed)`);
    await expect(heatValue(page)).not.toContainText("Final");

    // Withdrawal is bookkeeping only: the duck stays sealed in its bag and still
    // floats, so the panel must keep naming the bag rather than pretending the
    // place was released. The non-finalist is the open card here, so selecting
    // the finalist again is a fresh authoritative read rather than a repaint.
    await changeRegistrationStatus(admin.token, finalist.registrationId, "withdraw");
    await selectParticipant(page, finalist.lookupCode);
    await expect(heatValue(page)).toHaveText(
      `Final · Heat ${final.heatNumber} (current) · advanced from Round One · Heat ${roundOne.heatNumber} (completed)`,
    );

    expect(errors).toEqual([]);
  });

  test("marks a promoted Final place upcoming before the Final heat starts", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();

    const listedHeats = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(listedHeats.status).toBe(200);
    for (const listed of listedHeats.body.heats.filter((heat) => heat.round === "ROUND_ONE")) {
      if (listed.status === "FINALIZED") continue;
      const loaded = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${listed.id}`, { token: admin.token });
      expect(loaded.status).toBe(200);
      const heat = loaded.body.heat;
      if (heat.status === "CALLING") await transitionHeat(client, seeded.eventId, heat, "start");
      if (heat.status === "RUNNING") await transitionHeat(client, seeded.eventId, heat, "finish");
      const winner = loaded.body.roster.find((entry) => entry.eligible);
      expect(winner).toBeTruthy();
      await finalizeHeat(client, seeded.eventId, heat, [{ raceEntryId: winner.raceEntryId, place: 1 }]);
    }

    const started = await client.post(`/api/v1/staff/events/${seeded.eventId}/start-final`, {
      commandId: crypto.randomUUID(),
    }, { label: "start synthetic final" });
    expect(started.body.event.status).toBe("FINAL");

    const listed = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/registrations?limit=200`,
      { token: admin.token },
    );
    expect(listed.status).toBe(200);
    const finalist = listed.body.registrations.find((registration) => registration.heatAssignments.length === 2);
    expect(finalist).toBeTruthy();
    const roundOne = finalist.heatAssignments.find((entry) => entry.round === "ROUND_ONE");
    const final = finalist.heatAssignments.find((entry) => entry.round === "FINAL");
    expect(final.status).toBe("LOADING");

    await openParticipantsView(page, admin.email);
    await selectParticipant(page, finalist.lookupCode);
    await expect(heatValue(page)).toHaveText(
      `Final · Heat ${final.heatNumber} (upcoming) · advanced from Round One · Heat ${roundOne.heatNumber} (completed)`,
    );
    expect(errors).toEqual([]);
  });
});
