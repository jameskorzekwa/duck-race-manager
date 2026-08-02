import { expect, test } from "@playwright/test";

import {
  accountWith,
  baseUrl,
  bootstrap,
  confirmAction,
  finalizeHeat,
  intakeDuck,
  pairDuck,
  rawJson,
  registerParticipant,
  seedState,
  signIn,
  transitionHeat,
  unassignDuck,
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

  // `is_system_admin` is an account type. `RACE_DIRECTOR` is the race-day role
  // for changing the state of the overall race, and every control that does so —
  // the five lifecycle transitions, the heats, the rosters, the result
  // corrections, finalist verification — lives only inside the Admin view. So a
  // race director who is not an administrator has to be able to open it and run
  // the whole race from it, while still seeing none of its administrator-only
  // surfaces.
  test("a race director who is not an administrator runs the whole lifecycle from /staff", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("draft");
    const director = accountWith(seeded.accounts, "RACE_DIRECTOR");
    expect(director.isSystemAdmin, "the race director must be a regular staff account").toBe(false);

    // Every API call below runs as the race director too, so the page and the
    // handlers are proven against the same least-privileged actor.
    const { client } = await bootstrap();
    client.setToken(director.token);

    const readiness = page.locator("[data-event-readiness]");
    const summary = page.locator("[data-event-summary]");
    const run = async (label, nextStatus) => {
      await expect(readiness.getByRole("button", { name: label, exact: true })).toBeEnabled();
      await readiness.getByRole("button", { name: label, exact: true }).click();
      await confirmAction(page);
      await expect(summary).toContainText(nextStatus);
    };

    // Signing in returns to `/staff`, and for a race director that is the Admin
    // view rather than a redirect to the registration desk.
    await signIn(page, director.email);
    await expect(page).toHaveURL(`${baseUrl}/staff`);
    await expect(page.getByRole("heading", { name: "Race control, in one place." })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Staff pages" }).getByRole("link")).toHaveText([
      "Admin", "Registration", "Announcer", "Start line", "Finish line",
    ]);
    await expect(page.getByRole("navigation", { name: "Staff pages" })
      .getByRole("link", { name: "Admin", exact: true })).toHaveAttribute("aria-current", "page");

    // Event Details, Heats, and Participants; no Support and no Access.
    const menu = page.getByRole("navigation", { name: "Admin views" });
    await expect(menu.getByRole("link")).toHaveText(["Event Details", "Heats", "Participants", "Inventory"]);
    await expect(menu.getByRole("link", { name: "Support" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Access" })).toHaveCount(0);
    // None of the administrator-only cards is rendered at all.
    await expect(page.locator("[data-event-create-form]")).toHaveCount(0);
    await expect(page.locator("[data-event-config-form]")).toHaveCount(0);
    await expect(page.locator("[data-force-delete-card], [data-open-force-delete]")).toHaveCount(0);
    // Reopening registration is administrator-only, so it is reported but never
    // offered as an action here.
    await expect(readiness).toContainText("Reopen registration");
    await expect(readiness.getByRole("button", { name: "Reopen registration", exact: true })).toHaveCount(0);

    // 1. Open registration.
    await expect(summary).toContainText("Draft");
    await run("Open registration", "Registration open");

    // Fill the race through the same APIs the desk uses, as the race director.
    const participants = [];
    for (let index = 0; index < 6; index += 1) {
      const participant = await registerParticipant(client, seeded.eventId, 800 + index);
      const duck = await intakeDuck(client, seeded.eventId, 801 + index);
      await pairDuck(client, seeded.eventId, duck, participant);
      participants.push(participant);
    }
    await page.reload();
    await expect(summary).toContainText("Registration open");

    // 2. Close registration. 3. Start round one.
    await run("Close registration", "Registration closed");
    await run("Start round one", "Round one");

    // The Heats view is theirs too: starting the round locked every roster.
    await menuLink(page, "Heats").click();
    await expect(page.locator("[data-heat-list] button").first()).toBeVisible();
    await menuLink(page, "Event Details").click();

    const roundOne = async () => {
      const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: director.token });
      expect(listed.status).toBe(200);
      return listed.body.heats.filter((heat) => heat.round === "ROUND_ONE");
    };
    for (const heat of await roundOne()) {
      const detail = await rawJson(
        `/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`,
        { token: director.token },
      );
      expect(detail.status).toBe(200);
      const working = { ...heat, revision: detail.body.heat.revision };
      for (const operation of ["ready", "call", "start", "finish"]) {
        await transitionHeat(client, seeded.eventId, working, operation);
      }
      await finalizeHeat(client, seeded.eventId, working, [
        { raceEntryId: detail.body.roster[0].raceEntryId, place: 1 },
      ]);
    }

    // 4. Start the final, after verifying the promoted finalists in the console.
    await page.reload();
    await menuLink(page, "Heats").click();
    await expect(page.locator("[data-finalist-list]")).toContainText("Heat 1");
    await menuLink(page, "Event Details").click();
    await run("Start final", "Final");

    const finalHeat = (await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: director.token }))
      .body.heats.find((heat) => heat.round === "FINAL");
    const finalDetail = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`,
      { token: director.token },
    );
    const working = { ...finalHeat, revision: finalDetail.body.heat.revision };
    for (const operation of ["ready", "call", "start", "finish"]) {
      await transitionHeat(client, seeded.eventId, working, operation);
    }
    await finalizeHeat(
      client,
      seeded.eventId,
      working,
      finalDetail.body.roster
        .slice(0, Math.min(3, finalDetail.body.roster.length))
        .map((entry, index) => ({ raceEntryId: entry.raceEntryId, place: index + 1 })),
    );

    // 5. Complete the event.
    await page.reload();
    await run("Complete event", "Completed");

    const completed = await rawJson(`/api/v1/staff/events/${seeded.eventId}`, { token: director.token });
    expect(completed.status).toBe(200);
    expect(completed.body.event.status).toBe("COMPLETED");

    // Still no administrator surfaces at the end of the race.
    await expect(page.locator("[data-force-delete-card], [data-open-force-delete]")).toHaveCount(0);
    const access = await page.request.get("/staff/access", { maxRedirects: 0 });
    expect(access.status()).toBe(403);

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
    }).toBe("(555) 020-9999");

    // The desk has no Admin menu bar and no Admin link at all.
    await expect(page.locator(".console-nav")).toHaveCount(0);
    await expect(page.locator('.staff-nav a[href="/staff"]')).toHaveCount(0);
    await expect(page.locator('.staff-nav a[href="/staff/registration"]')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("delete is offered only to a deletable participant, and never instead of withdrawal", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const paired = seeded.participants.find((participant) => participant.visibleNumber !== undefined);
    const unpaired = seeded.participants.find((participant) => participant.visibleNumber === undefined);
    expect(paired && unpaired).toBeTruthy();

    await signIn(page, admin.email);
    await menuLink(page, "Participants").click();
    await expect(page.locator("[data-participant-list] button").first()).toBeVisible();

    // Deletable — never paired, no heat place, an event that still allows it —
    // so Delete is offered. It is offered *as well as* withdrawal, not instead
    // of it: a never-paired no-show is exactly who a desk needs to withdraw, and
    // the endpoint accepts it, so hiding Withdraw here would leave destroying
    // the registration as the only way to record that they did not turn up.
    await participantRow(page, `${unpaired.firstName} ${unpaired.lastName}`).click();
    await expect(page.locator("[data-participant-detail]")).toBeVisible();
    await expect.poll(() => actionLabels(page)).toContain("Delete registration");
    expect(await actionLabels(page)).toContain("Withdraw");
    expect(await actionLabels(page)).toContain("Disqualify");
    // Nothing is in the water, so there is nothing to explain.
    await expect(page.locator("[data-participant-action-note]")).toHaveCount(0);

    // Paired: the duck is sealed in a heat bag, so it stays in the race and only
    // eligibility can change. Delete is not offered at all, and the card says why.
    await participantRow(page, `${paired.firstName} ${paired.lastName}`).click();
    // "Withdraw" is also offered for the previously selected unpaired racer, so
    // polling on it can pass while the pane still shows the old selection. Wait
    // for a paired-only signal before asserting which actions are absent.
    const note = page.locator("[data-participant-action-note]");
    await expect(note).toBeVisible();
    await expect.poll(() => actionLabels(page)).not.toContain("Delete registration");
    expect(await actionLabels(page)).toContain("Withdraw");
    expect(await actionLabels(page)).toContain("Disqualify");
    await expect(note).toContainText(`Duck #${paired.visibleNumber} is already sealed in a heat bag`);
    await expect(note).toContainText("cannot be deleted");

    // Withdrawing keeps the pairing, so the rule survives the status change: a
    // withdrawn paired participant is still undeletable.
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await confirmAction(page);
    await expect.poll(() => actionLabels(page)).toContain("Reactivate");
    expect(await actionLabels(page)).not.toContain("Delete registration");
    await expect(page.locator("[data-participant-action-note]")).toBeVisible();

    // Withdrawing the never-paired racer keeps the registration and leaves
    // Delete standing, because the server would still accept it.
    await participantRow(page, `${unpaired.firstName} ${unpaired.lastName}`).click();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    await confirmAction(page);
    await expect.poll(() => actionLabels(page)).toContain("Reactivate");
    expect(await actionLabels(page)).toContain("Delete registration");
    await expect(page.locator("[data-participant-action-note]")).toHaveCount(0);

    // Deleting the unpaired registration really removes it from the list.
    await page.getByRole("button", { name: "Delete registration", exact: true }).click();
    await confirmAction(page);
    await expect(
      page.locator("[data-participant-list] button", { hasText: `${unpaired.firstName} ${unpaired.lastName}` }),
    ).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  // The console must read `deletable`, which is the delete endpoint's own
  // predicate, and never `assignment`. A participant whose duck was unassigned
  // afterwards has no current assignment at all, yet the ended assignment row
  // and the surviving heat place still mean their duck went into a heat bag, so
  // the registration can never be removed again. Reading `assignment` offered
  // them a Delete button that could only ever collect a 409.
  test("an unassigned duck leaves a participant undeletable, and the console says so honestly", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const paired = seeded.participants.find((participant) => participant.visibleNumber !== undefined);
    expect(paired).toBeTruthy();

    // The projection states both answers, and they agree while the duck is held.
    const whilePaired = await rawJson(`/api/v1/staff/registrations/${paired.registrationId}`, {
      token: admin.token,
    });
    expect(whilePaired.status).toBe(200);
    expect(whilePaired.body.registration.currentlyPaired).toBe(true);
    expect(whilePaired.body.registration.deletable).toBe(false);

    await unassignDuck(admin.token, seeded.eventId, paired.registrationId);

    // Now they disagree, which is the whole point: no duck in hand, still not
    // removable.
    const afterUnassign = await rawJson(`/api/v1/staff/registrations/${paired.registrationId}`, {
      token: admin.token,
    });
    expect(afterUnassign.status).toBe(200);
    expect(afterUnassign.body.registration.assignment).toBeNull();
    expect(afterUnassign.body.registration.currentlyPaired).toBe(false);
    expect(afterUnassign.body.registration.deletable).toBe(false);

    await signIn(page, admin.email);
    await menuLink(page, "Participants").click();
    await expect(page.locator("[data-participant-list] button").first()).toBeVisible();
    await participantRow(page, `${paired.firstName} ${paired.lastName}`).click();
    await expect(page.locator("[data-participant-detail]")).toBeVisible();

    // No Delete, and the two eligibility actions instead.
    await expect.poll(() => actionLabels(page)).toContain("Withdraw");
    expect(await actionLabels(page)).toContain("Disqualify");
    expect(await actionLabels(page)).not.toContain("Delete registration");

    // The sentence tells the truth about *why*: no duck is in a bag right now,
    // so it must not claim one is.
    const note = page.locator("[data-participant-action-note]");
    await expect(note).toBeVisible();
    await expect(note).toContainText("already been in the race");
    await expect(note).toContainText("cannot be deleted");
    await expect(note).not.toContainText("sealed in a heat bag");

    // And the server agrees with the button that is not there: a delete really
    // would have been refused.
    const refused = await rawJson(`/api/v1/staff/registrations/${paired.registrationId}`, {
      token: admin.token,
      method: "DELETE",
      body: {
        commandId: crypto.randomUUID(),
        expectedRevision: afterUnassign.body.registration.revision,
      },
    });
    expect(refused.status).toBe(409);

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

    // Deleting the event out from under an open console makes its in-flight
    // event-scoped refetches 404. That is the deletion working, and the console
    // recovering from it is the behaviour under test, so those are the only
    // browser errors this page is allowed to produce. Depending on which
    // event-scoped request loses the race, fetchJson reports either the HTTP
    // status or the server's exact message.
    expect(errors.filter((error) =>
      !error.includes("404 (Not Found)") && error !== "pageerror: Event not found."
    )).toEqual([]);
  });
});
