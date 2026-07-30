import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  expectNoDocumentOverflow,
  intakeDuck,
  pairDuck,
  registerParticipant,
  seedState,
  watchBrowserErrors,
} from "./helpers.mjs";

const duplicateName = "Robin River";
const duckNumber = 701;

const isPublicSearch = (value) =>
  new URL(typeof value === "string" ? value : value.url()).pathname === "/api/v1/race-status/search";

const search = async (page) => {
  await page.getByLabel("Participant name").fill(duplicateName);
  await page.getByRole("button", { name: "Find status" }).click();
  await expect(page.locator("[data-search-message]")).not.toHaveText("Searching…");
};

const searchCards = (page) => page.locator("[data-search-results] .duck-card");
const searchCardForDuck = (page, number) => searchCards(page).filter({ hasText: `Duck #${number}` });

const expectSearchPrivacy = async (page, registrationIds) => {
  const markup = await page.locator("[data-search-results]").evaluate((element) => element.outerHTML);
  for (const registrationId of registrationIds) expect(markup).not.toContain(registrationId);
  expect(markup).not.toMatch(/email|phone|lookup.?code|private.?token|ownership.?proof|tag.?token|inventory|notes/i);
};

const expectPrivacyGap = async (page, state) => {
  const gap = await page.evaluate((currentState) => {
    const privacy = document.querySelector(".my-ducks-search > .privacy");
    const anchor = currentState === "results"
      ? document.querySelector("[data-search-results]")?.lastElementChild
      : document.querySelector("[data-search-message]");
    if (!(privacy instanceof HTMLElement) || !(anchor instanceof HTMLElement)) return -1;
    return privacy.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom;
  }, state);
  expect(gap).toBeGreaterThanOrEqual(16);
  await expectNoDocumentOverflow(page);
};

test("My Ducks search filters only identities known to this device across live collection transitions", async ({ page }, testInfo) => {
  // Wrangler keeps the production-equivalent 20/60 limiter across this
  // sequential browser suite. Give this browser (and each retry) its own
  // TEST-NET address so this scenario cannot spend a neighboring test's budget.
  // The request-count assertion below still proves this test stays far below
  // the real limit; neither Worker configuration nor the limiter is weakened.
  await page.context().setExtraHTTPHeaders({
    "cf-connecting-ip": `192.0.2.${70 + testInfo.retry}`,
  });
  const errors = watchBrowserErrors(page);
  let publicSearchRequests = 0;
  const publicSearchStatuses = [];
  page.context().on("request", (request) => {
    if (isPublicSearch(request)) publicSearchRequests += 1;
  });
  page.context().on("response", (response) => {
    if (isPublicSearch(response)) publicSearchStatuses.push(response.status());
  });
  const seeded = await seedState("registration", { participants: 1, heatSize: 3 });
  const { client } = await bootstrap();
  const duplicate = await registerParticipant(client, seeded.eventId, 70, {
    firstName: "Robin",
    lastName: "River",
  });
  const duck = await intakeDuck(client, seeded.eventId, duckNumber);
  await pairDuck(client, seeded.eventId, duck, duplicate);

  // Register one Robin in this browser before its initial search. The result
  // must hide that owned identity while retaining the unrelated same-name
  // participant, identified only by the public duck number.
  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await registration.getByLabel("First name").fill("Robin");
  await registration.getByLabel("Last name").fill("River");
  await registration.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(`${baseUrl}/my-ducks`);

  const ownedCard = page.locator('[data-participant-section="awaiting"] [data-registration-id]')
    .filter({ has: page.getByRole("heading", { name: duplicateName, exact: true }) });
  await expect(ownedCard).toBeVisible();
  const ownedRegistrationId = await ownedCard.getAttribute("data-registration-id");
  expect(ownedRegistrationId).toMatch(/^[0-9a-f-]{36}$/i);

  await search(page);
  await expect(searchCards(page)).toHaveCount(1);
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expect(page.locator("[data-search-message]")).toHaveText("1 match found.");
  await expectSearchPrivacy(page, [ownedRegistrationId, duplicate.registrationId]);

  // Following the sole eligible result creates an overlapping owned/followed
  // collection. The local hub reruns both authoritative reads and reaches the
  // normal no-results state because both stable identities are now known.
  const followSearchRefresh = page.waitForResponse(isPublicSearch);
  await searchCardForDuck(page, duckNumber).getByRole("button", { name: "Add to My Ducks" }).click();
  expect((await followSearchRefresh).status()).toBe(200);
  await expect(searchCardForDuck(page, duckNumber)).toHaveCount(0);
  await expect(searchCards(page)).toHaveCount(0);
  await expect(page.locator("[data-search-message]")).toHaveText("No matching public race status was found.");
  const followedCard = page.locator('[data-participant-section="followed"] [data-registration-id]')
    .filter({ hasText: `Duck #${duckNumber}` });
  await expect(ownedCard).toBeVisible();
  await expect(followedCard).toBeVisible();

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrivacyGap(page, "empty");
  }

  // Unfollowing is reversible. Its local authoritative refresh restores the
  // unrelated identity while the same-name registration remains owned and
  // therefore excluded.
  const unfollowSearchRefresh = page.waitForResponse(isPublicSearch);
  await followedCard.getByRole("button", { name: "Stop following" }).click();
  expect((await unfollowSearchRefresh).status()).toBe(200);
  await expect(followedCard).toHaveCount(0);
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expect(searchCards(page)).toHaveCount(1);
  await expect(page.locator("[data-search-message]")).toHaveText("1 match found.");
  await expect(ownedCard).toBeVisible();
  await expectSearchPrivacy(page, [ownedRegistrationId, duplicate.registrationId]);

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrivacyGap(page, "results");
  }
  // A mutation signal can arrive just after its direct refresh. Require two
  // quiet samples before checking the budget so neither an in-flight response
  // nor a prompt late live refetch escapes the accounting below.
  let previousSearchRequests = -1;
  let quietSearchSamples = 0;
  for (let sample = 0; sample < 8 && quietSearchSamples < 2; sample += 1) {
    await page.waitForTimeout(250);
    if (
      publicSearchRequests === previousSearchRequests
      && publicSearchStatuses.length === publicSearchRequests
    ) quietSearchSamples += 1;
    else quietSearchSamples = 0;
    previousSearchRequests = publicSearchRequests;
  }
  expect(quietSearchSamples).toBe(2);
  // The production/local limiter allows 20 searches per rolling minute. Keep
  // this whole browser scenario at no more than five (normally three), including
  // the authoritative searches queued by follow and unfollow. A plain submit
  // must not immediately queue an identical second search.
  // Every observed response must succeed; a page-local count alone cannot hide
  // an already exhausted shared limiter budget.
  expect(publicSearchRequests).toBeLessThanOrEqual(5);
  expect(publicSearchStatuses).toHaveLength(publicSearchRequests);
  expect(publicSearchStatuses.every((status) => status === 200)).toBe(true);
  expect(errors).toEqual([]);
});
