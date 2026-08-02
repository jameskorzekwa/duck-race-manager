import { expect, test } from "@playwright/test";

import {
  accountWith,
  baseUrl,
  expectCentered,
  expectContained,
  expectNoDocumentOverflow,
  expectTouchTarget,
  mobileWidths,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const verifyMobileLayout = async (page, marker) => {
  await expect(page.locator(marker).first()).toBeVisible();
  await expectNoDocumentOverflow(page);

  for (const selector of [".nav", ".staff-nav", ".console-nav"]) {
    const navigation = page.locator(`${selector}:visible`);
    for (let index = 0; index < await navigation.count(); index += 1) {
      await expectContained(navigation.nth(index));
    }
  }

  const touchTargets = page.locator(
    ".button:visible,.result-button:visible,details.operation-card > summary:visible,.check:visible,"
      + ".nav a:visible,.staff-nav a:visible,.console-nav a:visible",
  );
  for (let index = 0; index < await touchTargets.count(); index += 1) {
    await expectTouchTarget(touchTargets.nth(index));
  }
  expect(await page.locator(".button:visible").evaluateAll((buttons) => buttons.every((button) => {
    const style = getComputedStyle(button);
    return style.justifyContent === "center" && style.textAlign === "center";
  }))).toBe(true);

  const actionGroups = page.locator(".actions:visible,.app-confirmation-actions:visible,.app-date-actions:visible");
  for (let index = 0; index < await actionGroups.count(); index += 1) {
    await expectContained(actionGroups.nth(index));
    await expect(actionGroups.nth(index)).toHaveCSS("justify-content", "center");
  }

  const messages = page.locator(
    ".notice:visible,.privacy:visible,.emergency-warning:visible,.danger-zone:visible,"
      + ".station-ineligible:visible,.station-callout:visible,.station-recorded:visible",
  );
  for (let index = 0; index < await messages.count(); index += 1) {
    await expectContained(messages.nth(index));
    expect((await messages.nth(index).innerText()).trim()).not.toBe("");
  }

  const standaloneActions = page.locator(
    "form > .button:not(.small):visible,.page-panel > .button:visible,"
      + ".operation-card > .button:not(.small):visible,.station-panel > .button:visible,"
      + ".pairing-confirmation > .button:visible",
  );
  for (let index = 0; index < await standaloneActions.count(); index += 1) {
    await expectCentered(standaloneActions.nth(index));
  }
};

const verifyWidths = async (page, surfaces) => {
  for (const width of mobileWidths) {
    await page.setViewportSize({ width, height: 900 });
    for (const { path, marker, text } of surfaces) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(`${baseUrl}${path}`);
      if (text !== undefined) await expect(page.locator(marker).first()).toContainText(text);
      await verifyMobileLayout(page, marker);
    }
  }
};

