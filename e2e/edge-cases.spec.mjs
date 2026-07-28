import { expect, test } from "@playwright/test";

import { localPreviewTurnstileToken } from "../src/local-preview.ts";
import { randomToken } from "../scripts/seed-local.mjs";
import {
  accountWith,
  baseUrl,
  bootstrap,
  rawJson,
  rejectSensitiveKeys,
  seedState,
  signIn,
} from "./helpers.mjs";

test.describe("race edge cases", () => {
  test("enforces lifecycle blockers and the single-event invariant", async () => {
    const seeded = await seedState("registration");
    const { admin } = await bootstrap();

    const premature = await rawJson(`/api/v1/staff/events/${seeded.eventId}/start-round-one`, {
      token: admin.token,
      method: "POST",
      body: { commandId: crypto.randomUUID() },
    });
    expect(premature.status).toBe(409);
    expect(premature.body.readiness.blockers.join(" ")).toMatch(/registration|paired/i);

    const second = await rawJson("/api/v1/staff/events", {
      token: admin.token,
      method: "POST",
      body: {
        commandId: crypto.randomUUID(),
        name: "Forbidden Second Event",
        eventDate: "2030-07-01",
        roundOneHeatCapacity: 3,
      },
    });
    expect(second.status).toBe(409);

    const malformed = await rawJson("/api/v1/registrations", {
      method: "POST",
      body: {
        eventId: seeded.eventId,
        commandId: crypto.randomUUID(),
        privateToken: randomToken(),
        firstName: "",
        lastName: "Racer",
        turnstileToken: localPreviewTurnstileToken,
      },
    });
    expect(malformed.status).toBe(422);
  });

  test("replays matching commands and rejects command reuse and stale revisions", async () => {
    const seeded = await seedState("draft");
    const { admin } = await bootstrap();
    const commandId = crypto.randomUUID();
    const path = `/api/v1/staff/events/${seeded.eventId}/configuration`;
    const payload = { commandId, revision: seeded.event.revision, timezone: "UTC" };

    const first = await rawJson(path, { token: admin.token, method: "PATCH", body: payload });
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    const replay = await rawJson(path, { token: admin.token, method: "PATCH", body: payload });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    const reused = await rawJson(path, {
      token: admin.token,
      method: "PATCH",
      body: { ...payload, timezone: "Europe/Lisbon" },
    });
    expect(reused.status).toBe(409);

    const stale = await rawJson(path, {
      token: admin.token,
      method: "PATCH",
      body: { commandId: crypto.randomUUID(), revision: seeded.event.revision, timezone: "America/New_York" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.event.revision).toBe(first.body.event.revision);
  });

  test("requires exact Origin for cookie-authenticated mutations", async ({ page }) => {
    const seeded = await seedState("draft");
    const { admin } = await bootstrap();
    await signIn(page, admin.email);
    const path = `${baseUrl}/api/v1/staff/events/${seeded.eventId}/configuration`;

    const missing = await page.request.patch(path, {
      data: { commandId: crypto.randomUUID(), revision: seeded.event.revision, timezone: "UTC" },
    });
    expect(missing.status()).toBe(403);

    const hostile = await page.request.patch(path, {
      headers: { origin: "https://attacker.invalid" },
      data: { commandId: crypto.randomUUID(), revision: seeded.event.revision, timezone: "UTC" },
    });
    expect(hostile.status()).toBe(403);

    const exact = await page.request.patch(path, {
      headers: { origin: baseUrl },
      data: { commandId: crypto.randomUUID(), revision: seeded.event.revision, timezone: "UTC" },
    });
    expect(exact.status()).toBe(200);
  });

  test("keeps role pages least-privileged", async ({ browser }) => {
    const seeded = await seedState("round-one");
    const protectedPages = [
      ["Announcer", "/staff/announcer"],
      ["Start line", "/staff/start-line"],
      ["Finish line", "/staff/finish-line"],
      ["Inventory", "/staff/inventory"],
      ["Access", "/staff/access"],
    ];
    const matrix = [
      ["ANNOUNCER", "/staff/announcer", "Read this out loud", ["Console", "Announcer"]],
      ["HEAT_RUNNER", "/staff/start-line", "Prepare the next heat", ["Console", "Start line"]],
      ["RESULT_TAKER", "/staff/finish-line", "Record one official result", ["Console", "Finish line"]],
      ["DUCK_MANAGER", "/staff/inventory", "Inventory", ["Console", "Inventory"]],
      ["REGISTRATION", "/staff", "Race control, in one place", ["Console"]],
      [
        "RACE_DIRECTOR", "/staff", "Race control, in one place",
        ["Console", "Announcer", "Start line", "Finish line", "Inventory"],
      ],
    ];

    for (const [role, path, heading, expectedNavigation] of matrix) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const account = accountWith(seeded.accounts, role);
      await signIn(page, account.email, path);
      await expect(page.getByRole("heading", { name: new RegExp(heading, "i") })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Staff pages" }).getByRole("link")).toHaveText(expectedNavigation);
      for (const [label, protectedPath] of protectedPages) {
        const response = await page.goto(protectedPath);
        expect(response.status(), `${role} opening ${label}`).toBe(expectedNavigation.includes(label) ? 200 : 403);
      }
      await context.close();
    }
  });

  test("keeps public projections free of private participant and inventory data", async () => {
    const seeded = await seedState("completed");
    const current = await rawJson("/api/v1/events/current");
    const board = await rawJson("/api/v1/race-board");
    const duck = await rawJson(`/api/v1/ducks/number/${seeded.participants[0].visibleNumber}`);
    const search = await rawJson(
      `/api/v1/race-status/search?eventId=${encodeURIComponent(seeded.eventId)}&name=${encodeURIComponent(seeded.participants[0].firstName)}`,
    );

    for (const response of [current, board, duck, search]) {
      expect(response.status).toBe(200);
      rejectSensitiveKeys(response.body);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain("@example.test");
      expect(serialized).not.toContain("+1555010");
      expect(serialized).not.toContain("Intake table");
      const credentials = seeded.participants.flatMap((participant) =>
        [participant.privateToken, participant.lookupCode, participant.tagToken].filter(Boolean)
      );
      expect(
        credentials.some((credential) => serialized.includes(credential)),
        "public response contained a generated private, lookup, or tag credential",
      ).toBe(false);
    }
  });
});
