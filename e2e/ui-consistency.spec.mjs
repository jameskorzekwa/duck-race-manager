import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  expectNoDocumentOverflow,
  intakeDuck,
  pairDuck,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

test.describe("sitewide UI consistency", () => {
  test("primary staff views share one shell and app-styled control language", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await signIn(page, admin.email);

    const paths = [
      "/staff",
      "/staff/registration",
      "/staff/announcer",
      "/staff/start-line",
      "/staff/finish-line",
      "/staff/inventory",
      "/staff/access",
    ];
    const shells = [];
    for (const path of paths) {
      await page.goto(path);
      const panel = page.locator(".staff-panel");
      await expect(panel).toBeVisible();
      if (path === "/staff") {
        // An administrator reaches Inventory through the Admin menu bar, so the
        // persistent staff nav does not repeat it.
        await expect(page.locator('.console-nav a[href="/staff/inventory"]')).toBeVisible();
        await expect(page.locator('.staff-nav a[href="/staff/inventory"]')).toHaveCount(0);
      }
      await expect(panel).toHaveCSS("max-width", "1120px");
      await expect(panel).toHaveCSS("background-color", "rgb(255, 253, 243)");
      await expect(panel).toHaveCSS("padding-top", "35.2px");
      const box = await panel.boundingBox();
      shells.push({ path, width: box.width, x: box.x });
      await expectNoDocumentOverflow(page);
    }
    expect(new Set(shells.map(({ width }) => width))).toEqual(new Set([1120]));
    expect(new Set(shells.map(({ x }) => x))).toEqual(new Set([160]));

    await page.goto("/staff/inventory");
    const selectTrigger = page.locator(".section-tools .app-select-trigger");
    const selectAction = page.locator("[data-refresh-inventory]");
    const [selectBox, actionBox] = await Promise.all([selectTrigger.boundingBox(), selectAction.boundingBox()]);
    expect(Math.abs((selectBox.y + selectBox.height / 2) - (actionBox.y + actionBox.height / 2))).toBeLessThanOrEqual(1);
    expect(selectBox.height).toBe(actionBox.height);

    await page.goto("/staff/access");
    const checkbox = page.locator('.check input[type="checkbox"]').first();
    await expect(checkbox).toHaveCSS("appearance", "none");
    await expect(checkbox).toHaveCSS("border-top-width", "2px");
    for (const select of await page.locator("select").all()) {
      await expect(select).toHaveClass(/app-select-native/);
      await expect(select).toHaveCSS("opacity", "0");
      await expect(select).toHaveCSS("width", "1px");
    }
    expect(errors).toEqual([]);
  });

  test("event dates use the app calendar and time controls at desktop and mobile widths", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("draft");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    await signIn(page, admin.email);
    await page.getByText("Configure draft", { exact: true }).click();
    const form = page.locator("[data-event-config-form]");

    expect(await page.locator('input[type="date"], input[type="datetime-local"]').count()).toBe(0);
    const dateInput = form.locator('input[name="eventDate"]');
    const dateTrigger = dateInput.locator("xpath=..").locator(".app-date-trigger");
    await expect(dateInput).toHaveClass(/app-date-native/);
    await expect(dateInput).toHaveCSS("opacity", "0");
    await expect(dateInput).toHaveCSS("width", "1px");
    await expect(dateTrigger).toBeVisible();
    await dateTrigger.click();
    const datePanel = dateInput.locator("xpath=..").locator(".app-date-panel");
    await expect(datePanel).toBeVisible();
    await datePanel.getByRole("button", { name: "Next month" }).click();
    const targetDate = await datePanel.locator(".app-date-day").filter({ hasText: /^15$/ }).getAttribute("data-date-value");
    await datePanel.locator(`[data-date-value="${targetDate}"]`).click();
    await expect(datePanel).toBeHidden();
    await expect(dateInput).toHaveValue(targetDate);
    await expect(dateTrigger.locator(".app-date-value")).not.toHaveText(targetDate);
    await expect(dateTrigger).toHaveAttribute("aria-label", /Event date: .+/);
    await dateTrigger.click();
    await expect(datePanel).toBeVisible();
    await dateInput.evaluate((input) => { input.value = input.value; });
    await expect(datePanel).toBeVisible();
    await expect(datePanel.locator(".app-date-day:focus")).toHaveCount(1);
    await dateInput.evaluate((input) => { input.value = "2026-12-01"; });
    await expect(datePanel).toBeHidden();
    await expect(dateTrigger).toBeFocused();
    await expect(dateTrigger).toHaveAttribute("aria-label", /Event date: Dec 1, 2026/);
    await dateInput.evaluate((input) => { input.defaultValue = "2026-12-02"; });
    await dateTrigger.click();
    await form.evaluate((eventForm) => { eventForm.reset(); });
    await expect(dateInput).toHaveValue("2026-12-02");
    await expect(datePanel).toBeHidden();
    await expect(dateTrigger).toBeFocused();

    const datetimeInput = form.locator('input[name="registrationOpensAt"]');
    const datetimeWrapper = datetimeInput.locator("xpath=..");
    const originalDatetime = await datetimeInput.inputValue();
    await datetimeInput.evaluate((input) => { input.defaultValue = input.value; });
    await datetimeWrapper.locator(".app-date-trigger").click();
    const datetimePanel = datetimeWrapper.locator(".app-date-panel");
    const timeFields = datetimePanel.locator(".app-date-time-field");
    await timeFields.nth(0).locator(".app-select-trigger").click();
    await page.keyboard.press("Escape");
    await expect(timeFields.nth(0).locator(".app-select-panel")).toBeHidden();
    await expect(datetimePanel).toBeVisible();
    await timeFields.nth(0).locator(".app-select-trigger").click();
    await timeFields.nth(0).locator(".app-select-option", { hasText: /^10$/ }).click();
    await expect(timeFields.nth(0).locator("select")).toHaveAttribute("data-live-dirty", "true");
    await form.evaluate((eventForm) => { eventForm.reset(); });
    await expect(datetimeInput).toHaveValue(originalDatetime);
    await expect(datetimePanel).toBeHidden();
    await expect(datetimeWrapper.locator(".app-date-trigger")).toBeFocused();
    await expect(timeFields.locator("select[data-live-dirty]")).toHaveCount(0);

    await datetimeWrapper.locator(".app-date-trigger").click();
    const day = datetimePanel.locator(".app-date-day").nth(10);
    await day.focus();
    await page.keyboard.press("ArrowRight");
    const focusedDay = datetimePanel.locator(".app-date-day:focus");
    const datetimeDate = await focusedDay.getAttribute("data-date-value");
    await page.keyboard.press("Enter");
    await expect(datetimePanel.locator('.app-date-day[aria-pressed="true"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(timeFields.nth(0).locator(".app-select-trigger")).toBeFocused();
    await timeFields.nth(0).locator(".app-select-trigger").click();
    await timeFields.nth(0).locator(".app-select-option", { hasText: /^10$/ }).click();
    await timeFields.nth(1).locator(".app-select-trigger").click();
    await timeFields.nth(1).locator(".app-select-option", { hasText: /^37$/ }).click();
    await timeFields.nth(2).locator(".app-select-trigger").click();
    await timeFields.nth(2).locator(".app-select-option", { hasText: /^AM$/ }).click();
    await datetimePanel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(datetimeInput).toHaveValue(`${datetimeDate}T10:37`);
    await expect(datetimePanel).toBeHidden();

    await page.setViewportSize({ width: 320, height: 720 });
    await dateTrigger.click();
    await expect(datePanel).toBeVisible();
    const mobileBox = await datePanel.boundingBox();
    expect(mobileBox.x).toBeGreaterThanOrEqual(0);
    expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(320);
    await expectNoDocumentOverflow(page);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("mobile QR scanning survives the camera permission visibility transition", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const { admin, client } = await bootstrap();
    const duck = await intakeDuck(client, seeded.eventId, 999);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const camera = {
        hidden: false, requests: 0, stops: 0, resolve: null, holdPlay: false, resolvePlay: null,
      };
      globalThis.__qrCameraTest = camera;
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => camera.hidden,
      });
      Object.defineProperty(globalThis, "BarcodeDetector", {
        configurable: true,
        value: class BarcodeDetector {
          static async getSupportedFormats() { return ["qr_code"]; }
          async detect() { return []; }
        },
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia() {
            camera.requests += 1;
            return new Promise((resolve) => {
              camera.resolve = () => resolve({
                getTracks: () => [{ stop: () => { camera.stops += 1; } }],
              });
            });
          },
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        configurable: true,
        get() { return this.__qrStream || null; },
        set(value) { this.__qrStream = value; },
      });
      Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value() {
          if (!camera.holdPlay) return Promise.resolve();
          return new Promise((resolve) => { camera.resolvePlay = resolve; });
        },
      });
      let liveHub;
      Object.defineProperty(globalThis, "quickDucksLive", {
        configurable: true,
        get: () => liveHub,
        set(hub) {
          const subscribe = hub.subscribe.bind(hub);
          hub.subscribe = (options) => {
            const subscription = subscribe(options);
            if (options.domains.includes("ducks") && options.domains.includes("participants")) {
              camera.refresh = subscription.refresh;
            }
            return subscription;
          };
          liveHub = hub;
        },
      });
    });

    await signIn(page, admin.email, `/staff/ducks/${duck.tagToken}`);
    await page.getByRole("button", { name: "Scan QR code" }).click();
    const scanner = page.locator("[data-qr-scanner]");
    await expect(scanner).toBeVisible();
    await page.waitForFunction(() => globalThis.__qrCameraTest.requests === 1);

    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(scanner).toBeVisible();
    await expect(page.locator("[data-qr-message]")).toHaveText("Starting the camera…");
    await page.waitForTimeout(2250);
    await expect(scanner).toBeVisible();
    expect(await page.evaluate(() => globalThis.__qrCameraTest.stops)).toBe(0);

    await page.evaluate(() => { globalThis.__qrCameraTest.resolve(); });
    await expect(page.locator("[data-qr-message]")).toHaveText("Point the camera at the participant's QR code.");
    await page.waitForTimeout(500);
    await expect(scanner).toBeVisible();
    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(750);
    await expect(scanner).toBeVisible();
    expect(await page.evaluate(() => globalThis.__qrCameraTest.stops)).toBe(0);

    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(scanner).toBeHidden({ timeout: 3500 });
    expect(await page.evaluate(() => globalThis.__qrCameraTest.stops)).toBe(1);

    // Once permission returns a stream, real backgrounding must still stop it
    // even when iOS delays the video play promise.
    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = false;
      globalThis.__qrCameraTest.holdPlay = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByRole("button", { name: "Scan QR code" }).click();
    await page.waitForFunction(() => globalThis.__qrCameraTest.requests === 2);
    await page.evaluate(() => { globalThis.__qrCameraTest.resolve(); });
    await page.waitForFunction(() => typeof globalThis.__qrCameraTest.resolvePlay === "function");
    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(scanner).toBeHidden({ timeout: 3500 });
    expect(await page.evaluate(() => globalThis.__qrCameraTest.stops)).toBe(2);
    await page.evaluate(() => { globalThis.__qrCameraTest.resolvePlay(); });

    let releaseFailedLoad;
    let markFailedLoadArrived;
    let loadRequests = 0;
    const failedLoadGate = new Promise((resolve) => { releaseFailedLoad = resolve; });
    const failedLoadArrived = new Promise((resolve) => { markFailedLoadArrived = resolve; });
    await page.route(`**/api/v1/staff/ducks/${duck.tagToken}`, async (route) => {
      loadRequests += 1;
      if (loadRequests === 1) {
        markFailedLoadArrived();
        await failedLoadGate;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Review test denied refresh." }),
        });
        return;
      }
      await route.continue();
    });
    await page.evaluate(() => {
      globalThis.__qrCameraTest.hidden = false;
      globalThis.__qrCameraTest.holdPlay = false;
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.__qrCameraTest.loadPromise = globalThis.__qrCameraTest.refresh();
    });
    await failedLoadArrived;
    await page.getByRole("button", { name: "Scan QR code" }).click();
    await page.waitForFunction(() => globalThis.__qrCameraTest.requests === 3);
    await page.evaluate(() => { globalThis.__qrCameraTest.resolve(); });
    await expect(page.locator("[data-qr-message]")).toHaveText("Point the camera at the participant's QR code.");
    await page.evaluate(async () => {
      await Promise.all([
        globalThis.__qrCameraTest.refresh(),
        globalThis.__qrCameraTest.refresh(),
      ]);
    });
    releaseFailedLoad();
    await page.evaluate(() => globalThis.__qrCameraTest.loadPromise);
    await expect(scanner).toBeVisible();
    expect(await page.evaluate(() => globalThis.__qrCameraTest.stops)).toBe(2);
    await page.locator("[data-registration-search-status]").evaluate((status) => {
      status.textContent = "Waiting for resumed search.";
    });
    const resumedResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith(`/api/v1/staff/ducks/${duck.tagToken}`) && response.status() === 200
    ));
    await page.locator("[data-qr-cancel]").click();
    const resumedResponse = await resumedResponsePromise;
    await resumedResponse.finished();
    await expect(scanner).toBeHidden();
    await expect(page.locator("[data-registration-search-status]")).not.toHaveText("Waiting for resumed search.");
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    expect(loadRequests).toBe(2);
    await page.unroute(`**/api/v1/staff/ducks/${duck.tagToken}`);
    expect(errors).toEqual([
      "console: Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
  });

  test("Delete event is an administrator-only typed-confirmation dialog", async ({ browser }) => {
    const seeded = await seedState("draft");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const director = seeded.accounts.find((account) => account.roles.includes("RACE_DIRECTOR"));

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, admin.email);
    const open = adminPage.locator("[data-open-force-delete]");
    await expect(open).toBeVisible();
    await expect(adminPage.getByText("Delete empty draft", { exact: true })).toHaveCount(0);
    await expect(adminPage.locator("[data-delete-draft-card], [data-delete-draft-form]")).toHaveCount(0);
    await expect(adminPage.locator("details[data-force-delete-card]")).toHaveCount(0);
    await open.click();
    const dialog = adminPage.locator("[data-force-delete-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Permanently delete this event?" })).toBeVisible();
    const finalDelete = dialog.getByRole("button", { name: "Delete event", exact: true });
    const confirmation = dialog.locator('input[name="confirmName"]');
    await expect(finalDelete).toBeDisabled();
    await confirmation.fill("Wrong event");
    await expect(finalDelete).toBeDisabled();
    await confirmation.fill(seeded.event.name);
    await expect(finalDelete).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(confirmation).not.toHaveAttribute("data-live-dirty");

    let releaseRequest;
    let markRequestArrived;
    const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
    const requestArrived = new Promise((resolve) => { markRequestArrived = resolve; });
    await adminPage.route("**/api/v1/staff/events/*/force-delete", async (route) => {
      markRequestArrived();
      await requestGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Review test blocked deletion." }),
      });
    });
    await open.click();
    await confirmation.fill(seeded.event.name);
    await finalDelete.click();
    await requestArrived;
    await expect(dialog.locator("[data-force-delete-message]")).toHaveText("Permanently deleting event…");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(confirmation).toBeDisabled();
    await adminPage.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    releaseRequest();
    await expect(dialog.locator("[data-force-delete-message]")).toHaveText("Review test blocked deletion.");
    await expect(dialog.locator("[data-force-delete-message]")).toHaveClass(/error-text/);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await expect(confirmation).toBeEnabled();
    await adminPage.unroute("**/api/v1/staff/events/*/force-delete");

    let releaseRetry;
    let markRetryArrived;
    const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
    const retryArrived = new Promise((resolve) => { markRetryArrived = resolve; });
    await adminPage.route("**/api/v1/staff/events/*/force-delete", async (route) => {
      markRetryArrived();
      await retryGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Review retry blocked deletion." }),
      });
    });
    await finalDelete.click();
    await retryArrived;
    await expect(dialog.locator("[data-force-delete-message]")).toHaveText("Permanently deleting event…");
    await expect(dialog.locator("[data-force-delete-message]")).not.toHaveClass(/error-text/);
    releaseRetry();
    await expect(dialog.locator("[data-force-delete-message]")).toHaveText("Review retry blocked deletion.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await adminPage.unroute("**/api/v1/staff/events/*/force-delete");
    await adminContext.close();

    const directorContext = await browser.newContext();
    const directorPage = await directorContext.newPage();
    // A race director opens the Admin view — that is the role that runs the
    // race — but Delete event is administrator-only, so the card and its dialog
    // are rendered on no page they can open.
    await signIn(directorPage, director.email);
    await expect(directorPage).toHaveURL(`${baseUrl}/staff`);
    await expect(directorPage.getByRole("heading", { name: "Race control, in one place." })).toBeVisible();
    await expect(directorPage.locator("[data-open-force-delete], [data-force-delete-dialog]")).toHaveCount(0);
    await directorPage.goto("/staff/registration");
    await expect(directorPage.locator("[data-open-force-delete], [data-force-delete-dialog]")).toHaveCount(0);
    await directorContext.close();
  });

  test("public primary panels keep the same paper surface color", async ({ page }) => {
    await seedState("round-one");
    await page.goto("/race");
    await expect(page.locator(".page-panel")).toHaveCSS("background-color", "rgb(255, 253, 243)");
    await expect(page.locator(".live-board")).toHaveCSS("background-color", "rgb(255, 253, 243)");
  });

  test("the home page puts the race action in the section named after the race", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await seedState("registration");
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1, name: "Find your duck. Cheer it home." })).toBeVisible();
    await expect(page.locator(".hero .lede").first()).toHaveText(
      "A friendly home for the small races that bring a whole town down to the water."
      + " Built for the volunteers, families, and rubber ducks that make race day happen.",
    );
    await expect(page.locator(".ticker span")).toHaveText(["Pick your duck", "Find your heat", "Cheer loudly"]);

    // The How it works button is gone; the cards it jumped to are still here.
    await expect(page.getByRole("link", { name: "How it works" })).toHaveCount(0);
    await expect(page.locator("#how-it-works")).toBeVisible();

    // The hero holds no action at all, and the only call to action on the page
    // is the primary action of the section the live client titles with the
    // event's own name, ahead of the secondary board link.
    await expect(page.locator(".hero a")).toHaveCount(0);
    const summary = page.locator("[data-live-summary]");
    await expect(summary.locator("[data-live-summary-title]")).toHaveText("Harbor Duck Derby");
    const cta = summary.locator("[data-home-cta]");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Register");
    await expect(cta).toHaveAttribute("href", "/register");
    await expect(page.locator("[data-home-cta]")).toHaveCount(1);
    await expect(summary.locator(".actions a")).toHaveText(["Register", "Open the full race board"]);

    await cta.click();
    await expect(page.locator("[data-registration-form]")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("race status redirects home while a race is only being prepared", async ({ page }) => {
    await seedState("empty");
    const direct = await page.goto("/race");
    expect(direct.request().redirectedFrom()).not.toBeNull();
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.getByText(/The next race is being prepared/)).toBeVisible();
    await expect(page.locator("[data-race-preparing]")).toHaveCount(0);

    // Once a race exists, the same URL renders the board again.
    await seedState("round-one");
    await page.goto("/race");
    await expect(page).toHaveURL(`${baseUrl}/race`);
    await expect(page.locator("[data-live-board]")).toBeVisible();
  });

  test("a just-registered card looks exactly like a plain refresh, before and after pairing", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const { client } = await bootstrap();

    await page.goto("/register");
    const form = page.locator("[data-registration-form]");
    await form.getByLabel("First name").fill("Plain");
    await form.getByLabel("Last name").fill("Cardholder");
    await form.getByRole("button", { name: "Register participant" }).click();
    // The `?registered=` handoff is consumed and cleaned out of the URL as soon
    // as the collection response arrives, so the landing URL is the bare page.
    await expect(page).toHaveURL(`${baseUrl}/my-ducks`);

    // The one-time notice still carries the private status link; it just no
    // longer promises a highlight.
    const notice = page.locator("[data-registration-success]");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Registration saved.");
    await expect(notice).toContainText("Plain Cardholder");
    await expect(notice).not.toContainText("highlighted");
    await expect(notice.getByRole("link", { name: "Open private status" })).toBeVisible();
    await expect(notice).toHaveClass(/\bnotice\b/);

    const card = page.locator('[data-registration-id]', { hasText: "Plain Cardholder" });
    const plainBackground = "rgb(255, 255, 255)";
    await expect(card).toHaveClass("duck-card participant-card");
    await expect(card).toHaveCSS("background-color", plainBackground);
    await expect(card.locator(".success-tag")).toHaveCount(0);
    await expect(card).not.toContainText("Just registered");
    expect(await card.getAttribute("aria-current")).toBeNull();
    expect(await card.evaluate((node) => node === document.activeElement)).toBe(false);

    // Pairing must not bring the highlight back on the paired card either.
    const registrations = (await client.get(
      `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("Cardholder")}`,
    )).body.registrations;
    const created = registrations.find((registration) => registration.lastName === "Cardholder");
    expect(created).toBeTruthy();
    const duck = await intakeDuck(client, seeded.eventId, 401);
    await pairDuck(client, seeded.eventId, duck, created);

    await page.reload();
    const pairedCard = page.locator('[data-participant-section="paired"] [data-registration-id]', {
      hasText: "Plain Cardholder",
    });
    await expect(pairedCard).toHaveClass("duck-card participant-card");
    await expect(pairedCard).toHaveCSS("background-color", plainBackground);
    await expect(pairedCard.locator(".success-tag")).toHaveCount(0);
    await expect(pairedCard).not.toContainText("Just registered");

    // A followed participant keeps its own pill, so the removal was surgical.
    await page.locator("[data-status-search] input[name='name']").fill(
      `${seeded.participants[0].firstName} ${seeded.participants[0].lastName}`,
    );
    await page.locator("[data-status-search]").getByRole("button", { name: "Find status" }).click();
    await page.locator("[data-search-results]").getByRole("button", { name: "Add to My Ducks" }).first().click();
    await expect(
      page.locator('[data-participant-section="followed"] .success-tag').first(),
    ).toHaveText("Following");
    expect(errors).toEqual([]);
  });

  test("the home duck bobs through a water slit without covering mobile hero copy", async ({ page }) => {
    await seedState("registration");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    // The hero carries copy and artwork only now, so the duck must clear the
    // copy block that used to be protected through its action row.
    const heroCopy = page.locator(".hero-copy");
    const scene = page.locator(".hero-duck-scene");
    const duck = page.locator(".hero-duck");
    const slit = page.locator(".hero-duck-slit");
    const water = page.locator(".hero-water");
    const expectSlitComposition = async () => {
      const [duckBox, slitBox, waterBox] = await Promise.all([
        duck.boundingBox(),
        slit.boundingBox(),
        water.boundingBox(),
      ]);
      const visibleDuckBottom = duckBox.y + duckBox.height * (68.5 / 76);
      expect(duckBox.y).toBeLessThan(waterBox.y);
      expect(slitBox.y).toBeGreaterThan(waterBox.y + 16);
      expect(slitBox.y).toBeLessThan(visibleDuckBottom);
    };
    await expect(duck).toHaveCSS("animation-name", "duck-bob");
    await expect(duck).toHaveCSS("animation-duration", "2.8s");
    await expect(water).toBeVisible();
    await expect(scene).toHaveCSS("z-index", "2");
    await expect(water).toHaveCSS("z-index", "1");
    await expect(slit).toHaveCSS("z-index", "2");
    await expect(slit).toHaveCSS("animation-name", "none");
    // The hero holds no action row at all; the phase CTA lives with the race.
    await expect(page.locator(".hero .actions")).toHaveCount(0);
    await expect(page.locator(".hero a")).toHaveCount(0);
    await expectSlitComposition();
    const [heroBox, desktopSceneBox, desktopSlitBox, desktopWaterBox] = await Promise.all([
      page.locator(".hero").boundingBox(),
      scene.boundingBox(),
      slit.boundingBox(),
      water.boundingBox(),
    ]);
    // The 2.5rem offset is measured from the hero's inner border edge.
    expect(heroBox.y + heroBox.height - desktopSceneBox.y - desktopSceneBox.height).toBeCloseTo(43, 0);
    expect(desktopSlitBox.y).toBeGreaterThan(desktopWaterBox.y + 64);

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(duck).toHaveCSS("animation-name", "duck-bob");
      await expectSlitComposition();
      const [copyBox, duckBox] = await Promise.all([
        heroCopy.boundingBox(),
        duck.boundingBox(),
      ]);
      const visibleDuckTop = duckBox.y + duckBox.height * (8 / 76);
      const visibleDuckBottom = duckBox.y + duckBox.height * (68.5 / 76);
      const slitBox = await slit.boundingBox();
      expect(visibleDuckTop).toBeGreaterThan(copyBox.y + copyBox.height + 16);
      expect(visibleDuckBottom - slitBox.y).toBeGreaterThan(4);
      expect(visibleDuckBottom - slitBox.y).toBeLessThan(24);
    }

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(duck).toHaveCSS("animation-name", "none");
  });
});
