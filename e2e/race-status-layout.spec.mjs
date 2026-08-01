import { expect, test } from "@playwright/test";

import {
  bootstrap,
  expectAlignedBoardRows,
  expectNoDocumentOverflow,
  finalizeHeat,
  rawJson,
  seedState,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

// The rounds the public board publishes right now, in the order issue #106
// requires them to be read: the Final first whenever one exists, then Round one.
//
// This is derived from the authoritative board API rather than assumed, because
// the Final heat is not created by `start-final`. It already exists while Round
// one is running and collects each heat winner through `WINNER_PROMOTION` as
// that heat is finalized, so `/race` legitimately shows a Final section before
// the final is ever called.
const publishedRounds = async () => {
  const board = await rawJson("/api/v1/race-board");
  expect(board.status).toBe(200);
  const event = board.body.event;
  const rounds = [];
  if (event.finalHeats.length > 0) rounds.push("FINAL");
  if (event.roundOneHeats.length > 0) rounds.push("ROUND_ONE");
  return { event, rounds };
};

const expectRoundOrder = async (roundSections, rounds) => {
  await expect(roundSections).toHaveCount(rounds.length);
  for (const [index, round] of rounds.entries()) {
    await expect(roundSections.nth(index)).toHaveAttribute("data-board-round", round);
  }
};

const waitForBoard = (page, predicate) => page.waitForResponse(async (response) => {
  const url = new URL(response.url());
  if (
    response.request().method() !== "GET"
    || url.pathname !== "/api/v1/race-board"
    || response.status() !== 200
  ) return false;
  const board = await response.json().catch(() => null);
  return predicate(board);
}, { timeout: 4_500 });

const finishRoundOneHeat = async (client, eventId, heat) => {
  const detail = (await client.get(`/api/v1/staff/events/${eventId}/heats/${heat.id}`)).body;
  Object.assign(heat, detail.heat);
  if (heat.status === "PLANNED" || heat.status === "LOADING") await transitionHeat(client, eventId, heat, "ready");
  if (heat.status === "READY") await transitionHeat(client, eventId, heat, "call");
  if (heat.status === "CALLING") await transitionHeat(client, eventId, heat, "start");
  if (heat.status === "RUNNING") await transitionHeat(client, eventId, heat, "finish");
  if (heat.status !== "AWAITING_RESULT") throw new Error(`Heat ${heat.number} cannot be finalized from ${heat.status}.`);
  await finalizeHeat(client, eventId, heat, [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }]);
};

