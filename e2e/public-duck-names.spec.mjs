import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  expectNoDocumentOverflow,
  intakeDuck,
  pairDuck,
  rawJson,
  rejectSensitiveKeys,
  seedState,
  watchBrowserErrors,
} from "./helpers.mjs";

const namedDuckNumber = 701;
const publicDuckName = "Captain Quacks on a Very Wide Blue River";

test("participant-provided duck names replace generic labels across public live and responsive views", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  await page.context().setExtraHTTPHeaders({
    "cf-connecting-ip": `192.0.2.${210 + (testInfo.retry * 3)}`,
  });
  const ownerErrors = watchBrowserErrors(page);
  const seeded = await seedState("registration", { participants: 3, heatSize: 3 });
  const { client } = await bootstrap();
  const unnamed = seeded.participants[0];

  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await registration.getByLabel("First name").fill("Named");
  await registration.getByLabel("Last name").fill("Public");
  await registration.getByLabel(/Email/).fill("named.private@example.test");
  await registration.getByLabel("Phone (optional)").fill("+15550109999");
  await registration.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(`${baseUrl}/my-ducks`);
  const privateStatusPath = await page.getByRole("link", { name: "Open private status" }).getAttribute("href");
  expect(privateStatusPath).toMatch(/^\/r\/[A-Za-z0-9_-]{43}$/);

  const registrations = (await client.get(
    `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("named.private@example.test")}`,
  )).body.registrations;
  const namedParticipant = registrations.find((candidate) => candidate.email === "named.private@example.test");
  expect(namedParticipant).toBeTruthy();
  const namedDuck = await intakeDuck(client, seeded.eventId, namedDuckNumber);
  await pairDuck(client, seeded.eventId, namedDuck, namedParticipant);

  const ownedCard = page.locator(`[data-registration-id="${namedParticipant.registrationId}"]`);
  await expect(ownedCard).toBeVisible();
  await expect(ownedCard.getByRole("link", { name: `Duck #${namedDuckNumber}`, exact: true })).toBeVisible();

  // Keep independent public pages open before the rename. Their later paint has
  // to come from the live signal followed by authoritative API refetches.
  const publicContext = await browser.newContext({
    extraHTTPHeaders: { "cf-connecting-ip": `192.0.2.${211 + (testInfo.retry * 3)}` },
  });
  const publicPages = [];
  const openPublicPage = async (path) => {
    const publicPage = await publicContext.newPage();
    publicPages.push({ page: publicPage, errors: watchBrowserErrors(publicPage) });
    await publicPage.goto(path);
    return publicPage;
  };
  const racePage = await openPublicPage("/race");
  const duckPage = await openPublicPage(`/duck/${namedDuckNumber}`);
  const tagPage = await openPublicPage(`/t/${namedDuck.tagToken}`);
  const privatePage = await openPublicPage(privateStatusPath);
  const followedPage = await openPublicPage("/my-ducks");
  const unnamedPage = await openPublicPage(`/duck/${unnamed.visibleNumber}`);

  const raceNamedRow = racePage.locator(".board-entry").filter({ hasText: "Named P." });
  const raceUnnamedRow = racePage.locator(".board-entry").filter({ hasText: "Daisy D." });
  await expect(raceNamedRow.getByRole("link", { name: `Duck #${namedDuckNumber}`, exact: true })).toBeVisible();
  await expect(raceUnnamedRow.getByRole("link", { name: `Duck #${unnamed.visibleNumber}`, exact: true })).toBeVisible();
  await expect(duckPage.getByRole("heading", { name: `Duck #${namedDuckNumber}`, exact: true })).toBeVisible();
  await expect(tagPage.getByRole("heading", { name: `Duck #${namedDuckNumber}`, exact: true })).toBeVisible();
  await expect(privatePage.locator("main")).toContainText(`Duck #${namedDuckNumber}`);
  await expect(unnamedPage.getByRole("heading", { name: `Duck #${unnamed.visibleNumber}`, exact: true })).toBeVisible();

  await followedPage.getByLabel("Participant name").fill("Named Public");
  await followedPage.getByRole("button", { name: "Find status" }).click();
  const result = followedPage.locator("[data-search-results] .duck-card").filter({ hasText: "Named P." });
  await expect(result).toContainText(`Duck #${namedDuckNumber}`);
  await result.getByRole("button", { name: "Add to My Ducks" }).click();
  const followedCard = followedPage.locator('[data-participant-section="followed"] [data-registration-id]')
    .filter({ has: followedPage.getByRole("heading", { name: "Named P.", exact: true }) });
  await expect(followedCard).toBeVisible();
  await expect(followedCard.getByRole("link", { name: `Duck #${namedDuckNumber}`, exact: true })).toBeVisible();
  await expect(followedCard.locator("[data-contact-summary], [data-contact-edit], [data-duck-name-form]")).toHaveCount(0);

  const searchContext = await browser.newContext({
    extraHTTPHeaders: { "cf-connecting-ip": `192.0.2.${212 + (testInfo.retry * 3)}` },
  });
  const searchPage = await searchContext.newPage();
  const searchErrors = watchBrowserErrors(searchPage);
  await searchPage.goto("/my-ducks");
  await searchPage.getByLabel("Participant name").fill("Named Public");
  await searchPage.getByRole("button", { name: "Find status" }).click();
  const namedResult = searchPage.locator("[data-search-results] .duck-card").filter({ hasText: "Named P." });
  await expect(namedResult).toContainText(`Duck #${namedDuckNumber}`);

  await page.bringToFront();
  const nameResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/registrations/mine/duck-name"
    && response.request().method() === "POST");
  await ownedCard.getByRole("button", { name: "Name this duck", exact: true }).click();
  await ownedCard.getByLabel("Duck name", { exact: true }).fill(publicDuckName);
  await ownedCard.getByRole("button", { name: "Save name", exact: true }).click();
  expect((await nameResponse).status()).toBe(200);

  // Every open page replaces its old generic label without navigation. The
  // participant names remain the policy-safe public projections.
  await expect(ownedCard.getByRole("link", { name: publicDuckName, exact: true })).toBeVisible();
  await expect(ownedCard.getByText(`Duck #${namedDuckNumber}`, { exact: true })).toHaveCount(0);
  await racePage.bringToFront();
  await expect(raceNamedRow.getByRole("link", { name: publicDuckName, exact: true })).toBeVisible();
  await expect(raceNamedRow).toContainText("Named P.");
  await expect(raceNamedRow.getByText(`Duck #${namedDuckNumber}`, { exact: true })).toHaveCount(0);
  await duckPage.bringToFront();
  await expect(duckPage.getByRole("heading", { name: publicDuckName, exact: true })).toBeVisible();
  await expect(duckPage).toHaveTitle(`${publicDuckName} · QuickDucks`);
  await expect(duckPage.locator("main")).toContainText("Named P.");
  await expect(duckPage.locator("main")).not.toContainText(`Duck #${namedDuckNumber}`);
  await tagPage.bringToFront();
  await expect(tagPage.getByRole("heading", { name: publicDuckName, exact: true })).toBeVisible();
  await expect(tagPage).toHaveTitle(`${publicDuckName} · QuickDucks`);
  await expect(tagPage.locator("main")).not.toContainText(`Duck #${namedDuckNumber}`);
  await privatePage.bringToFront();
  await expect(privatePage.locator("main")).toContainText(publicDuckName);
  await expect(privatePage.locator("main")).toContainText("Named Public");
  await expect(privatePage.locator("main")).not.toContainText(`Duck #${namedDuckNumber}`);
  await followedPage.bringToFront();
  await expect(followedCard.getByRole("link", { name: publicDuckName, exact: true })).toBeVisible();
  await expect(followedCard.getByText(`Duck #${namedDuckNumber}`, { exact: true })).toHaveCount(0);

  // The already-open public search reruns its authoritative query on the same
  // participant signal and still contains no private participant material.
  await searchPage.bringToFront();
  await expect(namedResult).toContainText(publicDuckName);
  await expect(namedResult).not.toContainText(`Duck #${namedDuckNumber}`);
  await expect(namedResult).not.toContainText("named.private@example.test");
  await expect(namedResult).not.toContainText("+15550109999");
  for (const publicView of [racePage, duckPage, tagPage, privatePage, followedPage, unnamedPage, searchPage]) {
    await expect(publicView.locator("main")).not.toContainText("named.private@example.test");
    await expect(publicView.locator("main")).not.toContainText("+15550109999");
  }
  for (const publicView of [racePage, duckPage, tagPage, followedPage, unnamedPage, searchPage]) {
    await expect(publicView.locator("main")).not.toContainText(namedParticipant.lookupCode);
  }

  // Named and unnamed labels remain usable together at every supported width.
  // Long chosen names wrap; neither kind changes at a responsive breakpoint.
  for (const width of [320, 390, 768, 1280]) {
    for (const current of [page, racePage, duckPage, tagPage, privatePage, followedPage, unnamedPage, searchPage]) {
      await current.setViewportSize({ width, height: 900 });
      await expectNoDocumentOverflow(current);
    }
    await expect(raceNamedRow.getByRole("link", { name: publicDuckName, exact: true })).toBeVisible();
    await expect(raceUnnamedRow.getByRole("link", { name: `Duck #${unnamed.visibleNumber}`, exact: true })).toBeVisible();
    await expect(duckPage.getByRole("heading", { name: publicDuckName, exact: true })).toBeVisible();
    await expect(unnamedPage.getByRole("heading", { name: `Duck #${unnamed.visibleNumber}`, exact: true })).toBeVisible();
  }

  const board = await rawJson("/api/v1/race-board");
  const detail = await rawJson(`/api/v1/ducks/number/${namedDuckNumber}`);
  const scan = await rawJson(`/api/v1/ducks/${namedDuck.tagToken}`);
  for (const response of [board, detail, scan]) {
    expect(response.status).toBe(200);
    rejectSensitiveKeys(response.body);
    expect(JSON.stringify(response.body)).not.toContain("named.private@example.test");
    expect(JSON.stringify(response.body)).not.toContain("+15550109999");
  }
  expect(detail.body.raceStatus.participantDisplayName).toBe("Named P.");
  expect(detail.body.raceStatus.duckName).toBe(publicDuckName);
  expect(scan.body.raceStatus.duckName).toBe(publicDuckName);

  expect(ownerErrors).toEqual([]);
  for (const observed of publicPages) expect(observed.errors).toEqual([]);
  expect(searchErrors).toEqual([]);
  await searchContext.close();
  await publicContext.close();
});
