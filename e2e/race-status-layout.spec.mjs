import { expect, test } from "@playwright/test";

import {
  bootstrap,
  expectNoDocumentOverflow,
  finalizeHeat,
  intakeDuck,
  pairDuck,
  registerParticipant,
  seedState,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

const supportedWidths = [320, 390, 768, 1280];

const waitForBoard = (page, predicate) => page.waitForResponse(async (response) => {
  const url = new URL(response.url());
  if (response.request().method() !== "GET" || url.pathname !== "/api/v1/race-board" || response.status() !== 200) {
    return false;
  }
  const body = await response.json().catch(() => null);
  return predicate(body);
}, { timeout: 12_000 });

test("Race Status hero matches the Home hero horizontal bounds at supported widths", async ({ page }) => {
  const errors = watchBrowserErrors(page);
  await seedState("registration");

  for (const width of supportedWidths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const home = await page.locator("main.shell > .hero").boundingBox();
    expect(home).toBeTruthy();

    await page.goto("/race");
    const race = await page.locator("[data-race-status-hero]").boundingBox();
    expect(race).toBeTruthy();
    expect(race.x).toBeCloseTo(home.x, 0);
    expect(race.width).toBeCloseTo(home.width, 0);
    expect(race.x + race.width).toBeCloseTo(home.x + home.width, 0);
    await expectNoDocumentOverflow(page);
  }

  expect(errors).toEqual([]);
});

test("Race Status heat rows align long participant, duck, and missing-place values responsively", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.context().setExtraHTTPHeaders({
    "cf-connecting-ip": `192.0.2.${220 + testInfo.retry}`,
  });
  const errors = watchBrowserErrors(page);
  const seeded = await seedState("registration", { participants: 3, heatSize: 3 });
  const { client } = await bootstrap();
  const longFirstName = "Alexandria Riverbank Celebration";
  const longDisplayName = `${longFirstName} O.`;
  const longDuckName = "Captain Quacks on a Very Wide Blue River";

  // Register this participant in the browser so the real owner-only naming UI
  // can supply the long public duck name without bypassing any application API.
  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await registration.getByLabel("First name").fill(longFirstName);
  await registration.getByLabel("Last name").fill("Observer");
  await registration.getByLabel(/Email/).fill("layout.observer@example.test");
  await registration.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(/\/my-ducks(?:$|[?#])/);

  const registrations = (await client.get(
    `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("layout.observer@example.test")}`,
  )).body.registrations;
  const longParticipant = registrations.find((candidate) => candidate.email === "layout.observer@example.test");
  expect(longParticipant).toBeTruthy();
  const additional = [
    await registerParticipant(client, seeded.eventId, 10),
    await registerParticipant(client, seeded.eventId, 11),
  ];
  const initiallyUnpaired = seeded.participants.find((participant) => participant.visibleNumber === undefined);
  expect(initiallyUnpaired).toBeTruthy();

  // Complete the first three-person heat, then put the long participant and two
  // ordinary entries together in the second heat so column geometry is compared
  // within the same card.
  const participantsToPair = [initiallyUnpaired, longParticipant, ...additional];
  let longDuck;
  for (const [index, participant] of participantsToPair.entries()) {
    const duck = await intakeDuck(client, seeded.eventId, 803 + index);
    await pairDuck(client, seeded.eventId, duck, participant);
    if (participant === longParticipant) longDuck = duck;
  }
  expect(longDuck).toBeTruthy();

  await page.bringToFront();
  const ownedCard = page.locator(`[data-registration-id="${longParticipant.registrationId}"]`);
  await expect(ownedCard).toBeVisible();
  await ownedCard.getByRole("button", { name: "Name this duck", exact: true }).click();
  await ownedCard.getByLabel("Duck name", { exact: true }).fill(longDuckName);
  const nameSaved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/registrations/mine/duck-name"
    && response.request().method() === "POST");
  await ownedCard.getByRole("button", { name: "Save name", exact: true }).click();
  expect((await nameSaved).status()).toBe(200);
  await expect(ownedCard.getByRole("link", { name: longDuckName, exact: true })).toBeVisible();

  await client.post(`/api/v1/staff/events/${seeded.eventId}/close-registration`, {
    commandId: crypto.randomUUID(),
  });
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  });
  await page.goto("/race");

  const entries = page.locator("[data-board-entry]");
  await expect(entries).toHaveCount(6);
  await expect(page.getByText(longDisplayName, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: longDuckName, exact: true })).toBeVisible();
  await expect(page.locator(".board-table thead th").first()).toHaveText("Participant");
  await expect(page.locator("[data-board-participant]")).toHaveCount(6);
  await expect(page.locator("[data-board-duck]")).toHaveCount(6);
  await expect(page.locator("[data-board-place]")).toHaveCount(6);
  await expect(page.locator("[data-board-place]")).toHaveText(Array(6).fill("Not placed"));

  for (const width of supportedWidths) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText(longDisplayName, { exact: true })).toBeVisible();
    const tables = await page.locator(".board-table").evaluateAll((nodes) => nodes.map((table) => {
      const rows = [...table.querySelectorAll("tbody > [data-board-entry]")];
      return rows.map((row) => ({
        row: row.getBoundingClientRect().toJSON(),
        cells: [...row.children].map((cell) => cell.getBoundingClientRect().toJSON()),
      }));
    }));
    expect(tables).toHaveLength(2);
    for (const rows of tables) {
      expect(rows).toHaveLength(3);
      for (let column = 0; column < 3; column += 1) {
        const positions = rows.map((row) => row.cells[column].x);
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
      }
      for (const { row, cells } of rows) {
        expect(cells).toHaveLength(3);
        for (const cell of cells) {
          expect(cell.x).toBeGreaterThanOrEqual(row.x - 1);
          expect(cell.x + cell.width).toBeLessThanOrEqual(row.x + row.width + 1);
        }
        expect(cells[0].x + cells[0].width).toBeLessThanOrEqual(cells[1].x + 1);
        expect(cells[1].x + cells[1].width).toBeLessThanOrEqual(cells[2].x + 1);
      }
    }
    const longCellsFit = await page.getByRole("link", { name: longDuckName, exact: true }).evaluate((link) => {
      const cell = link.closest("[data-board-duck]");
      return cell.scrollWidth <= cell.clientWidth + 1 && getComputedStyle(cell).overflowWrap === "anywhere";
    });
    expect(longCellsFit).toBe(true);
    const longParticipantFits = await page.getByText(longDisplayName, { exact: true }).evaluate((name) => {
      const cell = name.closest("[data-board-participant]");
      return cell.scrollWidth <= cell.clientWidth + 1 && getComputedStyle(cell).overflowWrap === "anywhere";
    });
    expect(longParticipantFits).toBe(true);
    await expectNoDocumentOverflow(page);
  }

  expect(errors).toEqual([]);
});

