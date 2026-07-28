import { expect, test } from "@playwright/test";

import {
  bootstrap,
  expectNoDocumentOverflow,
  intakeDuck,
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
    await expect(page.locator("[data-heat-bag-note]")).toContainText("for the rest of the race");

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
});
