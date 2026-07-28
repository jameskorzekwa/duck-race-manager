import { expect, test } from "@playwright/test";

import {
  accountWith,
  baseUrl,
  confirmAction,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

const menuLink = (page, name) =>
  page.getByRole("navigation", { name: "Admin views" }).getByRole("link", { name, exact: true });

// Exactly one Admin view is displayed at a time, so this reads the whole set
// rather than asserting one section in isolation.
const visibleViews = async (page) => {
  const views = await page.locator("[data-console-view]").all();
  const shown = [];
  for (const view of views) {
    if (await view.isVisible()) shown.push(await view.getAttribute("data-console-view"));
  }
  return shown;
};

const participantRow = (page, name) =>
  page.locator("[data-participant-list] button", { hasText: name }).first();

const actionLabels = async (page) =>
  page.locator("[data-participant-actions] button").allTextContents();

test.describe("staff roles and the Admin views", () => {
  test("an administrator switches Admin views from the menu bar, the hash, and history", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    await signIn(page, admin.email);

    // The menu bar lists the six Admin items, in order.
    const menu = page.getByRole("navigation", { name: "Admin views" });
    await expect(menu.getByRole("link")).toHaveText([
      "Event Details",
      "Heats",
      "Participants",
      "Inventory",
      "Support",
      "Access",
    ]);

    // Event Details is the default view and the only one displayed.
    await expect(menuLink(page, "Event Details")).toHaveAttribute("aria-current", "page");
    await expect.poll(() => visibleViews(page)).toEqual(["event"]);

    // Clicking a menu item switches which view is displayed and moves the mark.
    await menuLink(page, "Heats").click();
    await expect(page).toHaveURL(`${baseUrl}/staff#heats`);
    await expect.poll(() => visibleViews(page)).toEqual(["heats"]);
    await expect(menuLink(page, "Heats")).toHaveAttribute("aria-current", "page");
    await expect(menuLink(page, "Event Details")).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Heats and results" })).toBeVisible();

    await menuLink(page, "Participants").click();
    await expect.poll(() => visibleViews(page)).toEqual(["participants"]);
    await expect(page.locator("[data-participant-filter-form]")).toBeVisible();

    await menuLink(page, "Support").click();
    await expect.poll(() => visibleViews(page)).toEqual(["support"]);

    // Back and forward walk the same views, because the switch is a hash change.
    await page.goBack();
    await expect.poll(() => visibleViews(page)).toEqual(["participants"]);
    await page.goBack();
    await expect.poll(() => visibleViews(page)).toEqual(["heats"]);
    await page.goForward();
    await expect.poll(() => visibleViews(page)).toEqual(["participants"]);

    // A view is linkable: a cold load of the hash lands on it, and so does a
    // reload, even though the event has to be fetched before it is available.
    await page.goto("/staff#heats");
    await expect.poll(() => visibleViews(page)).toEqual(["heats"]);
    await page.reload();
    await expect.poll(() => visibleViews(page)).toEqual(["heats"]);

    // Data loading does not depend on the displayed view: the Participants view
    // was populated while hidden.
    await menuLink(page, "Participants").click();
    await expect(page.locator("[data-participant-list] button").first()).toBeVisible();

    // Inventory and Access are pages, and both render the same menu bar back.
    await menuLink(page, "Inventory").click();
    await expect(page).toHaveURL(`${baseUrl}/staff/inventory`);
    await expect(menuLink(page, "Inventory")).toHaveAttribute("aria-current", "page");
    await menuLink(page, "Event Details").click();
    await expect(page).toHaveURL(`${baseUrl}/staff#event`);
    await expect.poll(() => visibleViews(page)).toEqual(["event"]);

    expect(errors).toEqual([]);
  });

  test("a registration staffer runs the desk from /staff/registration", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const desk = accountWith(seeded.accounts, "REGISTRATION");

    // Signing in returns to `/staff`, which must not dead-end a regular staff
    // member: it sends them to the page their own role opens.
    await signIn(page, desk.email, "/staff/registration");
    await page.goto("/staff");
    await expect(page).toHaveURL(`${baseUrl}/staff/registration`);

    // The desk explains both ways in, in race-day language.
    await expect(page.getByRole("heading", { name: "Someone walked up" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Give them their duck" })).toBeVisible();
    await expect(page.getByText("Pairing order matters.")).toBeVisible();
    await expect(page.getByText(/Let the participant choose a physical duck/)).toBeVisible();

    // The whole participants surface is here, not a reduced copy of it.
    await expect(page.locator("[data-participant-filter-form]")).toBeVisible();
    await expect(page.locator("[data-participant-list] button").first()).toBeVisible();

    // Create a walk-up participant.
    await page.locator("summary", { hasText: "Add walk-up participant" }).click();
    const walkUp = page.locator("[data-walkup-form]");
    await walkUp.getByLabel("First name").fill("Walkup");
    await walkUp.getByLabel("Last name").fill("Racer");
    await walkUp.getByRole("button", { name: "Create walk-up" }).click();
    await expect(page.locator("[data-walkup-result]")).toContainText("Lookup code:");

    // The new participant opens in the detail card and can be edited from here.
    const detail = page.locator("[data-participant-detail]");
    await expect(detail).toBeVisible();
    await expect(detail.locator("[data-participant-name]")).toHaveText("Walkup Racer");
    const edit = page.locator("[data-participant-edit-form]");
    await edit.getByLabel("Phone").fill("+15550209999");
    await edit.getByRole("button", { name: "Save participant details" }).click();

    // The console message line is refreshed by live signals, so the edit is
    // proven against the authoritative API rather than against a transient line.
    await expect.poll(async () => {
      const listed = await rawJson(
        `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("Walkup")}`,
        { token: desk.token },
      );
      expect(listed.status).toBe(200);
      return listed.body.registrations[0]?.phone;
    }).toBe("+15550209999");

    // The desk has no Admin menu bar and no Admin link at all.
    await expect(page.locator(".console-nav")).toHaveCount(0);
    await expect(page.locator('.staff-nav a[href="/staff"]')).toHaveCount(0);
    await expect(page.locator('.staff-nav a[href="/staff/registration"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("delete is offered only before pairing and withdraw or disqualify only after it", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const paired = seeded.participants.find((participant) => participant.visibleNumber !== undefined);
    const unpaired = seeded.participants.find((participant) => participant.visibleNumber === undefined);
    expect(paired && unpaired).toBeTruthy();

    await signIn(page, admin.email);
    await menuLink(page, "Participants").click();
    await expect(page.locator("[data-participant-list] button").first()).toBeVisible();

    // Unpaired: nothing is in the water yet, so removing the registration is the
    // only destructive action offered.
    await participantRow(page, `${unpaired.firstName} ${unpaired.lastName}`).click();
    await expect(page.locator("[data-participant-detail]")).toBeVisible();
    await expect.poll(() => actionLabels(page)).toContain("Delete registration");
    expect(await actionLabels(page)).not.toContain("Withdraw");
    expect(await actionLabels(page)).not.toContain("Disqualify");
    await expect(page.locator("[data-participant-action-note]")).toHaveCount(0);

    // Paired: the duck is sealed in a heat bag, so it stays in the race and only
    // eligibility can change. Delete is not offered at all, and the card says why.
    await participantRow(page, `${paired.firstName} ${paired.lastName}`).click();
    await expect.poll(() => actionLabels(page)).toContain("Withdraw");
    expect(await actionLabels(page)).toContain("Disqualify");
    expect(await actionLabels(page)).not.toContain("Delete registration");
    const note = page.locator("[data-participant-action-note]");
    await expect(note).toBeVisible();
    await expect(note).toContainText(`Duck #${paired.visibleNumber} is already sealed in a heat bag`);
    await expect(note).toContainText("cannot be deleted");

    // Withdrawing keeps the pairing, so the rule survives the status change: a
    // withdrawn paired participant is still undeletable.
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await confirmAction(page);
    await expect.poll(() => actionLabels(page)).toContain("Reactivate");
    expect(await actionLabels(page)).not.toContain("Delete registration");
    await expect(page.locator("[data-participant-action-note]")).toBeVisible();

    // Deleting the unpaired registration really removes it from the list.
    await participantRow(page, `${unpaired.firstName} ${unpaired.lastName}`).click();
    await page.getByRole("button", { name: "Delete registration", exact: true }).click();
    await confirmAction(page);
    await expect(
      page.locator("[data-participant-list] button", { hasText: `${unpaired.firstName} ${unpaired.lastName}` }),
    ).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("the Create event card is shown only while no event exists", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("empty");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    await signIn(page, admin.email);

    const createCard = page.locator("[data-event-create-card]");
    const createForm = page.locator("[data-event-create-form]");
    await expect(createCard).toBeVisible();
    await expect(createForm).toBeVisible();

    const eventDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    await createForm.getByLabel("Event name").fill("Playwright Gating Derby");
    const dateInput = createForm.locator('input[name="eventDate"]');
    const datePicker = dateInput.locator("xpath=..");
    await datePicker.locator(".app-date-trigger").click();
    const datePanel = datePicker.locator(".app-date-panel");
    if (await datePanel.locator(`[data-date-value="${eventDate}"]`).count() === 0) {
      await datePanel.getByRole("button", { name: "Next month" }).click();
    }
    await datePanel.locator(`[data-date-value="${eventDate}"]`).click();
    await createForm.getByLabel("Ducks per heat").fill("3");
    await createForm.getByRole("button", { name: "Create draft event" }).click();

    // Gone immediately, and gone in the served page after a reload: creating a
    // second dataset is refused anyway, so the card is never offered again.
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    await expect(createCard).toBeHidden();
    await expect(createForm).toBeHidden();
    await page.reload();
    await expect(page.locator("[data-event-detail]")).toBeVisible();
    await expect(createCard).toBeHidden();
    // Hidden, not merely dimmed: nothing inside it is submittable.
    expect(await createCard.evaluate((card) => card.hasAttribute("hidden"))).toBe(true);
    expect(await createCard.evaluate((card) => card.open)).toBe(false);

    // Deleting the event brings it straight back, with no manual reload.
    const events = await rawJson("/api/v1/staff/events", { token: admin.token });
    const event = events.body.events[0];
    const deleted = await rawJson(`/api/v1/staff/events/${event.id}/force-delete`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: event.revision, confirmName: event.name },
    });
    expect(deleted.status).toBe(200);
    await expect(createCard).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("No race yet.")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