test("the live race board keeps and updates the Final above deterministically ordered Round One heats", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = watchBrowserErrors(page);
  const seeded = await seedState("round-one");
  const { client } = await bootstrap();
  await page.goto("/race");
  const originalUrl = page.url();
  const content = page.locator("[data-live-board-content]");
  const sections = content.locator(":scope > [data-board-round]");
  const roundOneHeadings = ["Round one · Heat 1", "Round one · Heat 2", "Round one · Heat 3"];

  await expect(sections).toHaveCount(2);
  expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.dataset.boardRound)))
    .toEqual(["FINAL", "ROUND_ONE"]);
  await expect(sections.nth(1).locator(":scope > .board-grid > [data-board-heat] > h4")).toHaveText(roundOneHeadings);

  const listed = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`)).body.heats;
  const remaining = listed
    .filter((heat) => heat.round === "ROUND_ONE" && heat.status !== "FINALIZED")
    .sort((left, right) => left.number - right.number);
  for (const heat of remaining) {
    const detail = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`)).body;
    Object.assign(heat, detail.heat);
    if (heat.status === "CALLING") await transitionHeat(client, seeded.eventId, heat, "start");
    if (heat.status === "RUNNING") await transitionHeat(client, seeded.eventId, heat, "finish");
    await finalizeHeat(client, seeded.eventId, heat, [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }]);
  }

  await page.bringToFront();
  const finalCreated = waitForBoard(page, (body) => body?.event?.finalHeats?.length === 1);
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-final`, {
    commandId: crypto.randomUUID(),
  });
  await finalCreated;

  await expect(sections).toHaveCount(2);
  expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.dataset.boardRound)))
    .toEqual(["FINAL", "ROUND_ONE"]);
  await expect(sections.locator(":scope > h3")).toHaveText(["Final", "Round one"]);
  await expect(sections.nth(1).locator(":scope > .board-grid > [data-board-heat] > h4")).toHaveText(roundOneHeadings);
  const [finalBox, roundOneBox] = await Promise.all([sections.nth(0).boundingBox(), sections.nth(1).boundingBox()]);
  expect(finalBox.y + finalBox.height).toBeLessThanOrEqual(roundOneBox.y + 1);
  expect(page.url()).toBe(originalUrl);

  const finalHeat = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`)).body.heats
    .find((heat) => heat.round === "FINAL");
  const finalDetail = (await client.get(
    `/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`,
  )).body;
  Object.assign(finalHeat, finalDetail.heat);
  for (const operation of ["ready", "call", "start", "finish"]) {
    await transitionHeat(client, seeded.eventId, finalHeat, operation);
  }
  await page.bringToFront();
  const finalUpdated = waitForBoard(page, (body) => body?.event?.finalHeats?.[0]?.roster?.some((entry) => entry.place === 1));
  await finalizeHeat(
    client,
    seeded.eventId,
    finalHeat,
    finalDetail.roster.slice(0, 3).map((entry, index) => ({ raceEntryId: entry.raceEntryId, place: index + 1 })),
  );
  await finalUpdated;

  expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.dataset.boardRound)))
    .toEqual(["FINAL", "ROUND_ONE"]);
  const updatedFinal = sections.nth(0);
  await expect(updatedFinal.locator("[data-board-place]").first()).toHaveText("1st place");
  await expect(updatedFinal.locator("[data-board-entry]")).toHaveCount(3);
  await expect(updatedFinal.locator("[data-board-participant]")).toHaveCount(3);
  await expect(updatedFinal.locator("[data-board-duck]")).toHaveCount(3);
  await expect(updatedFinal.locator("[data-board-place]")).toHaveCount(3);
  await expect(sections.nth(1).locator(":scope > .board-grid > [data-board-heat] > h4")).toHaveText(roundOneHeadings);
  await expectNoDocumentOverflow(page);
  expect(page.url()).toBe(originalUrl);
  expect(errors).toEqual([]);
});
