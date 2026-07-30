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
const duckNumbers = [701, 702, 703];

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

test("My Ducks search filters only identities known to this device across live collection transitions", async ({ page, browser }) => {
  const errors = watchBrowserErrors(page);
  const seeded = await seedState("registration", { participants: 1, heatSize: 3 });
  const { client } = await bootstrap();
  const duplicates = [];
  for (const [index, visibleNumber] of duckNumbers.entries()) {
    const participant = await registerParticipant(client, seeded.eventId, 70 + index, {
      firstName: "Robin",
      lastName: "River",
    });
    const duck = await intakeDuck(client, seeded.eventId, visibleNumber);
    await pairDuck(client, seeded.eventId, duck, participant);
    duplicates.push(participant);
  }

  // Before this browser owns or follows any Robin, every distinct same-name
  // identity is visible and can be distinguished by its public duck number.
  await page.goto("/my-ducks");
  await search(page);
  await expect(searchCards(page)).toHaveCount(3);
  await expect(page.locator("[data-search-message]")).toHaveText("3 matches found.");
  for (const number of duckNumbers) await expect(searchCardForDuck(page, number)).toBeVisible();
  await expectSearchPrivacy(page, duplicates.map((participant) => participant.registrationId));

  // Registering another participant with the identical display name on this
  // browser adds one owned identity. A fresh authoritative search hides only
  // that unpaired registration and leaves all three unrelated duplicates.
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
  await expect(searchCards(page)).toHaveCount(3);
  for (const number of duckNumbers) await expect(searchCardForDuck(page, number)).toBeVisible();
  await expectSearchPrivacy(page, [ownedRegistrationId, ...duplicates.map((item) => item.registrationId)]);

  // Following one result creates an overlapping owned/followed collection. The
  // local hub immediately reruns both authoritative reads and removes only the
  // followed identity from the active search.
  await searchCardForDuck(page, 701).getByRole("button", { name: "Add to My Ducks" }).click();
  await expect(searchCardForDuck(page, 701)).toHaveCount(0);
  await expect(searchCards(page)).toHaveCount(2);
  const followed701 = page.locator('[data-participant-section="followed"] [data-registration-id]')
    .filter({ hasText: "Duck #701" });
  await expect(followed701).toBeVisible();
  await expect(page.locator("[data-search-message]")).toHaveText("2 matches found.");

  // Known identities remain global search candidates for another device.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto("/my-ducks");
  await search(other);
  await expect(searchCards(other)).toHaveCount(4);
  for (const number of duckNumbers) await expect(searchCardForDuck(other, number)).toBeVisible();
  await otherContext.close();

  // Unfollowing is reversible. Its local authoritative refresh restores that
  // identity without readmitting the still-owned, same-name registration.
  await followed701.getByRole("button", { name: "Stop following" }).click();
  await expect(followed701).toHaveCount(0);
  await expect(searchCardForDuck(page, 701)).toBeVisible();
  await expect(searchCards(page)).toHaveCount(3);
  await expect(page.locator("[data-search-message]")).toHaveText("3 matches found.");

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrivacyGap(page, "results");
  }

  // Once every otherwise eligible identity is followed, the active search
  // reaches the normal no-results state. The owned identity remains filtered.
  for (const number of duckNumbers) {
    const card = searchCardForDuck(page, number);
    await card.getByRole("button", { name: "Add to My Ducks" }).click();
    await expect(card).toHaveCount(0);
  }
  await expect(searchCards(page)).toHaveCount(0);
  await expect(page.locator("[data-search-message]")).toHaveText("No matching public race status was found.");

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectPrivacyGap(page, "empty");
  }
  expect(errors).toEqual([]);
});
