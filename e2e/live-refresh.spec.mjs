import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  confirmAction,
  finalizeHeat,
  intakeDuck,
  pairDuck,
  rejectSensitiveKeys,
  seedState,
  signIn,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

const waitForJson = (page, pathname, predicate, timeout = 12_000) => page.waitForResponse(async (response) => {
  const url = new URL(response.url());
  if (response.request().method() !== "GET" || url.pathname !== pathname || response.status() !== 200) return false;
  const body = await response.json().catch(() => null);
  return predicate(body);
}, { timeout });

test.describe("authoritative live refresh", () => {
  test("opens registration, refreshes participants, inventory, pairing, and rejects an older response", async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const seeded = await seedState("draft");
    const { admin, client } = await bootstrap();
    const publicContext = await browser.newContext({
      extraHTTPHeaders: { "cf-connecting-ip": `198.51.100.${40 + testInfo.retry}` },
    });
    const staffContext = await browser.newContext();
    const pages = [];
    const errors = [];
    const openPage = async (context, { watchErrors = true } = {}) => {
      const page = await context.newPage();
      pages.push(page);
      if (watchErrors) errors.push(watchBrowserErrors(page));
      return page;
    };

    const homePage = await openPage(publicContext);
    const controlPage = await openPage(staffContext);
    await homePage.goto("/");
    await expect(homePage.locator("[data-home-preparing]")).toHaveText("The next race is being prepared.");
    await expect(homePage.locator("[data-home-cta]")).toHaveCount(0);

    await signIn(controlPage, admin.email);
    const openedBoard = waitForJson(
      homePage,
      "/api/v1/race-board",
      (body) => body?.event?.status === "REGISTRATION_OPEN",
    );
    await controlPage.getByRole("button", { name: "Open registration", exact: true }).click();
    await confirmAction(controlPage);
    // Background tabs intentionally defer ordinary live refetches. Make each
    // observed surface visible before awaiting the request that visibility
    // recovery starts; this still exercises an already-open document and never
    // reloads or revisits it.
    await homePage.bringToFront();
    await openedBoard;

    // The untouched Preparing document becomes the public event, including the
    // phase navigation and action. No test-driven navigation or reload occurs.
    await expect(homePage.locator("[data-live-summary-title]")).toHaveText("Harbor Duck Derby");
    await expect(homePage.locator("[data-live-summary-stage]")).toHaveText("Participant registration open");
    await expect(homePage.locator("[data-home-preparing]")).toHaveCount(0);
    await expect(homePage.locator("[data-home-cta]")).toHaveText("Register");
    await expect(homePage.locator("[data-home-cta]")).toHaveAttribute("href", "/register");
    await expect(homePage.locator("[data-nav-register]")).toBeVisible();
    await expect(homePage.locator("[data-nav-race]")).toHaveCount(0);

    await controlPage.goto("/staff#participants");
    await expect(controlPage.getByRole("heading", { name: "Participants", exact: true })).toBeVisible();
    await expect(controlPage.locator("[data-participant-list]")).toContainText("No participants match these filters.");

    const inventoryPage = await openPage(staffContext);
    await inventoryPage.goto("/staff/inventory");
    await expect(inventoryPage.locator("[data-console-message]")).toHaveText("Inventory is current.");
    const inventoryRefresh = waitForJson(
      inventoryPage,
      "/api/v1/staff/inventory/ducks",
      (body) => body?.ducks?.some((duck) => duck.visibleNumber === 901) === true,
    );
    const duck = await intakeDuck(client, seeded.eventId, 901);
    await inventoryRefresh;
    const inventoryDuck = inventoryPage.getByRole("button", { name: /Duck #901/ });
    await expect(inventoryDuck).toBeVisible();
    await inventoryDuck.click();
    await expect(inventoryPage.locator("[data-inventory-name]")).toHaveText("Duck #901");

    const duckPage = await openPage(staffContext);
    await duckPage.goto(`/staff/ducks/${duck.tagToken}`);
    await expect(duckPage.locator("[data-registration-search-status]")).toContainText("already has a duck");
    const publicDuckPage = await openPage(publicContext, { watchErrors: false });
    await publicDuckPage.goto("/duck/901");
    await expect(publicDuckPage.getByRole("heading", { name: "Duck #901 isn’t racing." })).toBeVisible();
    // The privacy-neutral unresolved state intentionally returns HTTP 404.
    // Begin error collection after that expected navigation so subsequent live
    // recovery errors still fail the test without treating the contract as one.
    errors.push(watchBrowserErrors(publicDuckPage));

    // Capture an old participant response and hold it after a newer live read.
    // Releasing it later proves the shared request generation guard, not only
    // the happy-path signal refresh.
    let releaseOld;
    let oldCapturedResolve;
    let oldFinishedResolve;
    const oldGate = new Promise((resolve) => { releaseOld = resolve; });
    const oldCaptured = new Promise((resolve) => { oldCapturedResolve = resolve; });
    const oldFinished = new Promise((resolve) => { oldFinishedResolve = resolve; });
    let delayNextParticipantList = true;
    await controlPage.route((url) =>
      url.pathname === `/api/v1/staff/events/${seeded.eventId}/registrations`, async (route) => {
      if (!delayNextParticipantList) {
        await route.continue();
        return;
      }
      delayNextParticipantList = false;
      const response = await route.fetch();
      oldCapturedResolve();
      await oldGate;
      await route.fulfill({ response });
      oldFinishedResolve();
    });
    await controlPage.bringToFront();
    await controlPage.locator("[data-participant-filter-form]")
      .getByRole("button", { name: "List participants" }).click();
    await oldCaptured;

    const registrationPage = await openPage(publicContext);
    await registrationPage.goto("/register");
    await registrationPage.getByLabel("First name").fill("Live");
    await registrationPage.getByLabel("Last name").fill("Observer");
    await registrationPage.getByLabel(/Email/).fill("live.observer@example.test");
    const participantRefresh = controlPage.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (response.request().method() !== "GET"
        || url.pathname !== `/api/v1/staff/events/${seeded.eventId}/registrations`
        || response.status() !== 200) return false;
      const body = await response.json().catch(() => null);
      return body?.registrations?.some((registration) =>
        registration.firstName === "Live" && registration.lastName === "Observer") === true;
    }, { timeout: 12_000 });
    await registrationPage.getByRole("button", { name: "Register participant" }).click();
    await expect(registrationPage).toHaveURL(`${baseUrl}/my-ducks`);
    await controlPage.bringToFront();
    await participantRefresh;
    await expect(controlPage.locator("[data-participant-list]")).toContainText("Live Observer");
    await duckPage.bringToFront();
    await expect(duckPage.locator("[data-registration-results]")).toContainText("Live Observer");

    releaseOld();
    await oldFinished;
    await expect(controlPage.locator("[data-participant-list]")).toContainText("Live Observer");

    const registrations = (await client.get(
      `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("live.observer@example.test")}`,
    )).body.registrations;
    const created = registrations.find((registration) => registration.email === "live.observer@example.test");
    expect(created).toBeTruthy();

    const pairedCollection = waitForJson(
      registrationPage,
      "/api/v1/registrations/mine",
      (body) => body?.registrations?.some((registration) =>
        registration.registrationId === created.registrationId && registration.paired === true) === true,
    );
    const inventoryDuckId = (await client.get("/api/v1/staff/inventory/ducks")).body.ducks
      .find((item) => item.visibleNumber === 901).id;
    await pairDuck(client, seeded.eventId, duck, created);
    await registrationPage.bringToFront();
    await pairedCollection;
    await expect(registrationPage.locator(
      `[data-participant-section="paired"] [data-registration-id="${created.registrationId}"]`,
    )).toBeVisible();
    const pairedInventory = waitForJson(
      inventoryPage,
      `/api/v1/staff/inventory/ducks/${encodeURIComponent(inventoryDuckId)}`,
      (body) => body?.duck?.participant?.registrationId === created.registrationId,
    );
    await inventoryPage.bringToFront();
    await pairedInventory;
    await expect(inventoryPage.locator("[data-inventory-facts]")).toContainText("Live Observer");
    const publicDuckResolved = waitForJson(
      publicDuckPage,
      "/api/v1/ducks/number/901",
      (body) => body?.raceStatus?.duck?.visibleNumber === 901,
    );
    await publicDuckPage.bringToFront();
    await publicDuckResolved;
    await expect(publicDuckPage.getByRole("heading", { name: "Duck #901" })).toBeVisible();

    expect(errors.flat()).toEqual([]);
    await Promise.all([publicContext.close(), staffContext.close()]);
  });

  test("keeps race progression, station state, and final results current", async ({ browser }) => {
    test.setTimeout(150_000);
    const seeded = await seedState("final");
    const { admin, client } = await bootstrap();
    const publicContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const racePage = await publicContext.newPage();
    const startPage = await staffContext.newPage();
    const announcerPage = await staffContext.newPage();
    const finishPage = await staffContext.newPage();
    const consolePage = await staffContext.newPage();
    const errors = [
      watchBrowserErrors(racePage),
      watchBrowserErrors(startPage),
      watchBrowserErrors(announcerPage),
      watchBrowserErrors(finishPage),
      watchBrowserErrors(consolePage),
    ];

    await racePage.goto("/race");
    await signIn(startPage, admin.email, "/staff/start-line");
    await announcerPage.goto("/staff/announcer");
    await finishPage.goto("/staff/finish-line");
    await consolePage.goto("/staff#heats");
    await startPage.bringToFront();
    await expect(startPage.getByRole("button", { name: "Start This Heat" })).toBeVisible();

    const runningBoard = waitForJson(
      racePage,
      "/api/v1/race-board",
      (body) => body?.event?.currentHeat?.round === "FINAL" && body.event.currentHeat.status === "RUNNING",
    );
    await startPage.getByRole("button", { name: "Start This Heat" }).click();
    await confirmAction(startPage);
    await racePage.bringToFront();
    await runningBoard;
    await expect(racePage.getByText("Racing now", { exact: true }).first()).toBeVisible();
    await announcerPage.bringToFront();
    await expect(announcerPage.locator("[data-announcer-cue]")).toHaveText("Racing now. Call the race.");
    await finishPage.bringToFront();
    await expect(finishPage.getByRole("button", { name: "Mark heat finished" })).toBeVisible();
    await consolePage.bringToFront();
    await expect(consolePage.locator("[data-heat-list]")).toContainText("Final · Heat 1 · Running");

    const finalHeat = (await client.get(`/api/v1/staff/events/${seeded.eventId}/heats`)).body.heats
      .find((heat) => heat.round === "FINAL");
    const runningDetail = (await client.get(
      `/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`,
    )).body;
    Object.assign(finalHeat, runningDetail.heat);
    const awaitingBoard = waitForJson(
      racePage,
      "/api/v1/race-board",
      (body) => body?.event?.currentHeat?.status === "AWAITING_RESULT",
    );
    await transitionHeat(client, seeded.eventId, finalHeat, "finish");
    await racePage.bringToFront();
    await awaitingBoard;
    await expect(racePage.getByText("Race finished; checking the result", { exact: true })).toBeVisible();
    await finishPage.bringToFront();
    await expect(finishPage.locator("[data-station-message]")).toContainText("Scan each finishing duck");
    await consolePage.bringToFront();
    await expect(consolePage.locator("[data-heat-list]")).toContainText("Final · Heat 1 · Awaiting result");

    const results = runningDetail.roster.slice(0, 3)
      .map((entry, index) => ({ raceEntryId: entry.raceEntryId, place: index + 1 }));
    const podiumBoard = waitForJson(
      racePage,
      "/api/v1/race-board",
      (body) => body?.event?.podium?.length === results.length,
    );
    await finalizeHeat(client, seeded.eventId, finalHeat, results);
    await racePage.bringToFront();
    await podiumBoard;
    await expect(racePage.getByRole("heading", { name: "Official podium" })).toBeVisible();
    await announcerPage.bringToFront();
    await expect(announcerPage.getByRole("heading", { name: "The final is decided" })).toBeVisible();
    await finishPage.bringToFront();
    await expect(finishPage.getByRole("heading", { name: "No heat needs the finish line" })).toBeVisible();
    await consolePage.bringToFront();
    await expect(consolePage.locator("[data-heat-list]")).toContainText("Final · Heat 1 · Finalized");

    const completedBoard = waitForJson(
      racePage,
      "/api/v1/race-board",
      (body) => body?.event?.status === "COMPLETED",
    );
    await client.post(`/api/v1/staff/events/${seeded.eventId}/complete`, {
      commandId: crypto.randomUUID(),
    });
    await racePage.bringToFront();
    const completedResponse = await completedBoard;
    rejectSensitiveKeys(await completedResponse.json());
    await expect(racePage.getByText("Results official", { exact: true })).toBeVisible();
    await expect(racePage.locator("[data-nav-race]")).toBeVisible();
    expect(errors.flat()).toEqual([]);

    await Promise.all([publicContext.close(), staffContext.close()]);
  });

  test("deletion resets every already-open public and staff surface to Preparing", async ({ browser }) => {
    test.setTimeout(120_000);
    await seedState("completed");
    const { admin } = await bootstrap();
    const publicContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const homePage = await publicContext.newPage();
    const racePage = await publicContext.newPage();
    const registrationDesk = await staffContext.newPage();
    const inventoryPage = await staffContext.newPage();
    const deletePage = await staffContext.newPage();
    const errors = [homePage, racePage, registrationDesk, inventoryPage, deletePage]
      .map(watchBrowserErrors);

    // This already-open Race Status page cannot receive the deletion signal.
    // Its disconnected integrity poll must still discover the authoritative
    // empty event and recover the server route contract without a test reload.
    await racePage.addInitScript(() => {
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: undefined });
    });
    await homePage.goto("/");
    await racePage.goto("/race");
    await signIn(registrationDesk, admin.email, "/staff/registration");
    await inventoryPage.goto("/staff/inventory");
    await deletePage.goto("/staff");
    await expect(homePage.locator("[data-live-summary-title]")).toHaveText("Harbor Duck Derby");
    await expect(racePage.getByRole("heading", { name: "Official podium" })).toBeVisible();
    await expect(registrationDesk.locator("[data-participant-list] .result-button").first()).toBeVisible();
    await expect(inventoryPage.getByRole("button", { name: /Duck #101/ })).toBeVisible();

    await deletePage.locator("[data-open-force-delete]").click();
    const dialog = deletePage.locator("[data-force-delete-dialog]");
    await dialog.locator('input[name="confirmName"]').fill("Harbor Duck Derby");
    await dialog.getByRole("button", { name: "Delete event", exact: true }).click();

    // The application may safely navigate/re-render itself after the `all`
    // signal; the test never reloads or revisits an observed page.
    await expect(homePage.locator("[data-home-preparing]")).toHaveText("The next race is being prepared.");
    await expect(homePage.locator("[data-home-cta]")).toHaveCount(0);
    await expect(homePage.locator("[data-nav-register], [data-nav-race]")).toHaveCount(0);
    await expect(racePage).toHaveURL(`${baseUrl}/`, { timeout: 15_000 });
    await expect(racePage.locator("[data-home-preparing]")).toBeVisible();
    await expect(racePage.getByText("Harbor Duck Derby")).toHaveCount(0);
    await expect(registrationDesk.getByText("No race yet.", { exact: true })).toBeVisible();
    await expect(registrationDesk.locator("[data-participant-list] .result-button")).toHaveCount(0);
    await expect(inventoryPage.getByText("No race yet.", { exact: true })).toBeVisible();
    await expect(inventoryPage.getByRole("button", { name: /Duck #101/ })).toHaveCount(0);
    expect(errors.flat()).toEqual([]);

    await Promise.all([publicContext.close(), staffContext.close()]);
  });
});
