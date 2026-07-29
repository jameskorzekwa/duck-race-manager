import { expect, test } from "@playwright/test";

import {
  baseUrl,
  bootstrap,
  changeRegistrationStatus,
  intakeDuck,
  pairDuck,
  publicBoardShape,
  rawJson,
  seedState,
  watchBrowserErrors,
} from "./helpers.mjs";

// A withdrawn or disqualified participant keeps their duck: it is sealed in a
// heat bag and physically stays in the water. Publicly the application behaves
// as if they are not in the race, and that is a projection rule everywhere and a
// data change nowhere — no row is deleted, no heat is reordered, no place is
// promoted. These specs prove both halves in a real browser: the entry is gone
// from the public surfaces, and nothing around it moved.

// The rendered board, reduced to what a withdrawal must never disturb.
const paintedBoard = (page) => page.locator("[data-live-board-content]").evaluate((root) => ({
  heats: Array.from(root.querySelectorAll(".board-heat")).map((card) => ({
    title: card.querySelector("h4").textContent,
    entries: Array.from(card.querySelectorAll(".board-entry")).map((row) => row.textContent),
  })),
  podium: Array.from(root.querySelectorAll(".podium-place")).map((place) => place.textContent),
}));

// The seeded race pairs ducks 101 upward in registration order into heats of
// three, so this is the middle racer of the middle heat: a gap that would be
// obvious if anything were promoted into it.
const middleOfSecondHeat = (seeded) =>
  seeded.participants.find((participant) => participant.visibleNumber === 105);

