import { expect, test } from "@playwright/test";

import {
  bootstrap,
  confirmAction,
  expectNoDocumentOverflow,
  intakeDuck,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

// Emergency replacement is the last-resort repair for a duck that was lost or
// damaged while the race is running. It is deliberately not routine pairing, so
// these specs check two things a handler test cannot: that the screen keeps
// saying so, and that the participant's heat, slot, and identity really do
// follow them onto the replacement duck in a real browser.

const panel = (page) => page.locator("[data-replacement-work]");

// Scoped to the replacement panel on purpose. The pairing work area carries a
// search form of its own, so both labels are worded so that neither contains
// the other as a substring and the scoping is belt and braces.
const findRacingParticipant = async (page, query) => {
  await panel(page).getByLabel("Find the racing participant by code, name, phone, or email").fill(query);
  await panel(page).getByRole("button", { name: "Find racing participant" }).click();
};

// The roster of a heat that is still on the water, plus the seeded participant
// behind its first slot. Everything is read back from the staff API rather than
// assumed, so the spec follows whatever the seed actually produced.
const rosterTarget = async (token, eventId, matchHeat) => {
  const listed = await rawJson(`/api/v1/staff/events/${eventId}/heats`, { token });
  expect(listed.status).toBe(200);
  const heat = listed.body.heats.find(matchHeat);
  expect(heat, "the seeded race exposes the heat under test").toBeTruthy();
  const detail = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, { token });
  expect(detail.status).toBe(200);
  expect(detail.body.roster.length).toBeGreaterThanOrEqual(1);
  return { heat, roster: detail.body.roster, entry: detail.body.roster[0] };
};

const participantFor = (seeded, entry) => {
  const participant = seeded.participants.find((candidate) =>
    candidate.visibleNumber === entry.duck.visibleNumber
  );
  expect(participant, "the roster entry maps back to a seeded participant").toBeTruthy();
  return participant;
};

