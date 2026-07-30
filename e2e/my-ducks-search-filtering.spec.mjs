import { expect, test } from "@playwright/test";

import {
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
  const followedThenOwnedCommandId = crypto.randomUUID();
  const followedThenOwned = await registerParticipant(client, seeded.eventId, 70, {
    commandId: followedThenOwnedCommandId,
    firstName: "Robin",
    lastName: "River",
  });
  const reversibleFollow = await registerParticipant(client, seeded.eventId, 71, {
    firstName: "Robin",
    lastName: "River",
  });
  const duck = await intakeDuck(client, seeded.eventId, duckNumber);
  await pairDuck(client, seeded.eventId, duck, reversibleFollow);

  // A clean device initially sees both independent identities even though their
  // public display names are identical. Their public race state, not a hidden
  // identifier, is enough for this test to choose which one to follow.
  await page.goto("/my-ducks");
  await search(page);
  await expect(searchCards(page)).toHaveCount(2);
  const unpairedSearchCard = searchCards(page).filter({ hasText: "awaiting duck pairing" });
  await expect(unpairedSearchCard).toBeVisible();
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expect(page.locator("[data-search-message]")).toHaveText("2 matches found.");
  await expectSearchPrivacy(page, [followedThenOwned.registrationId, reversibleFollow.registrationId]);

  // Following one stable identity filters only that result. The unrelated Robin
  // stays visible, proving this is not display-name filtering.
  const followSearchRefresh = page.waitForResponse(isPublicSearch);
  await unpairedSearchCard.getByRole("button", { name: "Add to My Ducks" }).click();
  expect((await followSearchRefresh).status()).toBe(200);
  const followedCard = page.locator('[data-participant-section="followed"] [data-registration-id]')
    .filter({ has: page.getByRole("heading", { name: "Robin R.", exact: true }) });
  await expect(followedCard).toBeVisible();
  await expect(searchCards(page)).toHaveCount(1);
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expect(page.locator("[data-search-message]")).toHaveText("1 match found.");

  // Replaying the original registration command from this same browser is the
  // supported followed-to-owned transition. The real handler upgrades the
  // collection link, and the live participant signal reruns the active search
  // without another submit. The identity remains filtered as it moves out of
  // Ducks I’m Following and into the owned section.
  const registrationSearchRefresh = page.waitForResponse(isPublicSearch);
  const replay = await page.evaluate(async (payload) => {
    const response = await fetch("/api/v1/registrations", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (response.ok) {
      const key = "quickducks.participant-ownership.v1";
      const current = JSON.parse(localStorage.getItem(key) || "{}");
      current[body.registrationId] = payload.privateToken;
      localStorage.setItem(key, JSON.stringify(current));
    }
    return { status: response.status, body };
  }, {
    eventId: seeded.eventId,
    commandId: followedThenOwnedCommandId,
    privateToken: followedThenOwned.privateToken,
  });
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.registrationId).toBe(followedThenOwned.registrationId);
  expect((await registrationSearchRefresh).status()).toBe(200);

  const ownedCard = page.locator('[data-participant-section="awaiting"] [data-registration-id]')
    .filter({ has: page.getByRole("heading", { name: duplicateName, exact: true }) });
  await expect(followedCard).toHaveCount(0);
  await expect(ownedCard).toBeVisible();
  await expect(ownedCard.getByRole("button", { name: "Stop following" })).toHaveCount(0);
  const ownedRegistrationId = await ownedCard.getAttribute("data-registration-id");
  expect(ownedRegistrationId).toBe(followedThenOwned.registrationId);
  await expect(searchCards(page)).toHaveCount(1);
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expectSearchPrivacy(page, [followedThenOwned.registrationId, reversibleFollow.registrationId]);

  // With one identity owned, following the sole remaining result creates the
  // normal mixed owned/followed collection and the normal no-results state.
  const finalFollowSearchRefresh = page.waitForResponse(isPublicSearch);
  await searchCardForDuck(page, duckNumber).getByRole("button", { name: "Add to My Ducks" }).click();
  expect((await finalFollowSearchRefresh).status()).toBe(200);
  const reversibleFollowedCard = page.locator('[data-participant-section="followed"] [data-registration-id]')
    .filter({ hasText: `Duck #${duckNumber}` });
  await expect(reversibleFollowedCard).toBeVisible();
  await expect(searchCards(page)).toHaveCount(0);
  await expect(page.locator("[data-search-message]")).toHaveText("No matching public race status was found.");

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrivacyGap(page, "empty");
  }

  // Unfollowing is reversible. Its local authoritative refresh restores the
  // unrelated identity while the same-name registration remains owned and
  // therefore excluded.
  const unfollowSearchRefresh = page.waitForResponse(isPublicSearch);
  await reversibleFollowedCard.getByRole("button", { name: "Stop following" }).click();
  expect((await unfollowSearchRefresh).status()).toBe(200);
  await expect(reversibleFollowedCard).toHaveCount(0);
  await expect(searchCardForDuck(page, duckNumber)).toBeVisible();
  await expect(searchCards(page)).toHaveCount(1);
  await expect(page.locator("[data-search-message]")).toHaveText("1 match found.");
  await expect(ownedCard).toBeVisible();
  await expectSearchPrivacy(page, [followedThenOwned.registrationId, reversibleFollow.registrationId]);

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
  // this whole browser scenario at no more than eight, including the searches
  // queued by two follows, the registration transition, and unfollow. That is
  // comfortably below 20, and a plain submit must not immediately queue an
  // identical second search.
  // Every observed response must succeed; a page-local count alone cannot hide
  // an already exhausted shared limiter budget.
  expect(publicSearchRequests).toBeLessThanOrEqual(8);
  expect(publicSearchStatuses).toHaveLength(publicSearchRequests);
  expect(publicSearchStatuses.every((status) => status === 200)).toBe(true);
  expect(errors).toEqual([]);
});