test.describe("withdrawn and disqualified participants disappear publicly", () => {
  test("a withdrawal removes one racer from /race and moves nothing else", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    // Registration closed: every participant is paired, every heat is planned
    // and still unlocked, so the application really accepts this withdrawal.
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const leaving = middleOfSecondHeat(seeded);
    expect(leaving).toBeTruthy();

    const before = await publicBoardShape();
    expect(before.heats).toHaveLength(3);
    const leavingEntry = before.heats[1].roster.find((entry) => entry.includes(`|${leaving.visibleNumber}|`));
    expect(leavingEntry, "the racer being withdrawn is on the board first").toBeTruthy();

    await page.goto("/race");
    await expect(page.locator("[data-live-board]")).toBeVisible();
    await expect(page.getByText(`Duck #${leaving.visibleNumber}`, { exact: false }).first()).toBeVisible();

    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    // Gone from the authoritative projection…
    await expect.poll(async () => (await publicBoardShape()).heats[1].roster.length).toBe(2);
    const after = await publicBoardShape();
    expect(after.heats[1].roster).not.toContain(leavingEntry);

    // …and every other lane is byte-identical. The heat itself survives with its
    // own number, the two remaining racers keep their stored order and their
    // printed duck numbers, and no third racer is pulled in from anywhere.
    expect(after.heats.map((heat) => `${heat.round} ${heat.number}`))
      .toEqual(before.heats.map((heat) => `${heat.round} ${heat.number}`));
    expect(after.heats[0].roster).toEqual(before.heats[0].roster);
    expect(after.heats[2].roster).toEqual(before.heats[2].roster);
    expect(after.heats[1].roster).toEqual(
      before.heats[1].roster.filter((entry) => entry !== leavingEntry),
    );
    expect(after.podium).toEqual(before.podium);

    // The rendered page agrees after a plain reload.
    await page.reload();
    await expect(page.locator("[data-live-board]")).toBeVisible();
    await expect(page.getByText(`Duck #${leaving.visibleNumber}`, { exact: false })).toHaveCount(0);
    const painted = await paintedBoard(page);
    expect(painted.heats).toHaveLength(3);
    expect(painted.heats[1].entries).toHaveLength(2);

    expect(errors).toEqual([]);
  });

  test("the live board repaints on the withdrawal signal without shifting the other lanes", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const leaving = middleOfSecondHeat(seeded);

    await page.goto("/race");
    await expect(page.locator("[data-live-board] .board-heat").first()).toBeVisible();
    await expect.poll(async () => (await paintedBoard(page)).heats.length).toBe(3);
    const before = await paintedBoard(page);
    const leavingRow = before.heats[1].entries.find((entry) => entry.includes(`Duck #${leaving.visibleNumber}`));
    expect(leavingRow).toBeTruthy();

    // No reload: the mutation publishes the `participants` domain and the board
    // refetches the authoritative projection by itself.
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    await expect.poll(async () => (await paintedBoard(page)).heats[1].entries.length, {
      timeout: 20_000,
    }).toBe(2);
    const after = await paintedBoard(page);
    expect(after.heats.map((heat) => heat.title)).toEqual(before.heats.map((heat) => heat.title));
    expect(after.heats[0].entries).toEqual(before.heats[0].entries);
    expect(after.heats[2].entries).toEqual(before.heats[2].entries);
    expect(after.heats[1].entries).toEqual(before.heats[1].entries.filter((entry) => entry !== leavingRow));
    // Nothing was promoted or renumbered, so the podium region is exactly as it
    // was — which at this stage of the race means still absent.
    expect(after.podium).toEqual(before.podium);

    expect(errors).toEqual([]);
  });

  test("a withdrawn racer's duck page and tag scan expose nobody and offer no Follow", async ({ page }) => {
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const leaving = middleOfSecondHeat(seeded);

    // Before the withdrawal the duck page is a normal public page with a Follow
    // action, so the assertions below prove a change rather than an accident.
    await page.goto(`/duck/${leaving.visibleNumber}`);
    await expect(page.getByRole("button", { name: "Follow this duck" })).toBeVisible();

    // Leave that page before the state changes. A live duck page whose duck
    // stops being public reloads itself into the not-found page, and that
    // self-repair would race the deliberate navigation below.
    await page.goto("/");
    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    // The shared "isn't racing" page: identical to an unknown number, so it adds
    // no enumeration signal and names nobody.
    await page.goto(`/duck/${leaving.visibleNumber}`);
    await expect(page.getByRole("heading", { name: /Duck #105 isn.t racing/ })).toBeVisible();
    await expect(page.locator("[data-duck-follow], [data-follow-button]")).toHaveCount(0);

    // The anonymous tag scan resolves to no public participant at all and goes
    // home rather than reporting anything about this duck.
    const scan = await page.goto(`/t/${leaving.tagToken}`);
    expect(scan.request().redirectedFrom()).not.toBeNull();
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.locator("[data-duck-follow], [data-follow-button]")).toHaveCount(0);

    // Both APIs behind those pages agree, and the public name search that would
    // otherwise offer a follow returns nothing to follow.
    const byNumber = await rawJson(`/api/v1/ducks/number/${leaving.visibleNumber}`);
    expect(byNumber.status).toBe(404);
    const byTag = await rawJson(`/api/v1/ducks/${leaving.tagToken}`);
    expect(byTag.body.destination).toBe("HOME");
    const search = await rawJson(
      `/api/v1/race-status/search?eventId=${encodeURIComponent(seeded.eventId)}`
      + `&name=${encodeURIComponent(`${leaving.firstName} ${leaving.lastName}`)}`,
    );
    expect(search.status).toBe(200);
    expect(search.body.results).toEqual([]);
  });

  test("My Ducks drops a followed withdrawn racer and keeps this browser's own", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("registration");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { client } = await bootstrap();
    const followed = seeded.participants.find((participant) => participant.visibleNumber !== undefined);
    expect(followed).toBeTruthy();

    // This browser registers its own participant, which is what makes its
    // collection link a REGISTRATION one rather than a follow.
    await page.goto("/register");
    const form = page.locator("[data-registration-form]");
    await form.getByLabel("First name").fill("Owner");
    await form.getByLabel("Last name").fill("Racer");
    await form.getByRole("button", { name: "Register participant" }).click();
    await expect(page).toHaveURL(`${baseUrl}/my-ducks`);

    // Pair it, so the surviving card is a paired one and the rule is proven
    // against the same shape of participant that disappears elsewhere.
    const listed = (await client.get(
      `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("Owner")}`,
    )).body.registrations;
    const owner = listed.find((registration) => registration.lastName === "Racer");
    expect(owner).toBeTruthy();
    const ownDuck = await intakeDuck(client, seeded.eventId, 501);
    await pairDuck(client, seeded.eventId, ownDuck, owner);

    // And it follows somebody else's participant from the public search.
    await page.reload();
    await page.locator("[data-status-search] input[name='name']").fill(
      `${followed.firstName} ${followed.lastName}`,
    );
    await page.locator("[data-status-search]").getByRole("button", { name: "Find status" }).click();
    await page.locator("[data-search-results]").getByRole("button", { name: "Add to My Ducks" }).first().click();
    const followedCards = page.locator('[data-participant-section="followed"] [data-registration-id]');
    await expect(followedCards).toHaveCount(1);
    const ownCard = page.locator('[data-participant-section="paired"] [data-registration-id]', {
      hasText: "Owner Racer",
    });
    await expect(ownCard).toBeVisible();

    // Someone else's withdrawal takes their card off this device entirely: the
    // followed link is not deleted, the participant is simply not public.
    await changeRegistrationStatus(admin.token, followed.registrationId, "withdraw");
    await expect(followedCards).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-participant-section="followed"]')).toBeHidden();

    // This browser's own participant is entitled to know their own status, so
    // their card survives their own withdrawal and states it plainly.
    await changeRegistrationStatus(admin.token, owner.registrationId, "withdraw");
    await expect(ownCard).toContainText("Registration: Withdrawn", { timeout: 20_000 });
    await expect(ownCard).toContainText("Duck #501");

    // Nothing had to be re-followed: reactivation restores the followed card by
    // itself, because the collection link was never removed.
    await changeRegistrationStatus(admin.token, followed.registrationId, "reactivate");
    await expect(followedCards).toHaveCount(1, { timeout: 20_000 });
    await expect(ownCard).toContainText("Registration: Withdrawn");

    expect(errors).toEqual([]);
  });

  test("the private status link still tells its owner they are withdrawn", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const leaving = middleOfSecondHeat(seeded);

    await page.goto(`/r/${leaving.privateToken}`);
    await expect(page.locator("[data-private-status-heading]"))
      .toHaveText(`Your duck is assigned, ${leaving.firstName}.`);
    await expect(page.locator("[data-live-personal]")).toContainText("Active");

    await changeRegistrationStatus(admin.token, leaving.registrationId, "withdraw");

    // The page refreshes itself from the private endpoint on the same signal.
    await expect(page.locator("[data-private-status-heading]"))
      .toHaveText(`Registration withdrawn, ${leaving.firstName}.`, { timeout: 20_000 });
    await expect(page.locator("[data-live-personal]")).toContainText("Withdrawn");

    // A cold load says the same thing, and the JSON endpoint behind it too.
    await page.reload();
    await expect(page.locator("[data-private-status-heading]"))
      .toHaveText(`Registration withdrawn, ${leaving.firstName}.`);
    await expect(page.locator("[data-live-personal]")).toContainText("Withdrawn");
    const status = await rawJson(`/api/v1/registrations/${leaving.privateToken}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("WITHDRAWN");

    expect(errors).toEqual([]);
  });
});
