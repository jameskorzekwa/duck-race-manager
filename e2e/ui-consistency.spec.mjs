import { expect, test } from "@playwright/test";

import {
  expectNoDocumentOverflow,
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

  test("Delete event is an administrator-only typed-confirmation dialog", async ({ browser }) => {
    const seeded = await seedState("draft");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const director = seeded.accounts.find((account) => account.roles.includes("RACE_DIRECTOR"));

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, admin.email);
    const open = adminPage.locator("[data-open-force-delete]");
    await expect(open).toBeVisible();
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
    await signIn(directorPage, director.email);
    await expect(directorPage.locator("[data-open-force-delete], [data-force-delete-dialog]")).toHaveCount(0);
    await directorContext.close();
  });

  test("public primary panels keep the same paper surface color", async ({ page }) => {
    await seedState("round-one");
    await page.goto("/race");
    await expect(page.locator(".page-panel")).toHaveCSS("background-color", "rgb(255, 253, 243)");
    await expect(page.locator(".live-board")).toHaveCSS("background-color", "rgb(255, 253, 243)");
  });
});
