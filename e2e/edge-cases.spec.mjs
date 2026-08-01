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
      ["Registration", "/staff/registration"],
      ["Announcer", "/staff/announcer"],
      ["Start line", "/staff/start-line"],
      ["Finish line", "/staff/finish-line"],
      ["Inventory", "/staff/inventory"],
    ];
    // Each role's landing page, the pages it may open, the persistent nav it is
    // offered, and whether `/staff` gives it the Admin view or sends it on.
    //
    // `RACE_DIRECTOR` is the race-day role for changing the state of the overall
    // race, and every control that does so lives inside the Admin view, so a
    // race director opens it exactly as an administrator does. `is_system_admin`
    // remains an account type, and it alone unlocks Support and Access.
    //
    // `navigation` and `opens` are deliberately not the same list for the finish
    // line. Recording a heat winner is open to every race-day role — see
    // `winnerRecordingRoles` — because whoever is standing at the water when a
    // heat ends is the only person who saw which duck arrived first, and that is
    // not reliably the one staffer holding `RESULT_TAKER`. So the station that
    // records a winner admits the announcer and the heat runner too, rather than
    // sending them off to find somebody else with the next heat already forming
    // up behind them. The nav still answers "which station is yours" and keeps
    // offering the finish line only to the result taker and the race director,
    // so the widening changes who is admitted without changing whose station it
    // is. The registration desk and the duck manager are not on the water, cannot
    // read a heat at all, and are still refused.
    const matrix = [
      {
        role: "ANNOUNCER",
        landing: "/staff/announcer",
        heading: "Read this out loud",
        navigation: ["Announcer"],
        opens: ["Announcer", "Finish line"],
        adminView: false,
      },
      {
        role: "HEAT_RUNNER",
        landing: "/staff/start-line",
        heading: "Prepare the next heat",
        navigation: ["Start line"],
        opens: ["Start line", "Finish line"],
        adminView: false,
      },
      {
        role: "RESULT_TAKER",
        landing: "/staff/finish-line",
        heading: "Record one official result",
        navigation: ["Finish line"],
        opens: ["Finish line"],
        adminView: false,
      },
      {
        role: "DUCK_MANAGER",
        landing: "/staff/inventory",
        heading: "Inventory",
        navigation: ["Inventory"],
        opens: ["Inventory"],
        adminView: false,
      },
      {
        role: "REGISTRATION",
        landing: "/staff/registration",
        heading: "Get people into the race",
        navigation: ["Registration"],
        opens: ["Registration"],
        adminView: false,
      },
      {
        role: "RACE_DIRECTOR",
        landing: "/staff",
        heading: "Race control, in one place",
        // Inventory leaves the top-level nav because the Admin menu bar carries
        // it, exactly as it does for an administrator.
        navigation: ["Admin", "Registration", "Announcer", "Start line", "Finish line"],
        opens: ["Registration", "Announcer", "Start line", "Finish line", "Inventory"],
        adminView: true,
      },
    ];

    for (const { role, landing, heading, navigation, opens, adminView } of matrix) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const account = accountWith(seeded.accounts, role);
      expect(account.isSystemAdmin, `${role} must be a regular staff account`).toBe(false);
      await signIn(page, account.email, landing);
      await expect(page.getByRole("heading", { name: new RegExp(heading, "i") })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Staff pages" }).getByRole("link")).toHaveText(navigation);
      for (const [label, protectedPath] of protectedPages) {
        const response = await page.goto(protectedPath);
        expect(response.status(), `${role} opening ${label}`).toBe(opens.includes(label) ? 200 : 403);
      }
      // Staff access management is administrator-only for every operational
      // role, race director included.
      const access = await page.goto("/staff/access");
      expect(access.status(), `${role} opening Access`).toBe(403);

      // `/staff` never refuses a regular staff member: it is either their Admin
      // view or a redirect to the page their own roles open.
      const staff = await page.request.get("/staff", { maxRedirects: 0 });
      if (adminView) {
        expect(staff.status(), `${role} opening the Admin view`).toBe(200);
        await page.goto("/staff");
        const menu = page.getByRole("navigation", { name: "Admin views" });
        await expect(menu.getByRole("link")).toHaveText([
          "Event Details",
          "Heats",
          "Participants",
          "Inventory",
        ]);
        // Support, Access, and every administrator-only card stay absent.
        await expect(page.locator("#support")).toHaveCount(0);
        await expect(page.locator("[data-event-create-form]")).toHaveCount(0);
        await expect(page.locator("[data-event-config-form]")).toHaveCount(0);
        await expect(page.locator("[data-force-delete-card], [data-open-force-delete]")).toHaveCount(0);
      } else {
        expect(staff.status(), `${role} opening the Admin view`).toBe(303);
        expect(staff.headers().location, `${role} landing page`).toBe(landing);
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
