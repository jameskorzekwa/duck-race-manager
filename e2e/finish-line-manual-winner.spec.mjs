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

// The finish line's prominent winner workflow and its last-resort fallback.
//
// The normal way to record a round-one winner is to scan that duck's permanent
// NFC tag, which opens its inspection page. This spec covers the two things that
// used to be missing at the water's edge: the instruction being prominent enough
// to act on, and there being any way at all to finish the heat when the winning
// duck's tag simply will not scan.
//
// The fallback is deliberately checked for what it refuses as well as what it
// records. It may only ever offer this heat's own eligible racers, and it has to
// stop offering a racer who leaves while it is on screen — without a reload,
// because nobody reloads a station with a crowd waiting.

const callout = (page) => page.locator("[data-finish-callout]");
const fallback = (page) => page.locator("[data-finish-manual]");
const fallbackSelect = (page) => page.locator("[data-finish-manual-select]");
const recorded = (page) => page.locator("[data-finish-recorded]");

const WINNER_SCAN_INSTRUCTION = "Heat finished. Scan the winning duck's permanent NFC tag"
  + " to open its inspection page and select it as the winner.";
const FINALISTS_BAG_INSTRUCTION = "Then put the winning duck in the finalists bag.";

test.describe("the finish-line winner workflow", () => {
  test("leads with the NFC instruction and the finalists bag, and keeps the fallback a last resort", async ({ page }) => {
    const errors = watchBrowserErrors(page);
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
    expect(roster.length).toBeGreaterThanOrEqual(3);

    await signIn(page, resultTaker.email, "/staff/finish-line");

    // While the heat is still on the water there is no winner to record, so the
    // callout must not be telling anybody to go and scan one yet.
    await expect(callout(page)).toBeHidden();

    await page.getByRole("button", { name: "Mark heat finished" }).click();

    // The primary instruction, verbatim, and prominent enough to be its own
    // region rather than a line that the next scan overwrites.
    await expect(callout(page)).toBeVisible({ timeout: 20_000 });
    await expect(callout(page)).toContainText(WINNER_SCAN_INSTRUCTION);
    // The bag reminder rides in the same block, because that is the step that
    // gets forgotten.
    await expect(callout(page)).toContainText(FINALISTS_BAG_INSTRUCTION);
    // The primary instruction names one technology. A QR tag still resolves to
    // the same page; it is simply not what this sentence offers.
    await expect(callout(page).locator("strong").first()).not.toContainText("QR");

    // The fallback is inside the same workflow and says what it is for.
    await expect(fallback(page)).toBeVisible();
    await expect(fallback(page)).toContainText("Last resort");
    await expect(fallback(page)).toContainText("only when that duck's tag cannot be scanned");

    // It offers this heat's eligible racers and nobody else.
    const options = fallbackSelect(page).locator("option");
    await expect(options).toHaveCount(roster.length + 1);
    for (const entry of roster) {
      await expect(options.filter({ hasText: `Duck #${entry.duck.visibleNumber}` })).toHaveCount(1);
    }

    // A duck racing in a different heat is never selectable here.
    const otherHeat = listed.body.heats.find((heat) => heat.id !== running.id && heat.round === "ROUND_ONE");
    expect(otherHeat).toBeTruthy();
    const otherDetail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${otherHeat.id}`, {
      token: admin.token,
    });
    for (const outsider of otherDetail.body.roster) {
      await expect(options.filter({ hasText: `Duck #${outsider.duck.visibleNumber}` })).toHaveCount(0);
    }

    // A racer who leaves while the selector is open drops out of it, with no
    // reload: the duck is still in the bag and still on the water, but it can no
    // longer be recorded as the winner.
    const leavingEntry = roster[roster.length - 1];
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === leavingEntry.duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");
    await expect(options).toHaveCount(roster.length, { timeout: 20_000 });
    await expect(options.filter({ hasText: `Duck #${leavingEntry.duck.visibleNumber}` })).toHaveCount(0);
    // The roster itself still shows them, marked rather than dropped.
    await expect(page.locator("[data-station-roster] li")).toHaveCount(roster.length);

    // Recording the winner the fallback does offer publishes the real result.
    const winnerEntry = roster[0];
    await fallbackSelect(page).selectOption(winnerEntry.raceEntryId);
    await page.getByRole("button", { name: "Record selected duck as winner" }).click();
    await confirmAction(page, "Record winner");

    // The same acknowledgement a scanned winner lands on, including the bag.
    await expect(recorded(page)).toBeVisible({ timeout: 20_000 });
    await expect(recorded(page)).toContainText(
      `Duck #${winnerEntry.duck.visibleNumber} is the official Heat ${running.number} winner.`,
    );
    await expect(recorded(page)).toContainText(FINALISTS_BAG_INSTRUCTION);
    // The heat is settled, so the workflow that asked for a winner is gone.
    await expect(callout(page)).toBeHidden();

    const published = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(published.body.heat.status).toBe("FINALIZED");
    expect(published.body.results.map((result) => result.place)).toEqual([1]);
    expect(published.body.results[0].raceEntryId).toBe(winnerEntry.raceEntryId);
    // Nothing was moved around the racer who left.
    expect(published.body.roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`))
      .toEqual(roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`));

    expect(errors).toEqual([]);
  });

  // Whoever is standing at the water's edge when a heat ends is the only person
  // who saw which duck arrived first, and that is not reliably the one staffer
  // holding RESULT_TAKER. So the station opens for every operational role and
  // the command behind the button accepts them, rather than sending a heat
  // runner off to find somebody else with the next heat already forming up.
  test("lets a heat runner record a winner manually, station and command alike", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const heatRunner = accountWith(seeded.accounts, "HEAT_RUNNER");

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });

    // The station opens, and its own first button works for this role: marking
    // the heat finished is the first step of taking the result.
    await signIn(page, heatRunner.email, "/staff/finish-line");
    await page.getByRole("button", { name: "Mark heat finished" }).click();

    // The finished-heat workflow is the same one a result taker gets, fallback
    // and all.
    await expect(callout(page)).toBeVisible({ timeout: 20_000 });
    await expect(callout(page)).toContainText(WINNER_SCAN_INSTRUCTION);
    await expect(fallback(page)).toBeVisible();
    await expect(fallback(page)).toContainText("Last resort");

    const winnerEntry = detail.body.roster[0];
    await fallbackSelect(page).selectOption(winnerEntry.raceEntryId);
    // Asserted on its own, because this is the paint that used to hand over a
    // dead button. Marking the heat finished repaints the station while its own
    // command is still in flight, so the fallback is built disabled; nothing
    // else happens in this test to force a second repaint, so the control has to
    // be armed when the command releases rather than by the next unrelated
    // change. Without the assertion the failure reads as a click timeout.
    const record = page.getByRole("button", { name: "Record selected duck as winner" });
    await expect(record).toBeEnabled();
    await record.click();
    await confirmAction(page, "Record winner");

    await expect(recorded(page)).toBeVisible({ timeout: 20_000 });
    await expect(recorded(page)).toContainText(
      `Duck #${winnerEntry.duck.visibleNumber} is the official Heat ${running.number} winner.`,
    );

    // The result a heat runner published is a real, official one: same status,
    // same single place, same duck.
    const published = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(published.body.heat.status).toBe("FINALIZED");
    expect(published.body.results.map((result) => result.place)).toEqual([1]);
    expect(published.body.results[0].raceEntryId).toBe(winnerEntry.raceEntryId);

    expect(errors).toEqual([]);
  });

  // Widening who may record a winner did not widen anything else. Undoing an
  // official result is still a race director's decision, and a staff account
  // with no operational role at all is still nobody.
  test("does not let recording a winner become permission to undo one", async () => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const heatRunner = accountWith(seeded.accounts, "HEAT_RUNNER");
    const { client } = await bootstrap();

    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    await transitionHeat(client, seeded.eventId, { ...running, ...detail.body.heat }, "finish");

    const finished = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    const recordedWinner = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/results/finalize`,
      {
        token: heatRunner.token,
        method: "POST",
        body: {
          commandId: crypto.randomUUID(),
          revision: finished.body.heat.revision,
          results: [{ raceEntryId: detail.body.roster[0].raceEntryId, place: 1 }],
        },
      },
    );
    // The point here is that this role is not refused, so the assertion is on
    // acceptance rather than on which success code the result path returns; the
    // authoritative heat state below is what proves the winner was published.
    expect(recordedWinner.status, JSON.stringify(recordedWinner.body)).toBeLessThan(300);

    // Reopening it is not the same decision, and this role does not have it.
    const settled = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    const refusedReopen = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/results/reopen`,
      {
        token: heatRunner.token,
        method: "POST",
        body: {
          commandId: crypto.randomUUID(),
          revision: settled.body.heat.revision,
          reason: "The wrong duck was recorded as the winner.",
        },
      },
    );
    expect(refusedReopen.status).toBe(403);

    const untouched = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    expect(untouched.body.heat.status).toBe("FINALIZED");
    expect(untouched.body.results.map((result) => result.place)).toEqual([1]);
  });
});
