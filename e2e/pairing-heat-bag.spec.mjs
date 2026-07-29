import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  confirmAction,
  expectNoDocumentOverflow,
  intakeDuck,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

// Pairing puts a physical duck into a physical heat bag it never comes out of,
// so the pairing screen has to shout which bag before the staffer walks away —
// and it must shout the heat the server's own pairing command committed, never
// a number the browser worked out for itself.

const heatBag = (page) => page.locator("[data-heat-bag]");

// Drive the pairing exactly as a staffer does: type the participant's lookup
// code into the one search field and submit. An exact code pairs immediately.
const pairThroughTheBrowser = async (page, tagToken, lookupCode) => {
  await page.goto(`/staff/ducks/${tagToken}`);
  await expect(page.locator("[data-registration-search-status]")).toContainText("waiting for a duck");
  const paired = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/staff/ducks/${tagToken}/assignments`)
    && response.request().method() === "POST"
  );
  await page.getByLabel("Participant code, name, phone, or email").fill(lookupCode);
  await page.getByRole("button", { name: "Find participant" }).click();
  return (await paired).json();
};

test.describe("the heat-bag callout on the pairing page", () => {
  test("names the heat the pairing command returned and survives a live refresh", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const waiting = seeded.participants.find((participant) => participant.visibleNumber === undefined);
    expect(waiting).toBeTruthy();
    const duck = await intakeDuck(client, seeded.eventId, 601);

    await signIn(page, admin.email, "/staff/registration");
    // Nothing is claimed before a pairing exists.
    await page.goto(`/staff/ducks/${duck.tagToken}`);
    await expect(heatBag(page)).toBeHidden();

    const result = await pairThroughTheBrowser(page, duck.tagToken, waiting.lookupCode);
    expect(result.heat).toBeTruthy();
    expect(result.heatAssignmentPending).toBe(false);

    // The panel is the server's answer, rendered. If the browser had counted
    // entries or incremented a previous number instead, this is where a real
    // duck would go into the wrong real bag.
    await expect(heatBag(page)).toBeVisible();
    await expect(heatBag(page)).not.toHaveClass(/pending/);
    await expect(page.locator("[data-heat-bag-instruction]"))
      .toHaveText(`Put this duck in HEAT ${result.heat.number} bag`);
    await expect(page.locator("[data-heat-bag-number]")).toHaveText(`Heat ${result.heat.number}`);
    await expect(page.locator("[data-heat-bag-duck]")).toHaveText(`Duck #${duck.visibleNumber}`);
    await expect(page.locator("[data-heat-bag-note]")).toContainText("Walk Duck");

    // A live refresh must not take the panel away while the staffer walks to
    // the bags. Another duck's intake publishes the ducks domain, which this
    // page refetches on.
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/staff/ducks/${duck.tagToken}`) && response.status() === 200
    );
    await intakeDuck(client, seeded.eventId, 602);
    await refreshed;
    await expect(heatBag(page)).toBeVisible();
    await expect(page.locator("[data-heat-bag-number]")).toHaveText(`Heat ${result.heat.number}`);

    // Only the staffer saying the duck is physically in the bag clears it.
    await page.locator("[data-heat-bag-dismiss]").click();
    await expect(heatBag(page)).toBeHidden();
    await expect(page.locator("[data-staff-message]")).toHaveText("Scan the next duck to pair it.");

    expect(errors).toEqual([]);
  });

  test("stays inside a 320px and a 390px screen, refused colours included", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const waiting = seeded.participants.filter((participant) => participant.visibleNumber === undefined);
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    const firstDuck = await intakeDuck(client, seeded.eventId, 611);
    const secondDuck = await intakeDuck(client, seeded.eventId, 612);

    await signIn(page, admin.email, "/staff/registration");

    await page.setViewportSize({ width: 320, height: 720 });
    const assigned = await pairThroughTheBrowser(page, firstDuck.tagToken, waiting[0].lookupCode);
    await expect(heatBag(page)).toBeVisible();
    await expect(page.locator("[data-heat-bag-number]")).toHaveText(`Heat ${assigned.heat.number}`);
    await expectNoDocumentOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(heatBag(page)).toBeVisible();
    await expectNoDocumentOverflow(page);

    // The refused variant. The pairing command itself always commits a heat, so
    // the only way to reach the response shape the contract defines for
    // "no heat came back" is to rewrite that one field on the wire. The pairing
    // is still real, still committed, and still served by the Worker; only the
    // heat the client is handed is blanked, which is exactly the input this
    // branch exists for.
    await page.route(`**/api/v1/staff/ducks/${secondDuck.tagToken}/assignments`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, heat: null, heatAssignmentPending: true },
      });
    });

    await page.setViewportSize({ width: 320, height: 720 });
    const pending = await pairThroughTheBrowser(page, secondDuck.tagToken, waiting[1].lookupCode);
    expect(pending.heatAssignmentPending).toBe(true);
    await expect(heatBag(page)).toBeVisible();
    await expect(heatBag(page)).toHaveClass(/pending/);
    await expect(page.locator("[data-heat-bag-instruction]")).toHaveText("Do not bag this duck yet");
    await expect(page.locator("[data-heat-bag-number]")).toHaveText("No heat assigned");
    await expect(page.locator("[data-heat-bag-note]")).toContainText("ask the race director");
    // No invented bag number anywhere in the refused panel.
    await expect(heatBag(page)).not.toContainText(/\bHeat \d/);
    await expectNoDocumentOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(heatBag(page)).toBeVisible();
    await expectNoDocumentOverflow(page);
    await page.unroute(`**/api/v1/staff/ducks/${secondDuck.tagToken}/assignments`);

    expect(errors).toEqual([]);
  });

  // The callout is a promise about a physical object, so it has to be true.
  // Closing registration folds a round-one tail heat that is too short to race
  // into the heat before it — the one operation that can still move an
  // already-paired duck's entry. While registration is open the callout must
  // therefore not claim the bag is final; once it has closed, it must.
  test("promises a permanent bag only once registration has closed", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const waiting = seeded.participants.filter((participant) => participant.visibleNumber === undefined);
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    const openDuck = await intakeDuck(client, seeded.eventId, 621);
    const closedDuck = await intakeDuck(client, seeded.eventId, 622);

    await signIn(page, admin.email, "/staff/registration");

    // Registration open: the bag is still named as loudly as ever, but the note
    // does not claim it is the duck's bag for the rest of the race.
    const open = await pairThroughTheBrowser(page, openDuck.tagToken, waiting[0].lookupCode);
    await expect(heatBag(page)).toBeVisible();
    await expect(page.locator("[data-heat-bag-instruction]"))
      .toHaveText(`Put this duck in HEAT ${open.heat.number} bag`);
    const openNote = page.locator("[data-heat-bag-note]");
    await expect(openNote).toContainText(`Walk Duck #${openDuck.visibleNumber} to the heat ${open.heat.number} bag now`);
    await expect(openNote).toContainText("folded into the heat before it");
    await expect(openNote).toContainText("pour one whole bag into another");
    await expect(openNote).not.toContainText("for the rest of the race");

    // Pairing stays available through REGISTRATION_CLOSED, and from there no
    // fold can reach the entry, so the note says so plainly.
    const closed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/close-registration`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID() },
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);

    const settled = await pairThroughTheBrowser(page, closedDuck.tagToken, waiting[1].lookupCode);
    await expect(heatBag(page)).toBeVisible();
    await expect(page.locator("[data-heat-bag-instruction]"))
      .toHaveText(`Put this duck in HEAT ${settled.heat.number} bag`);
    const settledNote = page.locator("[data-heat-bag-note]");
    await expect(settledNote).toContainText("It stays in that bag, in that position, for the rest of the race.");
    await expect(settledNote).not.toContainText("folded into the heat before it");

    expect(errors).toEqual([]);
  });
});

// The other half of the same promise. A fold moves ducks that are already
// sealed in numbered bags, so it may never happen silently: the console has to
// tell the staff exactly which bag to pour into which, and keep telling them
// until somebody says the bags match.
test.describe("the bag-move instruction in the Admin console", () => {
  const bagMove = (page) => page.locator("[data-bag-move]");

  const runLifecycle = async (page, label) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await confirmAction(page);
  };

  test("names the folded bags, survives a reload, and clears only when acknowledged", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Seven paired ducks into heats of three leaves a one-duck tail heat, which
    // closing registration folds into heat 2.
    const seeded = await seedState("registration", { participants: 11, heatSize: 3 });
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);

    const heats = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(heats.status).toBe(200);
    const roundOne = heats.body.heats.filter((heat) => heat.round === "ROUND_ONE");
    expect(roundOne.map((heat) => heat.rosterSize)).toEqual([3, 3, 1]);
    const tail = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${roundOne[2].id}`,
      { token: admin.token },
    );
    expect(tail.status).toBe(200);
    const tailDuck = tail.body.roster[0].duck.visibleNumber;

    await signIn(page, admin.email);
    await expect(page.locator("[data-event-readiness] .data-card").first()).toBeVisible();
    // Nothing is claimed before a transition moves anything.
    await expect(bagMove(page)).toBeHidden();

    await runLifecycle(page, "Close registration");

    await expect(bagMove(page)).toBeVisible();
    await expect(page.locator("[data-bag-move-instruction]"))
      .toHaveText("Pour the Heat 3 bag into the Heat 2 bag");
    await expect(page.locator("[data-bag-move-number]")).toHaveText("Heat 3 → Heat 2");
    await expect(page.locator("[data-bag-move-ducks]")).toHaveText(`1 duck: Duck #${tailDuck}`);
    await expect(page.locator("[data-bag-move-note]"))
      .toContainText("Empty the whole Heat 3 bag into the Heat 2 bag");
    await expectNoDocumentOverflow(page);

    // Walking to the bags is exactly when a page gets reloaded, so a reload,
    // and switching to another Admin view, must both leave the task on screen.
    await page.reload();
    await expect(bagMove(page)).toBeVisible();
    await expect(page.locator("[data-bag-move-instruction]"))
      .toHaveText("Pour the Heat 3 bag into the Heat 2 bag");
    await page.getByRole("navigation", { name: "Admin views" })
      .getByRole("link", { name: "Heats", exact: true }).click();
    await expect(page).toHaveURL(`${baseUrl}/staff#heats`);
    await expect(bagMove(page)).toBeVisible();

    // Only a person can know a bag was moved.
    await page.locator("[data-bag-move-dismiss]").click();
    await expect(bagMove(page)).toBeHidden();
    await page.reload();
    await expect(bagMove(page)).toBeHidden();

    // The data really did fold, so the instruction was not decorative.
    const folded = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(folded.body.heats.filter((heat) => heat.round === "ROUND_ONE").map((heat) => heat.rosterSize))
      .toEqual([3, 4]);

    expect(errors).toEqual([]);
  });

  test("names the reverse move when an administrator reopens registration", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration", { participants: 11, heatSize: 3 });
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);

    const heats = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const roundOne = heats.body.heats.filter((heat) => heat.round === "ROUND_ONE");
    const tail = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${roundOne[2].id}`,
      { token: admin.token },
    );
    const tailDuck = tail.body.roster[0].duck.visibleNumber;

    const closed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/close-registration`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID() },
    });
    expect(closed.status).toBe(201);
    expect(closed.body.bagMoves).toEqual([{
      action: "MERGE",
      fromHeatNumber: 3,
      intoHeatNumber: 2,
      duckNumbers: [tailDuck],
      movedEntryCount: 1,
    }]);

    await signIn(page, admin.email);
    await expect(page.locator("[data-event-readiness] .data-card").first()).toBeVisible();
    // The fold happened over the API, so this console never saw it and shows
    // nothing; the reopen it does run is the instruction under test.
    await expect(bagMove(page)).toBeHidden();

    await runLifecycle(page, "Reopen registration");

    await expect(bagMove(page)).toBeVisible();
    await expect(page.locator("[data-bag-move-instruction]"))
      .toHaveText(`Move 1 duck: Duck #${tailDuck} from the Heat 2 bag into a new Heat 3 bag`);
    await expect(page.locator("[data-bag-move-number]")).toHaveText("Heat 2 → Heat 3");
    await expect(page.locator("[data-bag-move-note]"))
      .toContainText("Take exactly those ducks out of the Heat 2 bag");
    await expect(page.locator("[data-bag-move-note]"))
      .toContainText("leave every other duck exactly where it is");
    await expectNoDocumentOverflow(page);

    await page.locator("[data-bag-move-dismiss]").click();
    await expect(bagMove(page)).toBeHidden();

    const split = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(split.body.heats.filter((heat) => heat.round === "ROUND_ONE").map((heat) => heat.rosterSize))
      .toEqual([3, 3, 1]);

    expect(errors).toEqual([]);
  });
});