test.describe("emergency replacement of a lost or damaged duck", () => {
  test("replaces a round-one duck and carries the heat, slot, and identity across", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Round one, mid-race: heat 1 is published and heat 2 is on the water.
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    // Every seeded racer already holds a duck, so the spare a staffer would
    // grab has to be taken into inventory here.
    const spare = await intakeDuck(client, seeded.eventId, 701);

    const { heat, roster, entry } = await rosterTarget(
      admin.token,
      seeded.eventId,
      (candidate) => candidate.status === "RUNNING",
    );
    const racer = participantFor(seeded, entry);
    const oldNumber = racer.visibleNumber;

    await signIn(page, admin.email, `/staff/ducks/${spare.tagToken}`);

    // Scanning a spare while a round is running opens the replacement flow
    // rather than the pairing dead end, and says what it is before anything is
    // selected.
    await expect(panel(page)).toBeVisible();
    await expect(page.locator("[data-replacement-warning]"))
      .toContainText("Last resort — lost or damaged duck only.");
    await expect(page.locator("[data-replacement-warning]"))
      .toContainText("This is not routine pairing.");
    await expect(page.locator("[data-staff-message]"))
      .toContainText("Last resort for a lost or damaged duck.");
    // Nothing is confirmable until a participant has actually been chosen.
    await expect(page.locator("[data-confirm-replacement]")).toBeDisabled();
    await expect(page.locator("[data-replacement-readback]")).toBeHidden();

    await findRacingParticipant(page, racer.lookupCode);

    // The list carries enough context to avoid replacing the wrong pairing.
    const row = page.locator("[data-replacement-results] button").first();
    await expect(row).toContainText(`${racer.firstName} ${racer.lastName}`);
    await expect(row).toContainText(`Duck #${oldNumber}`);
    await expect(row).toContainText(`Round one · Heat ${heat.number}`);
    await row.click();

    // The readback names the participant and both duck numbers.
    const readback = page.locator("[data-replacement-readback]");
    await expect(readback).toBeVisible();
    await expect(readback).toContainText(`Replace Duck #${oldNumber} with Duck #${spare.visibleNumber}`);
    await expect(readback).toContainText(`${racer.firstName} ${racer.lastName}`);
    await expect(readback).toContainText(`Round one · Heat ${heat.number}`);
    await expectNoDocumentOverflow(page);

    const replaced = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/staff/ducks/${spare.tagToken}/replacements`)
      && response.request().method() === "POST"
    );
    await page.locator("[data-confirm-replacement]").click();
    // The confirmation is explicit and names the duck being taken out.
    await confirmAction(page, `Replace Duck #${oldNumber}`);
    const result = await (await replaced).json();
    expect(result.previousDuck.visibleNumber).toBe(oldNumber);
    expect(result.duck.visibleNumber).toBe(spare.visibleNumber);
    expect(result.heat.round).toBe("ROUND_ONE");

    await expect(page.locator("[data-staff-title]"))
      .toHaveText(`Duck #${spare.visibleNumber} replaced Duck #${oldNumber}`);
    await expect(page.locator("[data-staff-message]")).toContainText("Replacement saved.");

    // The scanned duck is now the participant's race tag, and the duck it
    // replaced no longer speaks for them.
    const newTag = await rawJson(`/api/v1/staff/ducks/${spare.tagToken}`, { token: admin.token });
    expect(newTag.status).toBe(200);
    expect(newTag.body.assignment).toBeTruthy();
    expect(newTag.body.assignment.active).toBe(true);
    expect(newTag.body.assignment.raceEntryId).toBe(entry.raceEntryId);
    const oldTag = await rawJson(`/api/v1/staff/ducks/${racer.tagToken}`, { token: admin.token });
    expect(oldTag.status).toBe(200);
    expect(oldTag.body.assignment).toBeNull();
    expect(oldTag.body.winnerAction).toBeNull();

    // The started roster was not rebalanced or rewritten: same entries, same
    // slots, same order — only the duck behind slot one changed.
    const after = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`,
      { token: admin.token },
    );
    expect(after.status).toBe(200);
    expect(after.body.roster.map((item) => item.raceEntryId))
      .toEqual(roster.map((item) => item.raceEntryId));
    expect(after.body.roster.map((item) => item.slotNumber))
      .toEqual(roster.map((item) => item.slotNumber));
    expect(after.body.roster[0].duck.visibleNumber).toBe(spare.visibleNumber);

    expect(errors).toEqual([]);
  });

  test("replaces a finalist's duck and keeps their place in the final", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Round one is complete, the finalists are promoted, and the final is called.
    const seeded = await seedState("final");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const spare = await intakeDuck(client, seeded.eventId, 702);

    const { heat, roster, entry } = await rosterTarget(
      admin.token,
      seeded.eventId,
      (candidate) => candidate.round === "FINAL",
    );
    const finalist = participantFor(seeded, entry);
    const oldNumber = finalist.visibleNumber;

    await signIn(page, admin.email, `/staff/ducks/${spare.tagToken}`);
    await expect(panel(page)).toBeVisible();
    await expect(page.locator("[data-replacement-warning]"))
      .toContainText("Last resort — lost or damaged duck only.");

    await findRacingParticipant(page, finalist.lookupCode);
    const row = page.locator("[data-replacement-results] button").first();
    // The finalist's context names the Final, not a stale round-one heat.
    await expect(row).toContainText(`Final · Heat ${heat.number}`);
    await row.click();
    await expect(page.locator("[data-replacement-readback]"))
      .toContainText(`Replace Duck #${oldNumber} with Duck #${spare.visibleNumber}`);

    const replaced = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/staff/ducks/${spare.tagToken}/replacements`)
      && response.request().method() === "POST"
    );
    await page.locator("[data-confirm-replacement]").click();
    await confirmAction(page, `Replace Duck #${oldNumber}`);
    const result = await (await replaced).json();
    expect(result.heat.round).toBe("FINAL");
    expect(result.previousDuck.visibleNumber).toBe(oldNumber);

    // Advancement and the final slot followed the participant.
    const after = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`,
      { token: admin.token },
    );
    expect(after.status).toBe(200);
    expect(after.body.roster.map((item) => item.raceEntryId))
      .toEqual(roster.map((item) => item.raceEntryId));
    expect(after.body.roster.map((item) => item.slotNumber))
      .toEqual(roster.map((item) => item.slotNumber));
    expect(after.body.roster[0].duck.visibleNumber).toBe(spare.visibleNumber);

    const newTag = await rawJson(`/api/v1/staff/ducks/${spare.tagToken}`, { token: admin.token });
    expect(newTag.body.assignment.raceEntryId).toBe(entry.raceEntryId);
    const oldTag = await rawJson(`/api/v1/staff/ducks/${finalist.tagToken}`, { token: admin.token });
    expect(oldTag.body.assignment).toBeNull();

    expect(errors).toEqual([]);
  });

  // A duck that is already racing would strand its own participant, so the
  // station must never offer it as replacement material in the first place.
  test("never offers the flow for a duck that is already racing", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { entry } = await rosterTarget(
      admin.token,
      seeded.eventId,
      (candidate) => candidate.status === "RUNNING",
    );
    const racer = participantFor(seeded, entry);

    await signIn(page, admin.email, `/staff/ducks/${racer.tagToken}`);

    // Scanning a paired duck is an inspection, not a replacement opportunity.
    await expect(page.locator("[data-staff-title]"))
      .toHaveText(`Inspect Duck #${racer.visibleNumber}`);
    await expect(panel(page)).toBeHidden();
    await expect(page.locator("[data-confirm-replacement]")).toBeHidden();

    expect(errors).toEqual([]);
  });

  // A staffer can sit on a selected participant while somebody else repairs
  // that same pairing from another device. The browser is then holding an
  // assignment that is no longer open, and the one thing it must never do is
  // move a duck anyway. The station holds the selection deliberately — the live
  // refresh is blocked while a replacement is staged — so the server is what
  // fails this closed, and the screen has to say so.
  test("fails closed when the selected pairing changed out from under the browser", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const scanned = await intakeDuck(client, seeded.eventId, 703);
    const claimed = await intakeDuck(client, seeded.eventId, 704);

    const { heat, roster, entry } = await rosterTarget(
      admin.token,
      seeded.eventId,
      (candidate) => candidate.status === "RUNNING",
    );
    const racer = participantFor(seeded, entry);
    const oldNumber = racer.visibleNumber;

    await signIn(page, admin.email, `/staff/ducks/${scanned.tagToken}`);
    await expect(panel(page)).toBeVisible();

    // Selecting the participant is what captures their currently open
    // assignment into the browser.
    await findRacingParticipant(page, racer.lookupCode);
    await page.locator("[data-replacement-results] button").first().click();
    await expect(page.locator("[data-replacement-readback]")).toBeVisible();

    // Meanwhile the same pairing is replaced onto a different spare, which
    // closes the assignment this browser is still holding.
    const held = await rawJson(`/api/v1/staff/ducks/${racer.tagToken}`, { token: admin.token });
    expect(held.status).toBe(200);
    const elsewhere = await rawJson(`/api/v1/staff/ducks/${claimed.tagToken}/replacements`, {
      token: admin.token,
      method: "POST",
      body: {
        commandId: crypto.randomUUID(),
        eventId: seeded.eventId,
        raceEntryId: entry.raceEntryId,
        currentAssignmentId: held.body.assignment.id,
      },
    });
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);

    const refused = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/staff/ducks/${scanned.tagToken}/replacements`)
      && response.request().method() === "POST"
    );
    await page.locator("[data-confirm-replacement]").click();
    // The readback still names the duck the browser captured, so this is the
    // stale material being confirmed.
    await confirmAction(page, `Replace Duck #${oldNumber}`);
    expect((await refused).status()).toBe(409);

    await expect(page.locator("[data-staff-message]"))
      .toHaveText("That participant's pairing has changed. Refresh and scan again.");
    // No false success: the heading never claims a replacement happened.
    await expect(page.locator("[data-staff-title]")).not.toContainText("replaced");
    await expect(panel(page)).toBeVisible();

    // Nothing partial landed. The out-of-band replacement still owns the
    // pairing, and the duck this browser scanned never entered the race.
    const winner = await rawJson(`/api/v1/staff/ducks/${claimed.tagToken}`, { token: admin.token });
    expect(winner.body.assignment.raceEntryId).toBe(entry.raceEntryId);
    expect(winner.body.assignment.active).toBe(true);
    const untouched = await rawJson(`/api/v1/staff/ducks/${scanned.tagToken}`, { token: admin.token });
    expect(untouched.body.assignment).toBeNull();

    // The started roster kept the same racers in the same slots throughout.
    const after = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`,
      { token: admin.token },
    );
    expect(after.body.roster.map((item) => item.raceEntryId))
      .toEqual(roster.map((item) => item.raceEntryId));
    expect(after.body.roster.map((item) => item.slotNumber))
      .toEqual(roster.map((item) => item.slotNumber));

    // The refusal is the only thing the console may have seen. A rejected
    // request logs a failed-resource line for its status; anything else,
    // including any page error, is a real defect.
    expect(errors.filter((line) => !line.includes("409"))).toEqual([]);
  });
});
