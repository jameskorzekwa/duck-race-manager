import { expect, test } from "@playwright/test";

import {
  changeRegistrationStatus,
  publicBoardShape,
  rawJson,
  seedState,
  watchBrowserErrors,
} from "./helpers.mjs";

// A Round One heat that has not started yet stops being a race when the racers
// in it leave. Nobody should have to line a bag up for a heat with one duck in
// it that can win, and nobody should have to run one with none.
//
// These specs drive the real staff API with real revisions and then read the
// authoritative projections back, so nothing here can pass against a fiction.
// The seeded round-one race leaves heat 1 published, heat 2 on the water, and
// heat 3 called but never started — which is exactly the heat this rule owns.
//
// Zero, one, and two-or-more eligible racers are all covered, but the zero case
// is reached differently on purpose. A heat only falls from two eligible racers
// to none if a withdrawal in between never settled it, and a browser cannot
// produce that: every withdrawal it sends settles the heat before it answers.
// So the browser covers the two transitions it can actually cause, and
// `src/round-one-auto-resolution.integration.test.mjs` covers the skipped heat
// against the real handlers, where a lost request can be modelled honestly.

const unstartedRoundOneHeat = async (token, eventId) => {
  const listed = await rawJson(`/api/v1/staff/events/${eventId}/heats`, { token });
  expect(listed.status).toBe(200);
  const heat = listed.body.heats.find((candidate) =>
    candidate.round === "ROUND_ONE" && ["LOADING", "READY", "CALLING"].includes(candidate.status)
  );
  expect(heat, "the seeded race leaves one round-one heat unstarted").toBeTruthy();
  const detail = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heat.id}`, { token });
  expect(detail.status).toBe(200);
  return { heat, roster: detail.body.roster };
};

const heatDetail = async (token, eventId, heatId) => {
  const detail = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heatId}`, { token });
  expect(detail.status).toBe(200);
  return detail.body;
};

const finalists = async (token, eventId) => {
  const listed = await rawJson(`/api/v1/staff/events/${eventId}/finalists`, { token });
  expect(listed.status).toBe(200);
  return listed.body.finalists;
};

const racersOf = (seeded, roster) => roster.map((entry) => {
  const participant = seeded.participants.find((candidate) =>
    candidate.visibleNumber === entry.duck.visibleNumber
  );
  expect(participant, `no seeded participant for duck ${entry.duck.visibleNumber}`).toBeTruthy();
  return participant;
});

const slotShape = (roster) => roster.map((entry) => `${entry.slotNumber}|${entry.raceEntryId}`);