test("the live race board creates and updates the Final above deterministically ordered Round One heats", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchBrowserErrors(page);
  const seeded = await seedState("round-one");
  const { client } = await bootstrap();

  // Whatever the board publishes on the first paint, the DOM has to agree with
  // it, and a Final may never be read after the Round one heats beneath it.
  const { event: initial, rounds: initialRounds } = await publishedRounds();
  expect(initialRounds[0]).toBe("FINAL");
  expect(initial.finalHeats).toHaveLength(1);
  // How many finalists are already promoted is a race-progression detail this
  // issue must not change, so the layout assertions below track the board rather
  // than pinning a promotion schedule.
  const initialFinalists = initial.finalHeats[0].roster.length;

  await page.goto("/race");
  const content = page.locator("[data-live-board-content]");
  const roundSections = content.locator(":scope > [data-board-round]");
  await expectRoundOrder(roundSections, initialRounds);
  const originalRoundOrder = ["Round one · Heat 1", "Round one · Heat 2", "Round one · Heat 3"];
  const roundOneSection = roundSections.nth(initialRounds.indexOf("ROUND_ONE"));
  await expect(roundOneSection.getByRole("heading", { level: 4 })).toHaveText(originalRoundOrder);
  await expect(content.getByRole("heading", { level: 3 })).toHaveText(["Final", "Round one"]);
  await expect(roundSections.nth(0).getByRole("heading", { level: 4 })).toHaveText(["Final · Heat 1"]);
  await page.evaluate(() => { globalThis.__issue106Document = "same-document"; });

  const finalCard = content.locator('[data-board-heat="FINAL:1"]');
  await expect(finalCard.locator("tbody tr")).toHaveCount(initialFinalists);

  // Finishing the remaining Round one heats promotes their winners. The Final
  // above them fills in through live refresh alone, with no reload and no
  // reordering of the Round one heats underneath.
  const roundOneHeats = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`)).body.heats
    .filter((heat) => heat.round === "ROUND_ONE")
    .sort((left, right) => left.number - right.number);
  for (const heat of roundOneHeats) {
    if (heat.status !== "FINALIZED") await finishRoundOneHeat(client, seeded.eventId, heat);
  }

  await expectRoundOrder(roundSections, ["FINAL", "ROUND_ONE"]);
  await expect(roundSections.nth(1).getByRole("heading", { level: 4 })).toHaveText(originalRoundOrder);
  expect(await page.evaluate(() => globalThis.__issue106Document)).toBe("same-document");

  const finalUnderWay = waitForBoard(page, (board) => board?.event?.status === "FINAL");
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  });
  await finalUnderWay;

  // Every Round one winner is now a finalist, and the filled-in Final is still
  // read before Round one in the same never-reloaded document.
  await expect(finalCard.locator("tbody tr")).toHaveCount(3, { timeout: 15_000 });
  await expectRoundOrder(roundSections, ["FINAL", "ROUND_ONE"]);
  await expect(content.getByRole("heading", { level: 3 })).toHaveText(["Final", "Round one"]);
  await expect(roundSections.nth(1).getByRole("heading", { level: 4 })).toHaveText(originalRoundOrder);
  expect(await page.evaluate(() => globalThis.__issue106Document)).toBe("same-document");

  const heats = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`)).body.heats;
  const finalHeat = heats.find((heat) => heat.round === "FINAL");
  expect(finalHeat).toBeTruthy();
  const finalDetail = (await client.get(
    `/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`,
  )).body;
  Object.assign(finalHeat, finalDetail.heat);

  const finalReady = waitForBoard(page, (board) => board?.event?.finalHeats?.[0]?.status === "READY");
  await transitionHeat(client, seeded.eventId, finalHeat, "ready");
  await finalReady;
  await expect(finalCard.locator(".status-chip")).toHaveText("Ready to call");
  await expect(roundSections.nth(1).getByRole("heading", { level: 4 })).toHaveText(originalRoundOrder);

  await transitionHeat(client, seeded.eventId, finalHeat, "call");
  await transitionHeat(client, seeded.eventId, finalHeat, "start");
  await transitionHeat(client, seeded.eventId, finalHeat, "finish");
  const finalPublished = waitForBoard(page, (board) =>
    board?.event?.finalHeats?.[0]?.status === "FINALIZED"
    && board.event.finalHeats[0].roster.some((entry) => entry.place === 1));
  await finalizeHeat(
    client,
    seeded.eventId,
    finalHeat,
    finalDetail.roster.slice(0, 3).map((entry, index) => ({ raceEntryId: entry.raceEntryId, place: index + 1 })),
  );
  await finalPublished;

  // The podium is a separate section above both rounds, so it does not disturb
  // the Final-above-Round-one reading order the issue asks for.
  await expect(content.getByRole("heading", { level: 3 })).toHaveText(["Official podium", "Final", "Round one"]);
  await expectRoundOrder(roundSections, ["FINAL", "ROUND_ONE"]);
  await expect(finalCard.locator(".board-place-cell")).toHaveText(["1st place", "2nd place", "3rd place"]);
  await expect(roundSections.nth(1).getByRole("heading", { level: 4 })).toHaveText(originalRoundOrder);
  expect(await page.evaluate(() => globalThis.__issue106Document)).toBe("same-document");

  // This is the hardest board to keep aligned, so it is the one the column rule
  // is measured on: podium rows carry a winner ribbon beside the name and a
  // named place, while the racers beneath them carry neither. Every row still
  // has to hold the same three column positions at both supported extremes.
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const [finalBox, roundOneBox] = await Promise.all([
      roundSections.nth(0).boundingBox(),
      roundSections.nth(1).boundingBox(),
    ]);
    expect(finalBox.y).toBeLessThan(roundOneBox.y);
    await expect(finalCard.getByText("Winner", { exact: true })).toHaveCount(1);
    // Three round-one heats of three, one recorded winner each: the six racers
    // with no place still fill their column rather than collapsing the row.
    await expect(roundSections.nth(1).locator(".board-place-cell")).toHaveText([
      "1st place", "Not assigned", "Not assigned",
      "1st place", "Not assigned", "Not assigned",
      "1st place", "Not assigned", "Not assigned",
    ]);
    await expectAlignedBoardRows(page);
    await expectNoDocumentOverflow(page);
  }
  expect(errors).toEqual([]);
});
