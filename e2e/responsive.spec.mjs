import { expect, test } from "@playwright/test";

import {
  expectNoDocumentOverflow,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const widths = [320, 390, 768, 1280];

const verifyWidths = async (page, paths) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoDocumentOverflow(page);
    }
  }
};

test.describe("responsive race surfaces", () => {
  test("preparing and registration pages never overflow", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await seedState("empty");
    await verifyWidths(page, ["/", "/register", "/race"]);

    await seedState("registration");
    await verifyWidths(page, ["/", "/register", "/my-ducks", "/race", "/duck/101"]);
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
    ]);
    expect(errors).toEqual([]);
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
