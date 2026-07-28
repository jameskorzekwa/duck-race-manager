import { expect, test } from "@playwright/test";

import { localPreviewTurnstileToken } from "../src/local-preview.ts";
import { randomToken } from "../scripts/seed-local.mjs";
import {
  baseUrl,
  bootstrap,
  confirmAction,
  expectNoDocumentOverflow,
  finalizeHeat,
  intakeDuck,
  pairDuck,
  registerParticipant,
  seedState,
  signIn,
  transitionHeat,
  watchBrowserErrors,
} from "./helpers.mjs";

test.describe("complete race journey", () => {
  test.beforeEach(async () => {
    await seedState("empty");
  });

  test("drives a race from empty through results and complete deletion", async ({ page }) => {
    test.setTimeout(240_000);
    const errors = watchBrowserErrors(page);
    const { admin, client } = await bootstrap();
    const eventName = "Playwright Harbor Derby";
    const eventDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

    await test.step("empty public and staff state", async () => {
      await page.goto("/");
      await expect(page.getByText(/The next race is being prepared/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Register" })).toHaveCount(0);
      await page.goto("/my-ducks");
      await expect(page).toHaveURL(`${baseUrl}/`);

      await signIn(page, admin.email);
      await expect(page.getByText("No race yet.")).toBeVisible();
      await expect(page.locator("[data-event-create-form]")).toBeVisible();
    });

    let event;
    await test.step("create and configure a draft", async () => {
      const create = page.locator("[data-event-create-form]");
      await create.getByLabel("Event name").fill(eventName);
      const dateInput = create.locator('input[name="eventDate"]');
      const datePicker = dateInput.locator("xpath=..");
      await datePicker.locator(".app-date-trigger").click();
      const datePanel = datePicker.locator(".app-date-panel");
      if (await datePanel.locator(`[data-date-value="${eventDate}"]`).count() === 0) {
        await datePanel.getByRole("button", { name: "Next month" }).click();
      }
      await datePanel.locator(`[data-date-value="${eventDate}"]`).click();
      await expect(dateInput).toHaveValue(eventDate);
      await create.getByLabel("Ducks per heat").fill("3");
      await create.getByRole("button", { name: "Create draft event" }).click();
      await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

      event = (await client.get("/api/v1/staff/events")).body.events[0];
      expect(event.name).toBe(eventName);
      expect(event.status).toBe("DRAFT");

      const configurationCard = page.locator("[data-event-config-card]");
      await configurationCard.getByText("Configure draft", { exact: true }).click();
      const configuration = page.locator("[data-event-config-form]");
      await configuration.locator('select[name="publicNamePolicy"]').selectOption("FIRST_NAME_LAST_INITIAL");
      await configuration.getByLabel("Final capacity").fill("3");
      await configuration.getByRole("button", { name: "Save draft configuration" }).click();
      await expect(page.locator("[data-console-message]")).toHaveText("All operation areas are current.");

      await page.getByRole("button", { name: "Open registration", exact: true }).click();
      await confirmAction(page);
      await expect(page.getByText("Registration open", { exact: true }).first()).toBeVisible();
    });

    const participants = [];
    await test.step("register through the public form and bulk the remaining entrants", async () => {
      await page.goto("/register");
      const form = page.locator("[data-registration-form]");
      await form.getByLabel("First name").fill("Browser");
      await form.getByLabel("Last name").fill("Racer");
      await form.getByLabel(/Email/).fill("browser.racer@example.test");
      await form.getByLabel("Phone (optional)").fill("+15550200000");
      await form.getByRole("button", { name: "Register participant" }).click();
      await expect(page).toHaveURL(`${baseUrl}/my-ducks`);
      const registrations = (await client.get(
        `/api/v1/staff/events/${event.id}/registrations?q=${encodeURIComponent("browser.racer@example.test")}`,
      )).body.registrations;
      const firstBody = registrations.find((registration) => registration.email === "browser.racer@example.test");
      expect(firstBody).toBeTruthy();
      participants.push({
        firstName: "Browser",
        lastName: "Racer",
        registrationId: firstBody.registrationId,
        lookupCode: firstBody.lookupCode,
      });
      await expect(page.getByText("Registration saved.")).toBeVisible();
      expect(page.url()).not.toContain("privateToken");

      for (let index = 2; index <= 9; index += 1) {
        participants.push(await registerParticipant(client, event.id, index));
      }
      expect(participants).toHaveLength(9);
    });

    const ducks = [];
    await test.step("intake ducks and pair one through the browser", async () => {
      for (let index = 0; index < participants.length; index += 1) {
        ducks.push(await intakeDuck(client, event.id, 101 + index));
      }
      for (let index = 1; index < participants.length; index += 1) {
        await pairDuck(client, event.id, ducks[index], participants[index]);
      }

      await page.goto(`/staff/ducks/${ducks[0].tagToken}`);
      await expect(page.locator(".staff-panel")).toHaveCSS("background-color", "rgb(255, 253, 243)");
      await expect(page.locator("[data-registration-search-status]")).toContainText("waiting for a duck");
      // Let any initial live refresh finish before selecting a row; a refresh
      // intentionally clears an in-progress pairing review.
      await page.waitForTimeout(500);
      const search = page.getByLabel("Participant code, name, phone, or email");
      await search.fill(participants[0].firstName);
      await page.getByRole("button", { name: "Find participant" }).click();
      await page.getByRole("button", { name: /Browser Racer/ }).evaluate((row) => {
        row.click();
        const confirm = document.querySelector("[data-confirm-pairing]");
        if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
          throw new Error("Pairing selection did not enable confirmation.");
        }
        confirm.click();
      });
      await expect(page.getByRole("heading", { name: "Duck #101 paired" })).toBeVisible();
      await expect(page.locator("[data-staff-message]")).toHaveText("Duck paired successfully.");

      // Pairing seals this duck into a numbered heat bag it never comes out of,
      // so the race flow is not honest without the panel that names the bag.
      // It stays up until the staffer says the duck is physically in it.
      const bagPanel = page.locator("[data-heat-bag]");
      await expect(bagPanel).toBeVisible();
      await expect(page.locator("[data-heat-bag-instruction]")).toHaveText(/^Put this duck in HEAT \d+ bag$/);
      await expect(page.locator("[data-heat-bag-duck]")).toHaveText("Duck #101");
      await page.locator("[data-heat-bag-dismiss]").click();
      await expect(bagPanel).toBeHidden();

      const listed = (await client.get(`/api/v1/staff/events/${event.id}/heats`)).body.heats;
      expect(listed.filter((heat) => heat.round === "ROUND_ONE")).toHaveLength(3);

      await page.goto("/my-ducks");
      const duckLink = page.getByRole("link", { name: "Duck #101", exact: true });
      const nameButton = page.getByRole("button", { name: "Name this duck", exact: true });
      await expect(nameButton).toBeVisible();
      const [duckBox, nameBox] = await Promise.all([duckLink.boundingBox(), nameButton.boundingBox()]);
      expect(nameBox.y).toBeGreaterThanOrEqual(duckBox.y + duckBox.height);
    });

    await test.step("close registration and reject late entry", async () => {
      await page.goto("/staff");
      await page.getByRole("button", { name: "Close registration", exact: true }).click();
      await confirmAction(page);
      await expect(page.getByText("Registration closed", { exact: true }).first()).toBeVisible();

      const late = await client.request("/api/v1/registrations", {
        method: "POST",
        anonymous: true,
        body: {
          eventId: event.id,
          commandId: crypto.randomUUID(),
          privateToken: randomToken(),
          firstName: "Late",
          lastName: "Racer",
          turnstileToken: localPreviewTurnstileToken,
        },
        expect: [409],
      });
      expect(late.status).toBe(409);

      await page.getByRole("button", { name: "Start round one", exact: true }).click();
      await confirmAction(page);
      await expect(page.getByText("Round one", { exact: true }).first()).toBeVisible();
    });

    await test.step("run and publish round-one heats", async () => {
      const initialHeats = (await client.get(`/api/v1/staff/events/${event.id}/heats`)).body.heats;
      const firstHeat = initialHeats.find((heat) => heat.round === "ROUND_ONE" && heat.number === 1);
      const firstHeatDetail = (await client.get(
        `/api/v1/staff/events/${event.id}/heats/${firstHeat.id}`,
      )).body;
      const winnerDuck = ducks.find(
        (duck) => duck.visibleNumber === firstHeatDetail.roster[0].duck.visibleNumber,
      );
      expect(winnerDuck).toBeTruthy();

      await page.goto("/staff/start-line");
      await page.getByRole("button", { name: "Mark Heat Ready" }).click();
      await page.getByRole("button", { name: "Heat Has Been Announced" }).click();
      await page.getByRole("button", { name: "Start This Heat" }).click();
      await confirmAction(page);
      await expect(page.locator("[data-station-message]")).toContainText("running", { ignoreCase: true });

      await page.goto("/staff/finish-line");
      await page.getByRole("button", { name: "Mark heat finished" }).click();
      await expect(page.locator("[data-station-message]")).toContainText("Scan the winning duck");

      await page.goto(`/staff/ducks/${winnerDuck.tagToken}`);
      await page.getByRole("button", { name: "Mark Duck as Heat 1 Winner" }).click();
      await confirmAction(page, "Mark winner");
      await expect.poll(async () => {
        const heats = (await client.get(`/api/v1/staff/events/${event.id}/heats`)).body.heats;
        return heats.find((heat) => heat.round === "ROUND_ONE" && heat.number === 1)?.status;
      }).toBe("FINALIZED");

      const heats = (await client.get(`/api/v1/staff/events/${event.id}/heats`)).body.heats
        .filter((heat) => heat.round === "ROUND_ONE")
        .sort((left, right) => left.number - right.number);
      for (const heat of heats.slice(1)) {
        const detail = (await client.get(`/api/v1/staff/events/${event.id}/heats/${heat.id}`)).body;
        Object.assign(heat, detail.heat);
        await transitionHeat(client, event.id, heat, "ready");
        await transitionHeat(client, event.id, heat, "call");
        await transitionHeat(client, event.id, heat, "start");
        await transitionHeat(client, event.id, heat, "finish");
        await finalizeHeat(client, event.id, heat, [{ raceEntryId: detail.roster[0].raceEntryId, place: 1 }]);
      }
    });

    let finalDetail;
    await test.step("promote finalists and publish the final podium", async () => {
      await page.goto("/staff");
      await page.getByRole("button", { name: "Start final", exact: true }).click();
      await confirmAction(page);

      await page.goto("/staff/start-line");
      await page.getByRole("button", { name: "Mark Heat Ready" }).click();
      await page.getByRole("button", { name: "Heat Has Been Announced" }).click();
      await page.getByRole("button", { name: "Start This Heat" }).click();
      await confirmAction(page);

      await page.goto("/staff/finish-line");
      await page.getByRole("button", { name: "Mark heat finished" }).click();
      const finalHeat = (await client.get(`/api/v1/staff/events/${event.id}/heats`)).body.heats
        .find((heat) => heat.round === "FINAL");
      finalDetail = (await client.get(`/api/v1/staff/events/${event.id}/heats/${finalHeat.id}`)).body;
      for (const entry of finalDetail.roster.slice(0, 3)) {
        await page.getByLabel("Tag URL or duck number").fill(String(entry.duck.visibleNumber));
        await page.getByRole("button", { name: "Add this duck" }).click();
      }
      await expect(page.getByRole("button", { name: "Submit official podium" })).toBeEnabled();
      await page.getByRole("button", { name: "Submit official podium" }).click();
      await confirmAction(page);
      await expect(page.locator("[data-station-message]")).toContainText("Official result saved");
    });

    await test.step("complete the event and verify public results", async () => {
      await page.goto("/staff");
      await page.getByRole("button", { name: "Complete event", exact: true }).click();
      await confirmAction(page);
      await page.goto("/race");
      await expect(page.getByRole("heading", { name: "Official podium" })).toBeVisible();
      await expect(page.getByText("Winner", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Results official", { exact: true })).toBeVisible();
    });

    await test.step("delete the complete dataset and leave staff access intact", async () => {
      await page.goto("/staff");
      await page.locator("[data-open-force-delete]").click();
      const deleteDialog = page.locator("[data-force-delete-dialog]");
      await deleteDialog.locator('input[name="confirmName"]').fill(eventName);
      await deleteDialog.getByRole("button", { name: "Delete event", exact: true }).click();
      await expect(page.getByText("No race yet.")).toBeVisible();

      await page.goto("/duck/101");
      await expect(page.getByRole("heading", { name: /Duck #101 isn.t racing/ })).toBeVisible();
      await page.goto("/");
      await expect(page.getByText(/The next race is being prepared/)).toBeVisible();
      expect((await client.get("/api/v1/staff/events")).body.events).toEqual([]);
      await expect(page.getByRole("link", { name: "Staff" })).toBeVisible();
    });

    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoDocumentOverflow(page);
    const expectedDeletedDuckErrors = errors.filter((error) => error.includes("404 (Not Found)"));
    expect(expectedDeletedDuckErrors).toHaveLength(1);
    expect(errors.filter((error) => !error.includes("404 (Not Found)"))).toEqual([]);
  });
});
