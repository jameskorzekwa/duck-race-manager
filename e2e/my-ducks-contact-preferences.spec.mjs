import { expect, test } from "@playwright/test";

import {
  baseUrl,
  expectNoDocumentOverflow,
  seedState,
  watchBrowserErrors,
} from "./helpers.mjs";

test.describe("owned My Ducks contact preferences", () => {
  test.beforeEach(async () => {
    await seedState("registration", { participants: 1, heatSize: 3 });
  });

  test("views edits cancels and retains participant contact on the originating device", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/register");
    const registration = page.locator("[data-registration-form]");
    await registration.getByLabel("First name").fill("Owned");
    await registration.getByLabel("Last name").fill("Contact");
    await registration.getByLabel(/Email/).fill("owned.contact@example.test");
    await registration.getByLabel("Phone (optional)").fill("+15550107777");
    await registration.getByRole("button", { name: "Register participant" }).click();
    await expect(page).toHaveURL(`${baseUrl}/my-ducks`);

    const card = page.locator("[data-registration-id]").filter({
      has: page.getByRole("heading", { name: "Owned Contact", exact: true }),
    });
    await expect(card).toBeVisible();
    const storedProof = await page.evaluate(() => {
      const proofs = JSON.parse(localStorage.getItem("quickducks.participant-ownership.v1") || "{}");
      return Object.values(proofs)[0];
    });
    expect(storedProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page.url()).not.toContain(storedProof);
    await expect(page.locator("body")).not.toContainText(storedProof);
    const summary = card.locator("[data-contact-summary]");
    await expect(summary).toContainText("Email: owned.contact@example.test");
    await expect(summary).toContainText("Phone: +15550107777");
    await expect(summary).toContainText("Email updates: Not opted in");
    await expect(summary).toContainText("SMS updates: Not opted in");

    const edit = card.getByRole("button", { name: "Edit contact details" });
    await edit.click();
    const form = card.locator("[data-contact-form]");
    await expect(form).toBeVisible();
    const email = form.getByRole("textbox", { name: "Email", exact: true });
    const phone = form.getByRole("textbox", { name: "Phone", exact: true });
    const emailUpdates = form.getByRole("checkbox", {
      name: "Send operational race updates by email",
      exact: true,
    });
    const smsUpdates = form.getByRole("checkbox", {
      name: "Send operational race updates by SMS",
      exact: true,
    });
    await expect(email).toBeFocused();
    await email.fill("discarded@example.test");
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form).toBeHidden();
    await expect(summary).toContainText("Email: owned.contact@example.test");

    await edit.click();
    await email.fill("owned.updated@example.test");
    await phone.fill("+15550108888");
    await emailUpdates.check();
    await smsUpdates.check();
    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && /\/api\/v1\/registrations\/mine\/[0-9a-f-]{36}\/contact$/i.test(new URL(response.url()).pathname));
    await form.getByRole("button", { name: "Save changes" }).click();
    expect((await updateResponse).status()).toBe(200);
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expect(card.locator("[data-contact-form]")).toBeHidden();
    await expect(card.locator("[data-contact-summary]")).toContainText("Email: owned.updated@example.test");
    await expect(card.locator("[data-contact-summary]")).toContainText("Phone: +15550108888");
    await expect(card.locator("[data-contact-summary]")).toContainText("Email updates: Opted in");
    await expect(card.locator("[data-contact-summary]")).toContainText("SMS updates: Opted in");

    await page.reload();
    const refreshed = page.locator("[data-registration-id]").filter({
      has: page.getByRole("heading", { name: "Owned Contact", exact: true }),
    });
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("owned.updated@example.test");
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("+15550108888");

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await refreshed.getByRole("button", { name: "Edit contact details" }).click();
      await expect(refreshed.locator("[data-contact-form]")).toBeVisible();
      await expectNoDocumentOverflow(page);
      await refreshed.getByRole("button", { name: "Cancel" }).click();
    }
    expect(errors).toEqual([]);
  });

  test("unrelated and follower-only browsers never receive owned contact controls", async ({ page, browser }) => {
    await page.goto("/register");
    const registration = page.locator("[data-registration-form]");
    await registration.getByLabel("First name").fill("Followable");
    await registration.getByLabel("Last name").fill("Owner");
    await registration.getByLabel(/Email/).fill("follower.must.not.see@example.test");
    await registration.getByLabel("Phone (optional)").fill("+15550106666");
    await registration.getByRole("button", { name: "Register participant" }).click();
    await expect(page.getByRole("button", { name: "Edit contact details" })).toBeVisible();
    const ownership = await page.evaluate(() => {
      const proofs = JSON.parse(localStorage.getItem("quickducks.participant-ownership.v1") || "{}");
      const [registrationId, proof] = Object.entries(proofs)[0] || [];
      return { registrationId, proof };
    });
    expect(ownership.registrationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ownership.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    const automaticContactRequests = [];
    other.on("request", (request) => {
      if (/\/registrations\/mine\/[0-9a-f-]{36}\/contact$/i.test(new URL(request.url()).pathname)) {
        automaticContactRequests.push(request.url());
      }
    });
    await other.goto("/my-ducks");
    await expect(other.locator("[data-contact-summary], [data-contact-edit]")).toHaveCount(0);

    const denied = async (method) => other.evaluate(async ({ registrationId, proof, method }) => {
      const response = await fetch(`/api/v1/registrations/mine/${registrationId}/contact`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-quickducks-ownership-proof": proof,
        },
        body: method === "PATCH" ? JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: 0,
          email: "denied@example.test",
          phone: "+15550100000",
          emailNotificationsEnabled: true,
          smsNotificationsEnabled: true,
        }) : undefined,
      });
      return response.status;
    }, { ...ownership, method });

    expect(await denied("GET")).toBe(404);
    expect(await denied("PATCH")).toBe(404);
    await other.getByLabel("Participant name").fill("Followable Owner");
    await other.getByRole("button", { name: "Find status" }).click();
    const result = other.locator("[data-search-results] .duck-card").filter({ hasText: "Followable O." });
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: "Add to My Ducks" }).click();
    await expect(other.getByRole("heading", { name: "Ducks I’m Following" })).toBeVisible();
    const followed = other.locator('[data-participant-section="followed"] [data-registration-id]');
    await expect(followed).toBeVisible();
    await expect(followed.locator("[data-contact-summary], [data-contact-edit], [data-contact-form]")).toHaveCount(0);
    await expect(other.locator("main")).not.toContainText("follower.must.not.see@example.test");
    await expect(other.locator("main")).not.toContainText("+15550106666");
    // Rendering a public followed card must not probe the private endpoint. The
    // only contact requests in this context are the explicit denied probes.
    expect(automaticContactRequests).toHaveLength(2);
    expect(await denied("GET")).toBe(404);
    expect(await denied("PATCH")).toBe(404);
    expect(automaticContactRequests).toHaveLength(4);
    await otherContext.close();

    await page.reload();
    await expect(page.locator("[data-contact-summary]")).toContainText("follower.must.not.see@example.test");
    await expect(page.locator("[data-contact-summary]")).toContainText("+15550106666");
  });
});
