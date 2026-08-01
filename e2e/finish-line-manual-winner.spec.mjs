import { expect, test } from "@playwright/test";

import {
  accountWith,
  bootstrap,
  changeRegistrationStatus,
  confirmAction,
  expectNoDocumentOverflow,
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
    // The labelled selector, warning association, and full touch targets remain
    // usable at the narrowest supported viewport.
    await page.setViewportSize({ width: 320, height: 700 });
    await expectNoDocumentOverflow(page);
    await expect(page.getByLabel("Winning duck")).toBeVisible();
    await expect(fallbackSelect(page)).toHaveAttribute("aria-describedby", "finish-manual-warning");
    const selectBox = await fallbackSelect(page).boundingBox();
    const actionBox = await page.getByRole("button", { name: "Record selected duck as winner" }).boundingBox();
    expect(selectBox.height).toBeGreaterThanOrEqual(63);
    expect(actionBox.height).toBeGreaterThanOrEqual(63);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectNoDocumentOverflow(page);

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
    // Even a forged DOM option cannot cross the real roster boundary. The
    // browser re-checks its authoritative paint and never opens confirmation;
    // the migrated-handler test below the browser boundary pins the same 422.
    const outsider = otherDetail.body.roster[0];
    await fallbackSelect(page).evaluate((select, entry) => {
      const option = document.createElement("option");
      option.value = entry.raceEntryId;
      option.textContent = `Duck #${entry.duck.visibleNumber}`;
      select.append(option);
      select.value = entry.raceEntryId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, outsider);
    await page.getByRole("button", { name: "Record selected duck as winner" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm action" })).toBeHidden();
    await expect(page.locator("[data-station-message]")).toContainText("can no longer be recorded as this heat's winner");
    await expect(options.filter({ hasText: `Duck #${outsider.duck.visibleNumber}` })).toHaveCount(0);

    // A racer who leaves while the selector is open drops out of it, with no
    // reload: the duck is still in the bag and still on the water, but it can no
    // longer be recorded as the winner.
    const leavingEntry = roster[roster.length - 1];
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === leavingEntry.duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    // Selecting the option is transient review state, not an edit that may block
    // authoritative refresh for five minutes.
    await fallbackSelect(page).selectOption(leavingEntry.raceEntryId);
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");
    await expect(options).toHaveCount(roster.length, { timeout: 20_000 });
    await expect(options.filter({ hasText: `Duck #${leavingEntry.duck.visibleNumber}` })).toHaveCount(0);
    await expect(fallbackSelect(page)).toHaveValue("");
    // The roster itself still shows them, marked rather than dropped.
    await expect(page.locator("[data-station-roster] li")).toHaveCount(roster.length);

    // Deactivation/disqualification is the same eligibility boundary and also
    // removes an option without a page reload.
    const disqualifiedEntry = roster[1];
    const disqualified = seeded.participants.find((participant) =>
      participant.visibleNumber === disqualifiedEntry.duck.visibleNumber
    );
    expect(disqualified).toBeTruthy();
    await changeRegistrationStatus(admin.token, disqualified.registrationId, "disqualify");
    await expect(options.filter({ hasText: `Duck #${disqualifiedEntry.duck.visibleNumber}` })).toHaveCount(0, {
      timeout: 20_000,
    });

    // Recording the winner the fallback does offer publishes the real result.
    const winnerEntry = roster[0];
    await fallbackSelect(page).selectOption(winnerEntry.raceEntryId);
    // Marking the heat finished repaints while its command is still busy. The
    // newly introduced fallback must be re-armed when that command releases.
    const manualAction = page.getByRole("button", { name: "Record selected duck as winner" });
    await expect(manualAction).toBeEnabled();
    await manualAction.click();
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

  test("keeps a conflicted scanned winner on its inspection page without false success", async ({ page }) => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
    const { client } = await bootstrap();
    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    await transitionHeat(client, seeded.eventId, { ...running, ...detail.body.heat }, "finish");
    const awaiting = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, {
      token: admin.token,
    });
    const winnerEntry = detail.body.roster[0];
    const winner = seeded.participants.find((participant) =>
      participant.visibleNumber === winnerEntry.duck.visibleNumber
    );
    expect(winner).toBeTruthy();

    await signIn(page, resultTaker.email, "/staff/finish-line");
    // Enter through the canonical permanent tag URL, as an NFC tap does.
    await page.goto(`/t/${winner.tagToken}`);
    await expect(page).toHaveURL(new RegExp(`/staff/ducks/${winner.tagToken}$`));
    const markWinner = page.getByRole("button", { name: `Mark Duck as Heat ${running.number} Winner` });
    await expect(markWinner).toBeVisible();

    // Settle the heat after the inspection action was painted but before its
    // request reaches the Worker. The stale scanned command must then conflict.
    let settled = false;
    await page.route("**/api/v1/staff/ducks/*/heat-winner", async (route) => {
      if (!settled) {
        settled = true;
        const otherWinner = await rawJson(
          `/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/results/finalize`,
          {
            token: admin.token,
            method: "POST",
            body: {
              commandId: crypto.randomUUID(),
              revision: awaiting.body.heat.revision,
              results: [{ raceEntryId: winnerEntry.raceEntryId, place: 1 }],
            },
          },
        );
        expect(otherWinner.status, JSON.stringify(otherWinner.body)).toBe(201);
      }
      await route.continue();
    });
    await markWinner.click();
    await confirmAction(page, "Mark winner");

    await expect(page).toHaveURL(new RegExp(`/staff/ducks/${winner.tagToken}$`));
    await expect(page.locator("[data-staff-message]")).toContainText("not the current winner candidate");
    await expect(page.locator("[data-staff-message]")).toContainText("Refresh this inspection page");
    await expect(page.locator("[data-staff-message]")).not.toContainText("Official winner saved");
    await expect(page.locator("[data-finish-recorded]")).toHaveCount(0);
  });

  test("does not trust a hand-edited winner acknowledgement", async ({ page }) => {
    const seeded = await seedState("round-one");
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
    await signIn(page, resultTaker.email, "/staff/finish-line");
    await page.goto("/staff/finish-line?recorded=heat-winner&duck=1&heat=1&event=fake&heatId=fake&raceEntry=fake");
    await expect(page).toHaveURL(/\/staff\/finish-line$/);
    await expect(recorded(page)).toBeHidden();
  });

  // Recording a winner does not grant permission to undo one. Reopening an
  // official result is still a race director's decision.
  test("does not let recording a winner become permission to undo one", async () => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const resultTaker = accountWith(seeded.accounts, "RESULT_TAKER");
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
        token: resultTaker.token,
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
        token: resultTaker.token,
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
