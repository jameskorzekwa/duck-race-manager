import { expect, test } from "@playwright/test";

import {
  baseUrl,
  expectNoDocumentOverflow,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const mobileWidths = [320, 375, 430];
const widths = mobileWidths;

const expectMobilePresentation = async (page) => {
  const layout = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    };
    const containedSelectors = [
      ".page-panel", ".status-section", ".card", ".notice", ".privacy",
      ".console-section", ".operation-card", ".announcer-section", ".heat-bag",
      ".station-callout", ".station-recorded", ".station-ineligible", ".emergency-replacement",
    ].join(",");
    const contained = Array.from(document.querySelectorAll(containedSelectors))
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { selector: element.className, left: box.left, right: box.right };
      });
    const actions = Array.from(document.querySelectorAll(".actions"))
      .filter(visible)
      .map((element) => ({
        justify: getComputedStyle(element).justifyContent,
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
    const touchTargets = Array.from(document.querySelectorAll(".button"))
      .filter(visible)
      .map((element) => element.getBoundingClientRect().height);
    return { contained, actions, touchTargets, viewport: document.documentElement.clientWidth };
  });

  for (const item of layout.contained) {
    expect(item.left, String(item.selector)).toBeGreaterThanOrEqual(-1);
    expect(item.right, String(item.selector)).toBeLessThanOrEqual(layout.viewport + 1);
  }
  for (const action of layout.actions) {
    expect(action.justify).toBe("center");
    // The shared tactile shadow can contribute up to four pixels to a local
    // scrollable-overflow measurement; document overflow above must still be 0.
    expect(action.scroll).toBeLessThanOrEqual(action.client + 4);
  }
  for (const height of layout.touchTargets) expect(height).toBeGreaterThanOrEqual(44);
};

const verifyWidths = async (page, paths) => {
  for (const path of paths) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("main")).toBeVisible();
      await expectNoDocumentOverflow(page);
      if (mobileWidths.includes(width)) await expectMobilePresentation(page);
    }
  }
};

test.describe("responsive race surfaces", () => {
  test("preparing and registration pages never overflow", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await seedState("empty");
    // `/race` is not in this list because it has no Preparing page any more: it
    // redirects home, which is the first path already verified here.
    await verifyWidths(page, ["/", "/register"]);
    await page.goto("/race");
    await expect(page).toHaveURL(`${baseUrl}/`);

    // Leave the live Preparing page before replacing the event. That page is
    // allowed to react to lifecycle changes; measuring while it repaints would
    // test a destroyed navigation context rather than responsive layout.
    await page.goto("about:blank");
    const seeded = await seedState("registration");
    await verifyWidths(page, [
      "/",
      "/register",
      "/my-ducks",
      "/race",
      "/duck/101",
      `/r/${seeded.participants[0].privateToken}`,
    ]);

    await page.goto("about:blank");
    const closed = await seedState("closed");
    await verifyWidths(page, [
      "/",
      "/register",
      "/my-ducks",
      "/race",
      "/duck/101",
      `/r/${closed.participants[0].privateToken}`,
    ]);
    expect(errors).toEqual([]);
  });

  test("racing public and staff stations never overflow", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    await signIn(page, seeded.accounts.find((account) => account.isSystemAdmin).email);
    await verifyWidths(page, [
      "/race",
      "/staff",
      "/staff/registration",
      "/staff/start-line",
      "/staff/finish-line",
      "/staff/announcer",
      "/staff/inventory",
      "/staff/access",
      `/staff/ducks/${seeded.participants[0].tagToken}`,
    ]);
    expect(errors).toEqual([]);
  });

  test("staff authentication, authorization, and not-found states stay usable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await seedState("empty");
    await verifyWidths(page, ["/staff", "/not-a-quickducks-page", "/staff/inventory-intake"]);
    await expect(page.getByRole("heading", { name: "Nothing is swimming here." })).toBeVisible();

    await page.goto("about:blank");
    const seeded = await seedState("round-one");
    const resultTaker = seeded.accounts.find((account) => account.roles.includes("RESULT_TAKER"));
    await signIn(page, resultTaker.email, "/staff/finish-line");
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/staff/access");
      await expect(page.getByRole("heading", { name: "We couldn’t finish signing you in." })).toBeVisible();
      await expect(page.getByText("does not have permission to manage staff access", { exact: false })).toBeVisible();
      await expectNoDocumentOverflow(page);
      await expectMobilePresentation(page);
    }

    // Chromium may report the deliberate 403/404 document responses at the
    // network layer. Keep those exact states and reject every unrelated error.
    expect(errors.filter((error) => !/\b(?:403|404) \((?:Forbidden|Not Found)\)/.test(error))).toEqual([]);
  });

  test("completed board and deletion console never overflow", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("completed");
    await verifyWidths(page, ["/", "/race", "/duck/101"]);
    await signIn(page, seeded.accounts.find((account) => account.isSystemAdmin).email);
    await verifyWidths(page, ["/staff", "/staff/announcer"]);
    expect(errors).toEqual([]);
  });
});
