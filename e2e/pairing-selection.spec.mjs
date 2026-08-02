import { expect, test } from "@playwright/test";

import {
  bootstrap,
  expectHorizontallyCentered,
  expectNoDocumentOverflow,
  intakeDuck,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const mobileWidths = [320, 375, 430];

const observePairingScrolls = async (page) => {
  await page.addInitScript(() => {
    globalThis.__quickDucksPairingScrolls = [];
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (this.matches("[data-pairing-confirmation]")) {
        const confirmation = document.querySelector("[data-confirm-pairing]");
        globalThis.__quickDucksPairingScrolls.push({
          behavior: options?.behavior,
          block: options?.block,
          inline: options?.inline,
          confirmationEnabled: confirmation instanceof HTMLButtonElement && !confirmation.disabled,
          reviewText: this.querySelector("[data-pairing-review]")?.textContent || "",
          focused: document.activeElement === this,
        });
      }
      return options === undefined
        ? nativeScrollIntoView.call(this)
        : nativeScrollIntoView.call(this, options);
    };
  });
};

const pairingPostCounter = (page, tagToken) => {
  const state = { count: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/v1/staff/ducks/${tagToken}/assignments`
      && request.method() === "POST") state.count += 1;
  });
  return state;
};

const fullyInViewport = (locator) => locator.evaluate((element) => {
  const bounds = element.getBoundingClientRect();
  return bounds.top >= -1 && bounds.bottom <= innerHeight + 1;
});

const openLongPairingList = async (page, viewport) => {
  await page.setViewportSize(viewport);
  const seeded = await seedState("registration", { participants: 24 });
  const admin = seeded.accounts.find((account) => account.isSystemAdmin);
  const waiting = seeded.participants.filter((participant) => participant.visibleNumber === undefined);
  expect(waiting.length).toBeGreaterThanOrEqual(8);
  const { client } = await bootstrap();
  const duck = await intakeDuck(client, seeded.eventId, 901);
  await signIn(page, admin.email, `/staff/ducks/${duck.tagToken}`);
  const results = page.locator("[data-registration-results] .result-button");
  await expect(results).toHaveCount(waiting.length);
  return { seeded, waiting, client, duck, results };
};

test.describe("search-result pairing confirmation", () => {
  test("scrolls a rendered confirmation into view once without submitting", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await observePairingScrolls(page);
    const { seeded, waiting, client, duck } = await openLongPairingList(page, { width: 1280, height: 560 });
    const posts = pairingPostCounter(page, duck.tagToken);
    const confirmationRegion = page.locator("[data-pairing-confirmation]");
    const review = page.locator("[data-pairing-review]");
    const confirm = page.getByRole("button", { name: "Confirm duck pairing", exact: true });
    const destinationBefore = await confirmationRegion.boundingBox();
    expect(destinationBefore.y).toBeGreaterThan(560);
    await expect(confirm).toBeDisabled();

    const participant = waiting[0];
    await page.getByRole("button", { name: new RegExp(participant.lookupCode) }).click();

    await expect(review).toContainText(`${participant.firstName} ${participant.lastName}`);
    await expect(review).toContainText(participant.lookupCode);
    await expect(confirm).toBeEnabled();
    await expect(confirmationRegion).toBeFocused();
    await expect.poll(() => fullyInViewport(confirmationRegion)).toBe(true);
    await expect(confirm).toBeInViewport();
    expect(posts.count).toBe(0);
    const scrolls = await page.evaluate(() => globalThis.__quickDucksPairingScrolls);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]).toMatchObject({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
      confirmationEnabled: true,
      focused: true,
    });
    expect(scrolls[0].reviewText).toContain(`${participant.firstName} ${participant.lastName}`);
    expect(scrolls[0].reviewText).toContain(participant.lookupCode);

    // A live ducks-domain signal is queued while this deliberate review is in
    // progress. It must not steal focus or repeat the selection scroll.
    await intakeDuck(client, seeded.eventId, 902);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => globalThis.__quickDucksPairingScrolls.length)).toBe(1);
    await expect(confirmationRegion).toBeFocused();
    expect(posts.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test("keeps keyboard focus logical and uses immediate reduced-motion scrolling on mobile", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await observePairingScrolls(page);
    const { waiting, duck } = await openLongPairingList(page, { width: 390, height: 520 });
    const posts = pairingPostCounter(page, duck.tagToken);
    const search = page.getByLabel("Participant code, name, phone, or email");
    const confirmationRegion = page.locator("[data-pairing-confirmation]");
    const review = page.locator("[data-pairing-review]");
    const confirm = page.getByRole("button", { name: "Confirm duck pairing", exact: true });

    // Enter performs the search without native form navigation and dismisses a
    // mobile software keyboard. Keeping this viewport short represents the
    // visual area left while such a keyboard is open.
    await search.focus();
    await search.press("Enter");
    await expect(search).not.toBeFocused();
    await expect(page.locator("[data-registration-results] .result-button")).toHaveCount(waiting.length);

    const participant = waiting[0];
    const result = page.getByRole("button", { name: new RegExp(participant.lookupCode) });
    await result.focus();
    await expect(result).toBeFocused();
    await expect(confirm).not.toBeInViewport();
    await result.press("Enter");

    await expect(review).toContainText(`${participant.firstName} ${participant.lastName}`);
    await expect(confirm).toBeEnabled();
    await expect(confirmationRegion).toBeFocused();
    await expect.poll(() => fullyInViewport(confirmationRegion)).toBe(true);
    const scrolls = await page.evaluate(() => globalThis.__quickDucksPairingScrolls);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]).toMatchObject({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
      confirmationEnabled: true,
      focused: true,
    });
    expect(scrolls[0].reviewText).toContain(participant.lookupCode);

    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 520 });
      await expectHorizontallyCentered(confirm, confirmationRegion);
      await expectNoDocumentOverflow(page);
    }

    // The focused review region comes immediately before the still-unsubmitted
    // action, so one Tab advances there without activating it.
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    expect(posts.count).toBe(0);
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });
});
