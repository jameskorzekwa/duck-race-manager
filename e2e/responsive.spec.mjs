import { expect, test } from "@playwright/test";

import {
  accountWith,
  baseUrl,
  expectNoDocumentOverflow,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const mobileWidths = [320, 375, 430];
const widths = [...mobileWidths, 768, 1280];

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
    // `/race` is not in this list because it has no Preparing page any more: it
    // redirects home, which is the first path already verified here.
    await verifyWidths(page, ["/", "/register"]);
    await page.goto("/race");
    await expect(page).toHaveURL(`${baseUrl}/`);

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
      "/staff/inventory-intake",
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

  test("authenticated inventory intake exposes its warning and supported workflow", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const manager = accountWith(seeded.accounts, "DUCK_MANAGER");
    await signIn(page, manager.email, "/staff/inventory-intake");
    await expect(page).toHaveURL(`${baseUrl}/staff/inventory-intake`);

    const station = page.locator("[data-intake-station]");
    const runtime = page.locator("[data-intake-runtime]");
    const controls = page.locator("[data-intake-controls]");
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await expect(station.getByRole("heading", { name: "Scan ducks" })).toBeVisible();
      await expect(page.locator('.staff-nav a[href="/staff/inventory"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh inventory" })).toBeVisible();
      await expect(runtime).toBeVisible();
      await expect(runtime).toContainText("Scanning needs current Chrome on an NFC-capable Android device");
      await expect(controls).toBeHidden();
      await expectNoDocumentOverflow(page);
    }

    await page.context().addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
      });
      Object.defineProperty(globalThis, "NDEFReader", {
        configurable: true,
        value: class NDEFReader extends EventTarget {
          async scan() {}
          async write() {}
        },
      });
    });
    await page.reload();
    await expect(page).toHaveURL(`${baseUrl}/staff/inventory-intake`);
    await expect(runtime).toBeHidden();
    await expect(controls).toBeVisible();
    await expect(page.getByLabel("Station location (optional)")).toBeVisible();
    // Keep a stable element locator while the button's accessible name changes
    // to its active state after a successful Web NFC start.
    const start = page.locator("[data-start-intake-nfc]");
    await expect(start).toHaveAccessibleName("Start NFC provisioning");
    await expect(start).toBeEnabled();
    await start.click();
    await expect(start).toHaveText("NFC provisioning active");
    await expect(page.locator("[data-intake-state]")).toHaveText("Ready");
    await expect(page.locator("[data-intake-message]")).toContainText("Ready. Tap a sticker.");
    await expect(page.getByRole("button", { name: "End NFC provisioning" })).toBeVisible();

    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await expect(start).toBeVisible();
      await expect(page.locator("[data-intake-state]")).toBeVisible();
      await expect(page.locator(".station-counter")).toHaveCount(2);
      await expect(page.getByText("Session history", { exact: true })).toBeVisible();
      await expectNoDocumentOverflow(page);
    }
    expect(errors).toEqual([]);
  });

  test("staff authentication, authorization, and not-found states stay usable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/staff");
      await expect(page.getByRole("link", { name: "Continue to secure sign in" })).toBeVisible();
      await expectNoDocumentOverflow(page);
    }

    const manager = accountWith(seeded.accounts, "DUCK_MANAGER");
    await signIn(page, manager.email, "/staff/inventory-intake");
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      const denied = await page.goto("/staff/access");
      expect(denied.status()).toBe(403);
      await expect(page.getByText("permission to manage staff access", { exact: false })).toBeVisible();
      await expectNoDocumentOverflow(page);

      const missing = await page.goto("/a-very-long-missing-mobile-page-name");
      expect(missing.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Nothing is swimming here." })).toBeVisible();
      await expectNoDocumentOverflow(page);
    }
    // Chromium reports the two deliberately visited HTTP error documents as
    // resource console errors. Keep those exact statuses expected while every
    // page exception and any other console error remains fatal.
    const expectedHttpError = /^console: Failed to load resource: the server responded with a status of (?:403 \(Forbidden\)|404 \(Not Found\))$/;
    expect(errors.filter((error) => !expectedHttpError.test(error))).toEqual([]);
  });
});
