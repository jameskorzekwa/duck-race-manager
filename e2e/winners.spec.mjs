import { expect, test } from "@playwright/test";

import {
  bootstrap,
  changeRegistrationStatus,
  expectNoDocumentOverflow,
  finalizeHeat,
  rawJson,
  seedState,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

// The public finale. `/race` used to end in a heading called "Official podium"
// above three ordinary rows; it is now a "Winners" section that names a gold,
// silver, and bronze medal against the places the finish line actually
// published.
//
// Every assertion here reads the authoritative `/api/v1/race-board` projection
// for the order and the identities, so the rendered finale is checked against
// the server rather than against a second hand-written expectation that could
// drift with it.

// Seeds the default nine-racer race, runs the final, and publishes `places`
// finishing places. Returns the roster it published from so a spec can name the
// racer it withdrew. Nothing here writes SQL: a state the application refuses
// fails inside these helpers rather than being faked into existence.
const publishFinal = async ({ withdrawSecond = false } = {}) => {
  const seeded = await seedState("final");
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const { client } = await bootstrap();

  const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
  const finalHeat = listed.body.heats.find((heat) => heat.round === "FINAL");
  expect(finalHeat, "the final seed leaves one final heat").toBeTruthy();
  const detail = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`, {
    token: admin.token,
  });
  const roster = detail.body.roster;
  expect(roster).toHaveLength(3);

  const heat = { ...finalHeat, ...detail.body.heat };
  await transitionHeat(client, seeded.eventId, heat, "start");
  await transitionHeat(client, seeded.eventId, heat, "finish");

  if (withdrawSecond) {
    // A finalist leaves before the result is taken. Their duck stays in its bag
    // and still floats past the line, but it can never take a place, so the
    // final publishes two places instead of three.
    const leaving = seeded.participants.find((participant) =>
      participant.visibleNumber === roster[1].duck.visibleNumber
    );
    expect(leaving).toBeTruthy();
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");
    await finalizeHeat(client, seeded.eventId, heat, [
      { raceEntryId: roster[0].raceEntryId, place: 1 },
      { raceEntryId: roster[2].raceEntryId, place: 2 },
    ]);
  } else {
    await finalizeHeat(client, seeded.eventId, heat, [
      { raceEntryId: roster[0].raceEntryId, place: 1 },
      { raceEntryId: roster[1].raceEntryId, place: 2 },
      { raceEntryId: roster[2].raceEntryId, place: 3 },
    ]);
  }

  const board = await rawJson("/api/v1/race-board");
  expect(board.status).toBe(200);
  return { podium: board.body.event.podium, roster, seeded };
};

test.describe("the public Winners finale", () => {
  test("renames the podium to Winners and maps gold, silver, and bronze to the published places", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    const { podium } = await publishFinal();
    expect(podium.map((entry) => entry.place)).toEqual([1, 2, 3]);

    await page.goto("/race");

    // The renamed title, and no trace of the wording it replaced.
    await expect(page.getByRole("heading", { name: "Winners" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Official podium" })).toHaveCount(0);

    const places = page.locator(".winners .podium-place");
    await expect(places).toHaveCount(3);

    // The medal is named in words next to an ordinal place, so the rank is
    // never carried by colour or by the medal disc alone.
    await expect(places.locator(".podium-rank")).toHaveText([
      /Gold medal · 1st place/i,
      /Silver medal · 2nd place/i,
      /Bronze medal · 3rd place/i,
    ]);
    await expect(places.nth(0)).toHaveClass(/podium-gold/);
    await expect(places.nth(1)).toHaveClass(/podium-silver/);
    await expect(places.nth(2)).toHaveClass(/podium-bronze/);

    // Reading order is finishing order, and both agree with the authoritative
    // projection rather than with a second expectation written out by hand.
    await expect(places.locator(".podium-name")).toHaveText(
      podium.map((entry) => entry.participantDisplayName),
    );
    for (const [index, entry] of podium.entries()) {
      await expect(places.nth(index).locator(".podium-duck")).toContainText(`Duck #${entry.duckNumber}`);
    }

    // The rank numeral is decorative: it repeats a rank already spelled out.
    await expect(places.nth(0).locator(".podium-medal")).toHaveAttribute("aria-hidden", "true");

    // The public finale stays a public projection.
    const board = await rawJson("/api/v1/race-board");
    expect(JSON.stringify(board.body)).not.toMatch(/lookupCode|privateToken|tagToken|@example\.test/);
    await expect(page.locator("main")).not.toContainText("@example.test");

    expect(errors).toEqual([]);
  });

  test("shows only the places that exist and never invents a winner", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    const { podium } = await publishFinal({ withdrawSecond: true });
    expect(podium.map((entry) => entry.place)).toEqual([1, 2]);

    await page.goto("/race");
    await expect(page.getByRole("heading", { name: "Winners" })).toBeVisible();

    const places = page.locator(".winners .podium-place");
    await expect(places).toHaveCount(2);
    await expect(places.locator(".podium-rank")).toHaveText([
      /Gold medal · 1st place/i,
      /Silver medal · 2nd place/i,
    ]);
    // No bronze step is drawn for a place nobody took, and no third racer is
    // promoted into it.
    await expect(page.locator(".winners .podium-bronze")).toHaveCount(0);
    await expect(page.locator(".winners")).not.toContainText("Bronze");
    await expect(places.locator(".podium-name")).toHaveText(
      podium.map((entry) => entry.participantDisplayName),
    );

    expect(errors).toEqual([]);
  });

  test("stays readable across widths, honours reduced motion, and keeps useful content without JavaScript", async ({ browser, page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    const { podium } = await publishFinal();

    await page.goto("/race");
    const places = page.locator(".winners .podium-place");
    await expect(places).toHaveCount(3);

    // Every supported width keeps all three winners readable and the document
    // free of horizontal overflow, narrow phone included.
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoDocumentOverflow(page);
      await expect(places).toHaveCount(3);
      await expect(places.nth(0).locator(".podium-name")).toBeVisible();
      await expect(places.nth(0).locator(".podium-rank")).toContainText(/Gold medal/i);
    }

    // The celebration is decorative and gated. With motion allowed the gold
    // medal animates; with reduced motion requested it does not run at all,
    // while the winners themselves read exactly the same either way.
    const animationName = async (context) => {
      const view = await context.newPage();
      await view.goto("/race");
      const medal = view.locator(".winners .podium-gold .podium-medal");
      await expect(medal).toBeVisible();
      await expect(view.locator(".winners .podium-place")).toHaveCount(3);
      await expect(view.locator(".winners .podium-rank").first()).toContainText(/Gold medal · 1st place/i);
      const name = await medal.evaluate((node) => getComputedStyle(node).animationName);
      await context.close();
      return name;
    };

    const motion = await browser.newContext({ reducedMotion: "no-preference" });
    expect(await animationName(motion)).toBe("winner-medal-glow");
    const reduced = await browser.newContext({ reducedMotion: "reduce" });
    expect(await animationName(reduced)).toBe("none");

    // The Worker paints the same authoritative public projection into the
    // document before the live client starts. With scripting off, real winner
    // information therefore remains available rather than collapsing into an
    // instruction to enable JavaScript. The noscript note is inert while
    // scripting is on.
    await expect(page.locator("[data-live-board-noscript]")).toHaveCount(0);
    const scriptless = await browser.newContext({ javaScriptEnabled: false });
    const quiet = await scriptless.newPage();
    await quiet.goto("/race");
    await expect(quiet.getByRole("heading", { name: "Winners" })).toBeVisible();
    const fallbackPlaces = quiet.locator(".winners .podium-place");
    await expect(fallbackPlaces).toHaveCount(3);
    await expect(fallbackPlaces.locator(".podium-rank")).toHaveText([
      /Gold medal · 1st place/i,
      /Silver medal · 2nd place/i,
      /Bronze medal · 3rd place/i,
    ]);
    await expect(fallbackPlaces.locator(".podium-name")).toHaveText(
      podium.map((entry) => entry.participantDisplayName),
    );
    for (const [index, entry] of podium.entries()) {
      await expect(fallbackPlaces.nth(index).locator(".podium-duck"))
        .toContainText(`Duck #${entry.duckNumber}`);
    }
    await expect(quiet.locator("[data-live-board-noscript]"))
      .toContainText("these Winners are the current official results");
    await scriptless.close();

    expect(podium).toHaveLength(3);
    expect(errors).toEqual([]);
  });
});