test.describe("an unstarted Round One heat that can no longer be a contest", () => {
  test("two racers left still race, and the last racer left goes straight to the final", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { heat, roster } = await unstartedRoundOneHeat(admin.token, seeded.eventId);
    expect(roster).toHaveLength(3);
    const racers = racersOf(seeded, roster);
    const before = slotShape(roster);
    const finalistsBefore = await finalists(admin.token, seeded.eventId);

    // The public board is watching, with no reload anywhere in this spec.
    await page.goto("/race");
    await expect(page.locator("[data-live-board] .board-heat").first()).toBeVisible();
    const heatCard = page.locator(".board-heat").filter({ hasText: `Heat ${heat.number}` });
    await expect(heatCard.locator(".board-entry")).toHaveCount(3);

    // --- Two eligible racers left: nothing changes ------------------------
    await changeRegistrationStatus(admin.token, racers[0].registrationId, "withdraw");

    const contested = await heatDetail(admin.token, seeded.eventId, heat.id);
    expect(contested.heat.status).toBe(heat.status);
    expect(contested.results).toEqual([]);
    expect(slotShape(contested.roster)).toEqual(before);
    expect(await finalists(admin.token, seeded.eventId)).toEqual(finalistsBefore);
    // Publicly the racer who left is simply absent, and the heat is still a heat.
    await expect(heatCard.locator(".board-entry")).toHaveCount(2, { timeout: 20_000 });

    // --- One eligible racer left: settled automatically -------------------
    await changeRegistrationStatus(admin.token, racers[1].registrationId, "withdraw");

    const settled = await heatDetail(admin.token, seeded.eventId, heat.id);
    expect(settled.heat.status).toBe("FINALIZED");
    expect(settled.results).toHaveLength(1);
    expect(settled.results[0].place).toBe(1);
    expect(settled.results[0].raceEntryId).toBe(roster[2].raceEntryId);
    // No finish-line scan, no manual winner action, and no bag was disturbed:
    // every entry keeps its slot and the withdrawn ducks stay in it.
    expect(slotShape(settled.roster)).toEqual(before);

    const promoted = await finalists(admin.token, seeded.eventId);
    expect(promoted.map((finalist) => finalist.raceEntryId)).toContain(roster[2].raceEntryId);
    expect(promoted.filter((finalist) => finalist.raceEntryId === roster[2].raceEntryId)).toHaveLength(1);
    expect(
      promoted.find((finalist) => finalist.raceEntryId === roster[2].raceEntryId).qualifiedFrom.heatNumber,
    ).toBe(heat.number);

    // The public board repaints to the official result by itself: one racer in
    // the heat, holding first place, and a final that now has a duck in it.
    await expect(heatCard.locator(".board-entry")).toHaveCount(1, { timeout: 20_000 });
    await expect(heatCard).toContainText(`Duck #${racers[2].visibleNumber}`);
    const board = await publicBoardShape();
    const publicHeat = board.heats.find((candidate) =>
      candidate.round === "ROUND_ONE" && candidate.number === heat.number
    );
    expect(publicHeat.roster).toHaveLength(1);
    expect(publicHeat.roster[0]).toContain(`|${racers[2].visibleNumber}|1`);
    expect(board.heats.some((candidate) => candidate.round === "FINAL")).toBe(true);

    expect(errors).toEqual([]);
  });

  test("a retried withdrawal settles the heat once and promotes one duck", async () => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const { heat, roster } = await unstartedRoundOneHeat(admin.token, seeded.eventId);
    const racers = racersOf(seeded, roster);
    await changeRegistrationStatus(admin.token, racers[0].registrationId, "withdraw");

    // One command identifier, sent twice, exactly as an interrupted client
    // retries it.
    const current = await rawJson(`/api/v1/staff/registrations/${racers[1].registrationId}`, {
      token: admin.token,
    });
    const body = {
      commandId: crypto.randomUUID(),
      expectedRevision: current.body.registration.revision,
    };
    const first = await rawJson(`/api/v1/staff/registrations/${racers[1].registrationId}/withdraw`, {
      token: admin.token,
      method: "POST",
      body,
    });
    expect(first.status).toBe(201);
    const retry = await rawJson(`/api/v1/staff/registrations/${racers[1].registrationId}/withdraw`, {
      token: admin.token,
      method: "POST",
      body,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    const settled = await heatDetail(admin.token, seeded.eventId, heat.id);
    expect(settled.heat.status).toBe("FINALIZED");
    expect(settled.results).toHaveLength(1);
    const promoted = await finalists(admin.token, seeded.eventId);
    expect(promoted.filter((finalist) => finalist.raceEntryId === roster[2].raceEntryId)).toHaveLength(1);

    // A stale revision from before the first withdrawal is refused and settles
    // nothing further.
    const stale = await rawJson(`/api/v1/staff/registrations/${racers[2].registrationId}/withdraw`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), expectedRevision: 0 },
    });
    expect(stale.status).toBe(409);
    expect((await heatDetail(admin.token, seeded.eventId, heat.id)).results).toHaveLength(1);
  });

  test("a staff member without the race-director role settles nothing", async () => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const restricted = seeded.accounts.find((account) =>
      !account.isSystemAdmin && !account.roles.includes("RACE_DIRECTOR")
    );
    expect(restricted, "local staff bootstrap returned no non-director account").toBeTruthy();
    const { heat, roster } = await unstartedRoundOneHeat(admin.token, seeded.eventId);
    const racers = racersOf(seeded, roster);
    await changeRegistrationStatus(admin.token, racers[0].registrationId, "withdraw");
    const before = slotShape(roster);

    const current = await rawJson(`/api/v1/staff/registrations/${racers[1].registrationId}`, {
      token: admin.token,
    });
    const denied = await rawJson(`/api/v1/staff/registrations/${racers[1].registrationId}/disqualify`, {
      token: restricted.token,
      method: "POST",
      body: {
        commandId: crypto.randomUUID(),
        expectedRevision: current.body.registration.revision,
      },
    });
    expect(denied.status).toBe(403);

    const untouched = await heatDetail(admin.token, seeded.eventId, heat.id);
    expect(untouched.heat.status).toBe(heat.status);
    expect(untouched.results).toEqual([]);
    expect(slotShape(untouched.roster)).toEqual(before);
    const promoted = await finalists(admin.token, seeded.eventId);
    expect(promoted.map((finalist) => finalist.raceEntryId)).not.toContain(roster[2].raceEntryId);
  });
});
