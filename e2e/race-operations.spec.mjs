import { expect, test } from "@playwright/test";

import { accountWith, rawJson, seedState } from "./helpers.mjs";

test.describe("race operation conflicts and recovery", () => {
  test("resets a running heat without changing its locked roster", async () => {
    const seeded = await seedState("round-one");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const running = listed.body.heats.find((heat) => heat.status === "RUNNING");
    const before = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, { token: admin.token });

    const reset = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/reset`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: running.revision },
    });
    expect(reset.status).toBe(201);
    expect(reset.body.heat.status).toBe("LOADING");

    const after = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}`, { token: admin.token });
    expect(after.body.roster.map((entry) => entry.raceEntryId)).toEqual(
      before.body.roster.map((entry) => entry.raceEntryId),
    );

    const stale = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/ready`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: running.revision },
    });
    expect(stale.status).toBe(409);

    const current = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${running.id}/ready`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: reset.body.heat.revision },
    });
    expect(current.status).toBe(201);
    expect(current.body.heat.status).toBe("READY");
  });

  test("invalidates a stale final station after correcting a promoted winner", async () => {
    const seeded = await seedState("final");
    const admin = seeded.accounts.find((account) => account.isSystemAdmin);
    const listed = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats`, { token: admin.token });
    const finalHeat = listed.body.heats.find((heat) => heat.round === "FINAL");
    const qualifier = listed.body.heats.find((heat) => heat.round === "ROUND_ONE" && heat.number === 1);

    const reset = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}/reset`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: finalHeat.revision },
    });
    expect(reset.status).toBe(201);
    expect(reset.body.heat.status).toBe("LOADING");

    const qualifierDetail = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${qualifier.id}`,
      { token: admin.token },
    );
    const oldWinner = qualifierDetail.body.results[0].raceEntryId;
    const replacement = qualifierDetail.body.roster.find((entry) => entry.raceEntryId !== oldWinner);
    const correction = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${qualifier.id}/results/correct`,
      {
        token: admin.token,
        method: "POST",
        body: {
          commandId: crypto.randomUUID(),
          revision: qualifierDetail.body.heat.revision,
          reason: "Playwright verifies promoted winner correction.",
          results: [{ raceEntryId: replacement.raceEntryId, place: 1 }],
        },
      },
    );
    expect(correction.status).toBe(201);

    const correctedFinal = await rawJson(
      `/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}`,
      { token: admin.token },
    );
    expect(correctedFinal.body.heat.revision).toBe(reset.body.heat.revision + 1);
    expect(correctedFinal.body.roster.some((entry) => entry.raceEntryId === replacement.raceEntryId)).toBe(true);

    const staleReady = await rawJson(`/api/v1/staff/events/${seeded.eventId}/heats/${finalHeat.id}/ready`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID(), revision: reset.body.heat.revision },
    });
    expect(staleReady.status).toBe(409);
  });

  test("force deletion is administrator-only, exact-name gated, and valid in every lifecycle state", async () => {
    test.setTimeout(180_000);
    for (const state of ["draft", "registration", "closed", "round-one", "final", "completed"]) {
      const seeded = await seedState(state);
      const admin = seeded.accounts.find((account) => account.isSystemAdmin);
      const director = accountWith(seeded.accounts, "RACE_DIRECTOR");
      const events = await rawJson("/api/v1/staff/events", { token: admin.token });
      const event = events.body.events[0];
      const path = `/api/v1/staff/events/${event.id}/force-delete`;

      const denied = await rawJson(path, {
        token: director.token,
        method: "POST",
        body: { commandId: crypto.randomUUID(), revision: event.revision, confirmName: event.name },
      });
      expect(denied.status, `${state} director delete`).toBe(403);

      const mistyped = await rawJson(path, {
        token: admin.token,
        method: "POST",
        body: { commandId: crypto.randomUUID(), revision: event.revision, confirmName: "Wrong Event" },
      });
      expect(mistyped.status, `${state} wrong-name delete`).toBe(422);

      const deleted = await rawJson(path, {
        token: admin.token,
        method: "POST",
        body: { commandId: crypto.randomUUID(), revision: event.revision, confirmName: event.name },
      });
      expect(deleted.status, `${state} administrator delete`).toBe(200);
      expect((await rawJson("/api/v1/events/current")).body.event).toBeNull();
    }
  });
});
