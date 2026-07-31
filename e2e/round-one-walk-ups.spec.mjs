import { expect, test } from "@playwright/test";

import {
  accountWith,
  bootstrap,
  expectNoDocumentOverflow,
  finalizeHeat,
  intakeDuck,
  pairDuck,
  rawJson,
  seedState,
  signIn,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

test("the registration desk admits Round One walk-ups until the final unstarted heat begins", async ({ page }) => {
  test.setTimeout(180_000);
  const seeded = await seedState("closed", { participants: 13, heatSize: 5 });
  const desk = accountWith(seeded.accounts, "REGISTRATION");
  const errors = watchBrowserErrors(page);
  const { admin, client } = await bootstrap();

  await signIn(page, desk.email, "/staff/registration");
  const card = page.locator("[data-walkup-card]");
  const availability = page.locator("[data-walkup-availability]");
  const form = page.locator("[data-walkup-form]");

  // Registration has closed, but starting Round One opens the bounded walk-up
  // window. The already-open least-privilege desk learns that from live data.
  await expect(form).toBeHidden();
  await client.post(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
    commandId: crypto.randomUUID(),
  }, { label: "start round one for walk-up browser coverage" });
  await expect(availability).toHaveText(
    "Walk-up registration stays open until the final unstarted Round One heat begins.",
  );
  await expect(form).toBeVisible();

  // The desk repaints that sentence from its own narrow cutoff projection rather
  // than from the whole event record, so the endpoint is asserted directly.
  const admissionFor = (token, eventId = seeded.eventId) =>
    rawJson(`/api/v1/staff/events/${eventId}/walk-up-admission`, { token });
  const openWindow = await admissionFor(desk.token);
  expect(openWindow.status).toBe(200);
  expect(openWindow.body.eventExists).toBe(true);
  expect(openWindow.body.walkUpAdmission).toEqual({
    allowed: true,
    reason: "Walk-up registration stays open until the final unstarted Round One heat begins.",
  });
  // Least privilege: reading the cutoff is registration work, so a heat runner is
  // refused it exactly as they are refused the walk-up create it describes.
  const heatRunner = accountWith(seeded.accounts, "HEAT_RUNNER");
  expect(heatRunner.roles).not.toContain("REGISTRATION");
  expect(heatRunner.roles).not.toContain("RACE_DIRECTOR");
  expect((await admissionFor(heatRunner.token)).status).toBe(403);

  await page.setViewportSize({ width: 320, height: 900 });
  await expectNoDocumentOverflow(page);

  const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
  const heats = listed.body.heats
    .filter((heat) => heat.round === "ROUND_ONE")
    .sort((left, right) => left.number - right.number);
  expect(heats).toHaveLength(3);

  const detail = async (heat) => {
    const response = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${heat.id}`,
      { token: admin.token },
    );
    expect(response.status).toBe(200);
    Object.assign(heat, response.body.heat);
    return response.body;
  };
  const finishAndPublish = async (heat) => {
    const current = await detail(heat);
    await transitionHeat(client, seeded.eventId, heat, "finish");
    await finalizeHeat(client, seeded.eventId, heat, [
      { raceEntryId: current.roster[0].raceEntryId, place: 1 },
    ]);
  };
  const admit = async (firstName) => {
    if (!await card.evaluate((element) => element.open)) await card.locator("summary").click();
    await form.getByLabel("First name").fill(firstName);
    await form.getByLabel("Last name").fill("Walkup");
    const response = page.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname === `/api/v1/staff/events/${seeded.eventId}/registrations`
      && candidate.request().method() === "POST");
    await form.getByRole("button", { name: "Create walk-up" }).click();
    expect((await response).status()).toBe(201);
    const registration = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent(firstName)}`,
      { token: desk.token },
    );
    expect(registration.status).toBe(200);
    return registration.body.registrations.find((entry) => entry.firstName === firstName);
  };

  // Heat 1 starts while two later heats remain. The first walk-up follows the
  // normal create, intake, and pairing path and lands only in an unstarted heat.
  await detail(heats[0]);
  for (const operation of ["ready", "call", "start"]) {
    await transitionHeat(client, seeded.eventId, heats[0], operation);
  }
  const first = await admit("MultipleRemaining");
  expect(first).toBeTruthy();
  const firstDuck = await intakeDuck(client, seeded.eventId, 991);
  const firstPairing = await pairDuck(client, seeded.eventId, firstDuck, first);
  expect(firstPairing.body.heat.number).toBe(3);

  await finishAndPublish(heats[0]);
  await detail(heats[1]);
  for (const operation of ["ready", "call", "start"]) {
    await transitionHeat(client, seeded.eventId, heats[1], operation);
  }
  await finishAndPublish(heats[1]);

  // Exactly one never-started heat remains and still accepts one more walk-up.
  await expect(availability).toContainText("final unstarted Round One heat");
  const finalWindow = await admit("OneRemaining");
  expect(finalWindow).toBeTruthy();
  const finalDuck = await intakeDuck(client, seeded.eventId, 992);
  const finalPairing = await pairDuck(client, seeded.eventId, finalDuck, finalWindow);
  expect(finalPairing.body.heat.number).toBe(3);

  // Keep a stale, dirty form on screen while another station calls and starts
  // the final unstarted heat. The dedicated authoritative refresh must close it
  // without a reload and without relying on clearing the typed values first.
  await detail(heats[2]);
  await transitionHeat(client, seeded.eventId, heats[2], "ready");
  await transitionHeat(client, seeded.eventId, heats[2], "call");
  await form.getByLabel("First name").fill("Stale");
  await form.getByLabel("Last name").fill("Attempt");
  await transitionHeat(client, seeded.eventId, heats[2], "start");
  await expect(availability).toHaveText(
    "Walk-up registration has closed because every Round One heat has started.",
  );
  await expect(form).toBeHidden();
  await expect(card).toHaveAttribute("open", "");
  await expectNoDocumentOverflow(page);

  const closedWindow = await admissionFor(desk.token);
  expect(closedWindow.status).toBe(200);
  expect(closedWindow.body.eventExists).toBe(true);
  expect(closedWindow.body.walkUpAdmission.allowed).toBe(false);
  expect(closedWindow.body.walkUpAdmission.reason).toContain("every Round One heat has started");

  const stale = await rawJson(`/api/v1/staff/events/${seeded.eventId}/registrations`, {
    token: desk.token,
    method: "POST",
    body: {
      commandId: crypto.randomUUID(),
      privateToken: "s".repeat(43),
      firstName: "Stale",
      lastName: "Attempt",
      email: null,
      phone: null,
      emailNotificationsEnabled: false,
      notes: null,
    },
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error).toContain("every Round One heat has started");
  const absent = await rawJson(
    `/api/v1/staff/events/${seeded.eventId}/registrations?q=${encodeURIComponent("Stale Attempt")}`,
    { token: desk.token },
  );
  expect(absent.body.registrations).toHaveLength(0);

  // Deleting the event publishes a heat signal, so every registration surface
  // still on screen asks this question once more about an event that has just
  // been removed. It answers "closed" rather than 404 on purpose: a 404 there is
  // a browser console error on a page that did nothing wrong, and the full-race
  // journey pins exactly how many legitimate 404s it is allowed to see.
  const withoutEvent = await admissionFor(desk.token, "event_does_not_exist");
  expect(withoutEvent.status).toBe(200);
  expect(withoutEvent.body.eventExists).toBe(false);
  expect(withoutEvent.body.walkUpAdmission).toEqual({
    allowed: false,
    reason: "Walk-up registration is unavailable until an event is ready for registration.",
  });

  expect(errors).toEqual([]);
});
