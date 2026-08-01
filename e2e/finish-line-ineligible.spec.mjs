import { expect, test } from "@playwright/test";

import {
  accountWith,
  bootstrap,
  changeRegistrationStatus,
  confirmAction,
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
// Both specs reach that state the only honest way: they withdraw through the
// normal staff API while the heat is already awaiting its result. Withdrawal and
// disqualification are allowed at every heat state now, so nothing here inserts
// a row or fakes a projection.

const ineligibleBlock = (page) => page.locator("[data-finish-ineligible]");

test.describe("a withdrawn duck at the finish line", () => {
  test("shows the staff inspection page a plain statement instead of a winner button", async ({ page }) => {
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

  test("leaves the finish station armed for the very next duck", async ({ page }) => {
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

    // No page error and no application error — and exactly one line, which is
    // Chromium's own network log for the deliberate `422` the finish-scan
    // lookup answers with (`reason: DUCK_NOT_ELIGIBLE`, documented in
    // docs/WORKFLOWS.md). The browser writes that at the network layer for any
    // non-2xx fetch and page script cannot suppress it, so it is listed exactly
    // rather than filtered away — the same convention ui-consistency.spec.mjs
    // uses. Any second entry, or a real `pageerror`, still fails this spec.
    expect(errors).toEqual([
      "console: Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)",
    ]);
  });

  // The blocker this covers. The server sizes the final podium by the finalists
  // who can still take a place, so a withdrawal makes it two deep. A station
  // that keeps demanding three places can never be satisfied — the third duck
  // answers every scan with DUCK_NOT_ELIGIBLE — Submit stays disabled forever,
  // and with no podium the event can never be completed. Walking up to "one duck
  // selected" is exactly what let this through, so this test publishes the
  // reduced podium through the station and completes the race.
  test("publishes a podium reduced by a withdrawal and completes the race", async ({ browser, page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    // The default seed: nine racers, three per heat, exactly three finalists.
    const seeded = await seedState("final");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
    const { client } = await bootstrap();

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const finalHeat = listed.body.heats.find((heat) => heat.round === "FINAL");
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`, {
      token: admin.token,
    });
    const roster = detail.body.roster;
    expect(roster).toHaveLength(3);
    const heat = { ...finalHeat, ...detail.body.heat };
    await transitionHeat(client, seeded.eventId, heat, "start");
    await transitionHeat(client, seeded.eventId, heat, "finish");

    await signIn(page, resultTaker.email, "/staff/finish-line");
    const requiredResult = page.locator("[data-station-facts] .fact").filter({ hasText: "Required result" });
    await expect(requiredResult).toContainText("3 podium places");

    // A finalist leaves while the station is open and the final is awaiting its
    // result. Nothing about the heat changes — same id, same status, same
    // revision — so only the roster's eligibility can trigger the repaint.
    const leavingEntry = roster[1];
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === leavingEntry.duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    // No reload: the podium shrinks and the racer is marked on the very roster
    // the staffer reads to decide who won.
    await expect(requiredResult).toContainText("2 podium places", { timeout: 20_000 });
    const leavingRow = page.locator("[data-station-roster] li")
      .filter({ hasText: `Duck #${leaving.visibleNumber}` });
    await expect(leavingRow.locator(".roster-flag")).toHaveText("Cannot win · Withdrawn");
    await expect(leavingRow.locator(".roster-flag-note")).toHaveText(
      "The duck stays in its heat bag and still races, but cannot be recorded as a winner.",
    );
    // Marked, never dropped: the duck is still in the bag and still in the water.
    await expect(page.locator("[data-station-roster] li")).toHaveCount(3);
    await expect(page.locator("[data-station-message]")).toContainText("select 2 distinct ducks here");

    // Two scans fill the whole podium, and Submit arms — which it never would
    // while the station demanded a third, unfillable place.
    const remaining = [roster[0], roster[2]];
    for (const entry of remaining) {
      await page.getByLabel("Tag URL or duck number").fill(String(entry.duck.visibleNumber));
      await page.getByRole("button", { name: "Add this duck" }).click();
    }
    await expect(page.locator("[data-finish-selections] .station-selection")).toHaveCount(2);
    const submit = page.getByRole("button", { name: "Submit official podium" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await confirmAction(page);
    await expect(page.locator("[data-station-message]")).toContainText("Official result saved");

    const published = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`, {
      token: admin.token,
    });
    expect(published.body.heat.status).toBe("FINALIZED");
    expect(published.body.results.map((result) => result.place)).toEqual([1, 2]);
    // No heat entry moved around the racer who left.
    expect(published.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    // And the event is not stranded: it completes from the console and the
    // public podium is two deep, without the racer who left. The Admin console
    // is administrator-only, and a result taker's `/staff` lands on their own
    // station, so this is a separate signed-in browser rather than the same one.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, admin.email, "/staff");
    await adminPage.getByRole("button", { name: "Complete event", exact: true }).click();
    await confirmAction(adminPage);
    await expect(adminPage.getByText("Completed", { exact: true }).first()).toBeVisible();
    await adminContext.close();

    await page.goto("/race");
    await expect(page.getByRole("heading", { name: "Winners" })).toBeVisible();
    await expect(page.getByText("Results official", { exact: true })).toBeVisible();
    const board = await rawJson("/api/v1/race-board");
    expect(board.body.event.podium.map((entry) => entry.place)).toEqual([1, 2]);
    expect(board.body.event.podium.some((entry) => entry.duckNumber === leaving.visibleNumber)).toBe(false);

    expect(errors).toEqual([]);
  });
});

// The dead end this closes. Withdrawal is allowed at any heat state, and the
// eligible-racer guard protects only the lock and the start, so the last ACTIVE
// racer in a round-one heat can leave while that heat is already RUNNING. Round
// one publishes by scanning a tag rather than through the station form, so the
// two surfaces a result taker actually stands in front of are the finish line
// and the scanned duck's inspection page. Both used to send them to scan the
// winning duck of a heat that has no winner in it: every duck in the bag answers
// DUCK_NOT_ELIGIBLE, and nothing anywhere said why or how to get out.
test.describe("a round-one heat nobody can win", () => {
  test("tells the finish line and the scanned duck page plainly, and reactivation is the way out", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    // Round one, mid-race: heat 1 is published and heat 2 is on the water.
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    expect(running, "the seeded race leaves one heat running").toBeTruthy();
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    const roster = detail.body.roster;
    expect(roster.length).toBeGreaterThanOrEqual(2);

    // Every racer in the running heat leaves. Their ducks were sealed into the
    // heat 2 bag before any of it and are still on the water.
    const racers = roster.map((entry) => {
      const participant = seeded.participants.find((candidate) =>
        candidate.visibleNumber === entry.duck.visibleNumber
      );
      expect(participant, `no seeded participant for duck ${entry.duck.visibleNumber}`).toBeTruthy();
      return participant;
    });
    for (const racer of racers) {
      await changeRegistrationStatus(admin.token, racer.registrationId, "withdraw");
    }

    // The heat is still RUNNING, so the finish button stays — those ducks have
    // to be marked finished. What must not happen is the staffer learning only
    // afterwards, one refused scan at a time, that there is no winner to find.
    await signIn(page, resultTaker.email, "/staff/finish-line");
    const stationMessage = page.locator("[data-station-message]");
    const requiredResult = page.locator("[data-station-facts] .fact").filter({ hasText: "Required result" });
    await expect(requiredResult).toContainText("No racer can win");
    await expect(stationMessage).toContainText("When the race physically finishes, press the one finish button.");
    await expect(stationMessage).toContainText("Nobody in this heat can win");
    await expect(stationMessage).toContainText("Every duck stays in its bag.");
    await expect(stationMessage).toContainText("Ask the race director to reactivate a racer");
    // Every racer is still on the roster, marked, in their own slot.
    await expect(page.locator("[data-station-roster] li")).toHaveCount(roster.length);
    await expect(page.locator("[data-station-roster] .roster-flag").first())
      .toHaveText("Cannot win · Withdrawn");

    // The race physically finishes. The confirmation must not talk over the
    // repaint with "scan the winning duck".
    await page.getByRole("button", { name: "Mark heat finished" }).click();
    await expect(stationMessage).toContainText("Nobody in this heat can win", { timeout: 20_000 });
    await expect(stationMessage).not.toContainText("Scan the winning duck");
    await expect(stationMessage).toContainText("Ask the race director to reactivate a racer");
    await expect(requiredResult).toContainText("No racer can win");

    // The other round-one result surface: the result taker scans a duck out of
    // that bag and lands on its inspection page.
    // A permanent NFC tap enters through the canonical tag route before landing
    // on the protected inspection page.
    await page.goto(`/t/${racers[0].tagToken}`);
    await expect(page).toHaveURL(new RegExp(`/staff/ducks/${racers[0].tagToken}$`));
    const winnerAction = page.locator("[data-winner-action]");
    await expect(winnerAction).toBeVisible();
    await expect(winnerAction).toHaveClass(/ineligible/);
    await expect(winnerAction).toContainText(`Duck #${racers[0].visibleNumber} is Withdrawn`);
    await expect(winnerAction).toContainText(`Nobody in Heat ${running.number} can win`);
    await expect(winnerAction).toContainText("every duck in that bag will be refused");
    await expect(winnerAction).toContainText("Ask the race director to reactivate a racer");
    // Not the instruction that produces the loop.
    await expect(winnerAction).not.toContainText("Scan the next duck to pass the finish line.");
    await expect(page.locator("[data-staff-message]"))
      .toContainText(`Nobody in Heat ${running.number} can win.`);
    await expect(page.getByRole("button", { name: /Mark Duck as Heat .* Winner/ })).toHaveCount(0);

    // Nothing was written by any of it.
    const untouched = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(untouched.body.heat.status).toBe("AWAITING_RESULT");
    expect(untouched.body.results).toEqual([]);
    expect(untouched.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    // The remedy the message names is a real way out: a race director reactivates
    // the racer who actually crossed the line first, and the same scan now offers
    // the winner action.
    const restored = await changeRegistrationStatus(admin.token, racers[0].registrationId, "reactivate");
    expect(restored.status).toBe("ACTIVE");

    await page.reload();
    await expect(winnerAction).toContainText("Result waiting");
    const markWinner = page.getByRole("button", { name: `Mark Duck as Heat ${running.number} Winner` });
    await expect(markWinner).toBeVisible();
    await markWinner.click();
    await confirmAction(page, "Mark winner");
    // Publishing a round-one winner hands the staffer back to the station that
    // owns the rest of the heat, with the acknowledgement for what they just
    // recorded and the reminder about the finalists bag. The heat is settled, so
    // the duck page's action is gone with it.
    await expect(page).toHaveURL(/\/staff\/finish-line$/);
    const recorded = page.locator("[data-finish-recorded]");
    await expect(recorded).toBeVisible();
    await expect(recorded).toContainText(
      `Duck #${racers[0].visibleNumber} is the official Heat ${running.number} winner.`,
    );
    await expect(recorded).toContainText("Then put the winning duck in the finalists bag.");
    await expect(markWinner).toHaveCount(0);
    // The station underneath the acknowledgement has authoritatively moved off
    // the finalized heat; it is not reconstructed from the return parameters.
    await expect(page.locator("[data-station-heat]")).not.toHaveText(
      `Round one · Heat ${running.number}`,
      { timeout: 20_000 },
    );
    await expect(page.locator("[data-finish-callout]")).toBeHidden();

    const published = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(published.body.heat.status).toBe("FINALIZED");
    expect(published.body.results.map((result) => result.place)).toEqual([1]);
    // Still nothing moved around the racers who stayed out.
    expect(published.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    // And the finish line agrees: the heat it was stuck on is settled and the
    // station has moved on rather than still demanding a winner.
    await expect(page.locator("[data-station-message]")).not.toContainText("Nobody in this heat can win");

    expect(errors).toEqual([]);
  });
});
