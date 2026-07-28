import { expect, test } from "@playwright/test";

import {
  accountWith,
  bootstrap,
  changeRegistrationStatus,
  rawJson,
  seedState,
  signIn,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

// A withdrawn or disqualified duck reaching the finish line is an expected
// race-day outcome, not an error. The duck was sealed into its heat bag before
// its racer left, nobody empties a bag on the bank, so it is still in the water
// and can cross the line first. Every finish-line surface answers the same way:
// a calm statement, nothing written, no heat entry moved, and the station stays
// armed for the very next duck.
//
// ---------------------------------------------------------------------------
// WHY THESE TWO ARE `test.fixme`
//
// Both specs need a heat that is AWAITING_RESULT and still holds a withdrawn
// racer. Today the participant status API refuses a withdrawal outright once
// any containing heat is locked, running, awaiting a result, or finalized —
// both in preflight and inside the guarded write — and starting a round refuses
// while any roster still holds an inactive racer. So the state these specs
// describe cannot currently be reached through the application at all, and
// nothing here may fake it: a spec that inserted the row directly would prove
// the projection works on data the product cannot produce.
//
// They are written against the intended behaviour and withdraw through the
// normal staff API at the point in the flow where it should be allowed. Delete
// the `.fixme` from both `test.fixme(...)` calls once the branch that removes
// the locked/running withdrawal guards from `src/participant-operations.ts` has
// merged. Nothing else in this file needs to change.
// ---------------------------------------------------------------------------

const ineligibleBlock = (page) => page.locator("[data-finish-ineligible]");

test.describe("a withdrawn duck at the finish line", () => {
  test.fixme("shows the staff inspection page a plain statement instead of a winner button", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Round one, mid-race: heat 1 is published and heat 2 is on the water.
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
    const { client } = await bootstrap();

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    expect(running, "the seeded race leaves one heat running").toBeTruthy();
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });

    // The race physically finishes and the heat waits for its official result.
    await transitionHeat(client, seeded.eventId, { ...running, ...detail.body.heat }, "finish");

    // The racer withdraws while the result is still being taken. Their duck is
    // already in the heat bag and stays in the water.
    const leaving = seeded.participants.find((participant) =>
      participant.registrationId === detail.body.roster[0].registrationId
      || participant.visibleNumber === detail.body.roster[0].duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    // The result taker scans that duck's tag and lands on its inspection page.
    await signIn(page, resultTaker.email, `/staff/ducks/${leaving.tagToken}`);
    const winnerAction = page.locator("[data-winner-action]");
    await expect(winnerAction).toBeVisible();
    await expect(winnerAction).toHaveClass(/ineligible/);
    await expect(winnerAction).toContainText(`Duck #${leaving.visibleNumber} is Withdrawn`);
    await expect(winnerAction).toContainText("this duck stays in its heat");
    await expect(winnerAction).toContainText("Scan the next duck to pass the finish line.");

    // No winner button anywhere on the page, and nothing to dismiss.
    await expect(page.getByRole("button", { name: /Mark Duck as Heat .* Winner/ })).toHaveCount(0);
    await expect(page.locator("[data-staff-message]"))
      .toContainText("Scan the next duck to pass the finish line.");

    // The heat is untouched: same roster, same slots, still awaiting a result.
    const after = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(after.body.heat.status).toBe("AWAITING_RESULT");
    expect(after.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(detail.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    expect(errors).toEqual([]);
  });

  test.fixme("leaves the finish station armed for the very next duck", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // The final is the round whose station takes scans directly, because it
    // needs a complete podium rather than one scanned winner.
    const seeded = await seedState("final");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
    const { client } = await bootstrap();

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const finalHeat = listed.body.heats.find((heat) => heat.round === "FINAL");
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`, {
      token: admin.token,
    });
    const heat = { ...finalHeat, ...detail.body.heat };
    await transitionHeat(client, seeded.eventId, heat, "start");
    await transitionHeat(client, seeded.eventId, heat, "finish");

    const roster = detail.body.roster;
    expect(roster.length).toBeGreaterThanOrEqual(2);
    const withdrawnEntry = roster[0];
    const eligibleEntry = roster[1];
    const withdrawn = seeded.participants.find((participant) =>
      participant.visibleNumber === withdrawnEntry.duck.visibleNumber
    );
    expect(withdrawn).toBeTruthy();
    await changeRegistrationStatus(admin.token, withdrawn.registrationId, "withdraw");

    await signIn(page, resultTaker.email, "/staff/finish-line");
    const scanForm = page.locator("[data-finish-scan-form]");
    await expect(scanForm).toBeVisible();
    await expect(ineligibleBlock(page)).toBeHidden();

    // Scanning the withdrawn duck states the outcome and writes nothing.
    await page.getByLabel("Tag URL or duck number").fill(String(withdrawnEntry.duck.visibleNumber));
    await page.getByRole("button", { name: "Add this duck" }).click();
    await expect(ineligibleBlock(page)).toBeVisible();
    await expect(ineligibleBlock(page))
      .toContainText(`Duck #${withdrawnEntry.duck.visibleNumber} is Withdrawn`);
    await expect(ineligibleBlock(page)).toContainText("Scan the next duck to pass the finish line.");
    await expect(page.locator("[data-finish-selections] .station-selection")).toHaveCount(0);

    // Still armed: the heat, the scan field, and the NFC button are untouched,
    // and nothing has to be dismissed first.
    await expect(scanForm).toBeVisible();
    await expect(page.getByLabel("Tag URL or duck number")).toBeEnabled();
    await expect(page.locator("[data-start-nfc]")).toBeEnabled();
    await expect(page.locator("[data-station-heat]")).toContainText(`Heat ${heat.number}`);

    // The very next scan, with no intervening action at all, selects normally
    // and clears the statement.
    await page.getByLabel("Tag URL or duck number").fill(String(eligibleEntry.duck.visibleNumber));
    await page.getByRole("button", { name: "Add this duck" }).click();
    await expect(page.locator("[data-finish-selections] .station-selection")).toHaveCount(1);
    await expect(page.locator("[data-finish-selections]"))
      .toContainText(`Duck #${eligibleEntry.duck.visibleNumber}`);
    await expect(ineligibleBlock(page)).toBeHidden();

    // No heat entry was removed, reordered, renumbered, or rebalanced by any of
    // it: the withdrawn duck keeps its heat and its slot.
    const after = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`, {
      token: admin.token,
    });
    expect(after.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    expect(errors).toEqual([]);
  });
});