test.describe("responsive race surfaces", () => {
  test("public lifecycle, registration, My Ducks, status, and results stay usable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await seedState("empty");
    await verifyWidths(page, [
      { path: "/", marker: "[data-live-summary]" },
      { path: "/register", marker: "[data-registration-preparing]" },
    ]);
    await page.goto("/race");
    await expect(page).toHaveURL(`${baseUrl}/`);

    // Leave the live Preparing page before changing the authoritative phase so
    // its intentional phase reload cannot race the next navigation/measurement.
    await page.goto("about:blank");
    await seedState("registration");
    await verifyWidths(page, [
      { path: "/", marker: "[data-home-cta]" },
      { path: "/register", marker: "[data-registration-form]" },
      { path: "/my-ducks", marker: "[data-my-ducks-page]" },
      { path: "/race", marker: "[data-live-board]" },
      { path: "/duck/101", marker: "[data-duck-heading]" },
    ]);

    await page.goto("/register");
    await expect(page.locator(".privacy")).toContainText("Private by design.");
    await expect(page.locator(".notice")).toContainText("Registering more than one participant?");
    await page.getByLabel("Email (optional)").fill("not-an-email");
    await expect(page.locator("[data-field-error='email']")).toHaveText("Enter a valid email address.");
    await verifyMobileLayout(page, "[data-registration-form]");

    await page.goto("/my-ducks");
    const awaitingHeading = page.getByRole("heading", { name: "Awaiting Duck Assignment", exact: true });
    const registerAgain = page.getByRole("link", { name: "Register another participant", exact: true });
    await expect(awaitingHeading).toBeVisible();
    await expect(registerAgain).toBeVisible();
    await expectCentered(registerAgain, page.locator(".participant-section-head-actions"));
    await expectTouchTarget(registerAgain);

    await page.goto("about:blank");
    await seedState("completed");
    await verifyWidths(page, [
      { path: "/", marker: "[data-live-summary]" },
      { path: "/race", marker: ".winners" },
      { path: "/duck/101", marker: "[data-duck-heading]" },
    ]);
    expect(errors).toEqual([]);
  });

  test("public loading, validation, and failure messages remain contained and explicit", async ({ page }) => {
    await seedState("registration");
    let releaseCurrentEvent;
    const currentEventGate = new Promise((resolve) => { releaseCurrentEvent = resolve; });
    await page.route("**/api/v1/events/current", async (route) => {
      await currentEventGate;
      await route.continue();
    });
    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-event-name]")).toHaveText("Loading race details…");
    await expect(page.getByRole("button", { name: "Register participant" })).toBeDisabled();
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await verifyMobileLayout(page, "[data-registration-form]");
    }
    releaseCurrentEvent();
    await expect(page.locator("[data-event-name]")).toHaveText("Harbor Duck Derby");
    await page.unroute("**/api/v1/events/current");

    await page.route("**/api/v1/registrations/mine", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Responsive test could not load saved registrations." }),
      });
    });
    await page.goto("/my-ducks", { waitUntil: "domcontentloaded" });
    const alert = page.locator("[data-my-ducks-error][role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText("");
    for (const width of mobileWidths) {
      await page.setViewportSize({ width, height: 900 });
      await expectContained(alert);
      await verifyMobileLayout(page, "[data-my-ducks-page]");
    }
    await page.unroute("**/api/v1/registrations/mine");
  });

  test("populated staff console, tools, stations, warnings, and navigation stay usable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    await signIn(page, admin.email);
    await verifyWidths(page, [
      { path: "/staff", marker: "[data-event-summary] .fact" },
      { path: "/staff/access", marker: "[data-staff-access-list] .staff-access-card" },
      { path: "/staff/registration", marker: "[data-participant-list] button" },
      { path: "/staff/start-line", marker: "[data-station-heat]", text: /Heat \d/ },
      { path: "/staff/finish-line", marker: "[data-station-heat]", text: /Heat \d/ },
      { path: "/staff/inventory", marker: "[data-inventory-list] .result-button" },
      { path: "/staff/inventory-intake", marker: "[data-inventory-list] .result-button" },
      { path: "/staff/announcer", marker: "[data-announcer-roster] li:nth-child(2)" },
    ]);

    // Desktop Chromium cannot provision NFC, but the authenticated standalone
    // entry remains a complete inventory page with an explicit supported-device
    // warning instead of a clipped control or an authorization shortcut.
    await page.goto("/staff/inventory-intake");
    await expect(page.locator("[data-intake-runtime]")).toBeVisible();
    await expect(page.locator("[data-intake-runtime-message]")).toContainText("NFC-capable Android device");
    await expect(page.locator("[data-inventory-list] .result-button").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("staff authentication, authorization, not-found, and Android intake states stay usable", async ({ browser }) => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const registration = accountWith(seeded.accounts, "REGISTRATION");

    const anonymousContext = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto("/staff/inventory-intake");
    await expect(anonymousPage).toHaveURL(`${baseUrl}/staff?returnTo=%2Fstaff%2Finventory-intake`);
    await expect(anonymousPage.getByRole("link", { name: "Continue to secure sign in" })).toBeVisible();
    for (const width of mobileWidths) {
      await anonymousPage.setViewportSize({ width, height: 900 });
      await verifyMobileLayout(anonymousPage, "main");
    }
    await anonymousPage.goto("/not-a-quickducks-route");
    await expect(anonymousPage.locator("main")).toContainText("Nothing is swimming here.");
    await verifyMobileLayout(anonymousPage, "main");
    await anonymousContext.close();

    const deniedContext = await browser.newContext({ viewport: { width: 320, height: 900 } });
    const deniedPage = await deniedContext.newPage();
    await signIn(deniedPage, registration.email, "/staff/inventory-intake");
    await expect(deniedPage.locator(".notice")).toContainText("permission to use duck inventory");
    await expect(deniedPage.locator("[data-intake-station],[data-start-intake-nfc]")).toHaveCount(0);
    for (const width of mobileWidths) {
      await deniedPage.setViewportSize({ width, height: 900 });
      await verifyMobileLayout(deniedPage, "main");
    }
    await deniedContext.close();

    const androidContext = await browser.newContext({
      viewport: { width: 320, height: 900 },
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    });
    const androidPage = await androidContext.newPage();
    await androidPage.addInitScript(() => {
      globalThis.__intakeNfcTest = { scans: 0 };
      globalThis.NDEFReader = class NDEFReader extends EventTarget {
        async scan() { globalThis.__intakeNfcTest.scans += 1; }
        async write() {}
      };
    });
    await signIn(androidPage, admin.email, "/staff/inventory-intake");
    await expect(androidPage.locator("[data-intake-controls]")).toBeVisible();
    const start = androidPage.locator("[data-start-intake-nfc]");
    await expect(start).toContainText("Start NFC provisioning");
    await expect(start).toBeEnabled();
    await start.click();
    await androidPage.waitForFunction(() => globalThis.__intakeNfcTest.scans === 1);
    await expect(androidPage.locator("[data-intake-state]")).toContainText("Ready");
    await expect(androidPage.locator("[data-intake-message]")).toContainText("Ready. Tap a sticker.");
    await expect(start).toBeDisabled();
    await expect(androidPage.locator("[data-end-intake-nfc]")).toBeVisible();
    await expect(androidPage.locator("[data-end-intake-nfc]")).toBeEnabled();
    await androidPage.getByText("Session history", { exact: true }).click();
    await expect(androidPage.getByText("Permanent URLs and tokens are never displayed or stored by the browser.")).toBeVisible();
    for (const width of mobileWidths) {
      await androidPage.setViewportSize({ width, height: 900 });
      await verifyMobileLayout(androidPage, "[data-intake-station]");
      await expectCentered(start, androidPage.locator("[data-intake-controls] > .actions"));
    }
    await androidContext.close();
  });
});
