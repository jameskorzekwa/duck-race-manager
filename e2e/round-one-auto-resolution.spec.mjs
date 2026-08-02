import { expect, test } from "@playwright/test";

import {
  changeRegistrationStatus,
  publicBoardShape,
  rawJson,
  seedState,
  signIn,
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
// Zero, one, and two-or-more eligible racers are all covered. The zero scenario
// reaches the same interrupted-progress state without a test-only database
// shortcut: two racers leave while registration is closed (when reconciliation
// is not applicable), Round One starts with the remaining physical three-duck
// bag, and the last eligible racer then leaves. Every row is still produced by a
// real handler, and that final mutation must skip the now-empty heat.

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

const runHeatManually = async (token, eventId, heatId) => {
  let detail = await heatDetail(token, eventId, heatId);
  for (const operation of ["ready", "call", "start", "finish"]) {
    const response = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heatId}/${operation}`, {
      token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: detail.heat.revision },
    });
    expect(response.status, `${operation} heat ${detail.heat.number}: ${JSON.stringify(response.body)}`).toBe(201);
    detail.heat = response.body.heat;
  }
  const winner = detail.roster.find((entry) => entry.eligible);
  expect(winner, `heat ${detail.heat.number} has no eligible manual winner`).toBeTruthy();
  const recorded = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heatId}/results/finalize`, {
    token,
    method: "POST",
    body: {
      commandId: crypto.randomUUID(),
      revision: detail.heat.revision,
      results: [{ raceEntryId: winner.raceEntryId, place: 1 }],
    },
  });
  expect(recorded.status, `record heat ${detail.heat.number}: ${JSON.stringify(recorded.body)}`).toBe(201);
  const announced = await rawJson(`/api/v1/staff/events/${eventId}/heats/${heatId}/winner-announced`, {
    token,
    method: "POST",
    body: { commandId: crypto.randomUUID(), revision: recorded.body.heat.revision },
  });
  expect(
    announced.status,
    `confirm heat ${detail.heat.number} winner announced: ${JSON.stringify(announced.body)}`,
  ).toBe(201);
  return winner.raceEntryId;
};

test.describe("an unstarted Round One heat that can no longer be a contest", () => {
  test("no racers left skips the heat in staff and public views and permits the final", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchBrowserErrors(page);
    const seeded = await seedState("closed");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    expect(listed.status).toBe(200);
    const roundOne = listed.body.heats.filter((heat) => heat.round === "ROUND_ONE");
    const target = roundOne.at(-1);
    const planned = await heatDetail(admin.token, seeded.eventId, target.id);
    expect(planned.roster).toHaveLength(3);
    const racers = racersOf(seeded, planned.roster);
    const before = slotShape(planned.roster);

    // These committed status changes cannot reconcile before Round One. They
    // leave one eligible racer in the same three-duck physical bag.
    await changeRegistrationStatus(admin.token, racers[0].registrationId, "withdraw");
    await changeRegistrationStatus(admin.token, racers[1].registrationId, "withdraw");
    expect((await heatDetail(admin.token, seeded.eventId, target.id)).heat.status).toBe("PLANNED");

    const startedRound = await rawJson(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID() },
    });
    expect(startedRound.status, JSON.stringify(startedRound.body)).toBe(201);
    expect((await heatDetail(admin.token, seeded.eventId, target.id)).heat.status).toBe("LOADING");

    // Keep both staff Heats and public Race Status open so the skipped state must
    // arrive by live signal and authoritative refetch, never page.reload().
    const staffPage = await page.context().newPage();
    const staffErrors = watchBrowserErrors(staffPage);
    await signIn(staffPage, admin.email);
    await staffPage.goto("/staff#heats");
    const staffHeatButton = staffPage.locator("[data-heat-list] button")
      .filter({ hasText: `Heat ${target.number} ·` });
    await expect(staffHeatButton).toContainText(`Heat ${target.number} · Loading · 3 ducks`);

    await page.goto("/race");
    const heatCard = page.locator(".board-heat").filter({ hasText: `Heat ${target.number}` });
    await expect(heatCard).toBeVisible();
    await expect(heatCard.locator(".board-entry")).toHaveCount(1);

    await changeRegistrationStatus(admin.token, racers[2].registrationId, "withdraw");

    const skipped = await heatDetail(admin.token, seeded.eventId, target.id);
    expect(skipped.heat.status).toBe("CANCELLED");
    expect(skipped.results).toEqual([]);
    expect(slotShape(skipped.roster)).toEqual(before);
    expect(skipped.roster.every((entry) => entry.eligible === false)).toBe(true);

    await expect(staffHeatButton).toContainText(
      `Heat ${target.number} · Cancelled · 3 ducks`,
      { timeout: 20_000 },
    );
    await expect(heatCard.locator(".board-entry")).toHaveCount(0, { timeout: 20_000 });
    await expect(heatCard).toContainText("Not running");
    const publicBoard = await rawJson("/api/v1/race-board");
    expect(publicBoard.status).toBe(200);
    const publicSkipped = publicBoard.body.event.roundOneHeats.find((heat) => heat.number === target.number);
    expect(publicSkipped.status).toBe("CANCELLED");
    expect(publicSkipped.roster).toEqual([]);

    // Settle the genuine contests and prove this skipped heat no longer blocks
    // the lifecycle hand-off into the Final.
    for (const heat of roundOne.filter((candidate) => candidate.id !== target.id)) {
      await runHeatManually(admin.token, seeded.eventId, heat.id);
    }
    const startedFinal = await rawJson(`/api/v1/staff/events/${seeded.eventId}/start-final`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID() },
    });
    expect(startedFinal.status, JSON.stringify(startedFinal.body)).toBe(201);
    expect(startedFinal.body.event.status).toBe("FINAL");
    expect((await heatDetail(admin.token, seeded.eventId, target.id)).heat.status).toBe("CANCELLED");
    expect(errors).toEqual([]);
    expect(staffErrors).toEqual([]);
    await staffPage.close();
  });

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
