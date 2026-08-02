import { expect, test } from "@playwright/test";

import {
  accountWith,
  baseUrl,
  bootstrap,
  expectNoDocumentOverflow,
  rawJson,
  seedState,
  signIn,
  watchBrowserErrors,
} from "./helpers.mjs";

test.describe("owned My Ducks contact preferences", () => {
  test.beforeEach(async () => {
    await seedState("registration", { participants: 1, heatSize: 3 });
  });

  test("views edits cancels and retains participant contact on the originating device", async ({ page }, testInfo) => {
    // This suite intentionally exercises several authoritative My Ducks
    // refreshes. Keep its production-equivalent rate-limit budget independent
    // from the search-filtering scenario and from a previous failed retry.
    await page.context().setExtraHTTPHeaders({
      "cf-connecting-ip": `192.0.2.${170 + testInfo.retry}`,
    });
    const errors = watchBrowserErrors(page);
    await page.goto("/register");
    const currentEvent = await rawJson("/api/v1/events/current");
    const directPublicRejection = await rawJson("/api/v1/registrations", {
      method: "POST",
      body: {
        eventId: currentEvent.body.event.id,
        commandId: crypto.randomUUID(),
        privateToken: "x".repeat(43),
        firstName: "Direct",
        lastName: "Rejection",
        email: "direct@example.test",
        phone: "81732",
        emailNotificationsEnabled: false,
        smsNotificationsEnabled: false,
        turnstileToken: "validation-runs-first",
      },
    });
    expect(directPublicRejection.status).toBe(422);
    expect(directPublicRejection.body.fields.phone).toBe("Enter a valid 10-digit US phone number.");
    const registration = page.locator("[data-registration-form]");
    let registrationPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/registrations") {
        registrationPosts += 1;
      }
    });
    await registration.getByLabel("First name").fill("Owned");
    await registration.getByLabel("Last name").fill("Contact");
    await registration.getByLabel(/Email/).fill("owned.contact@");
    await expect(registration.locator('[data-contact-error="email"]')).toHaveText("Enter a valid email address.");
    await expect(registration.getByRole("checkbox", { name: "Send operational race updates by email" })).toBeDisabled();
    await registration.getByRole("button", { name: "Register participant" }).click();
    expect(registrationPosts).toBe(0);
    await registration.getByLabel(/Email/).fill("owned.contact@example.test");
    const registrationPhone = registration.getByLabel("Phone (optional)");
    await registrationPhone.pressSequentially("8173206150");
    await expect(registrationPhone).toHaveValue("(817) 320-6150");
    await registrationPhone.evaluate((input) => {
      input.value = "817-320-6150";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    });
    await expect(registrationPhone).toHaveValue("(817) 320-6150");
    await registrationPhone.press("End");
    await registrationPhone.press("Backspace");
    await expect(registrationPhone).toHaveValue("(817) 320-615");
    await expect(registration.getByRole("checkbox", { name: "Send operational race updates by SMS" })).toBeDisabled();
    await registration.getByRole("button", { name: "Register participant" }).click();
    expect(registrationPosts).toBe(0);
    await registrationPhone.press("0");
    await registrationPhone.evaluate((input) => input.setSelectionRange(2, 3));
    await registrationPhone.press("9");
    await expect(registrationPhone).toHaveValue("(897) 320-6150");
    await registrationPhone.evaluate((input) => input.setSelectionRange(2, 3));
    await registrationPhone.press("1");
    await expect(registrationPhone).toHaveValue("(817) 320-6150");
    await registration.getByRole("checkbox", { name: "Send operational race updates by email" }).check();
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
    await expect(summary).toContainText("Phone: (817) 320-6150");
    await expect(summary).toContainText("Email updates: Opted in");
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
    await phone.fill("8173208888");
    await emailUpdates.check();
    await smsUpdates.check();
    await phone.fill("");
    await expect(smsUpdates).toBeDisabled();
    await expect(smsUpdates).not.toBeChecked();
    await phone.fill("8173208888");
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
    await expect(card.locator("[data-contact-summary]")).toContainText("Phone: (817) 320-8888");
    await expect(card.locator("[data-contact-summary]")).toContainText("Email updates: Opted in");
    await expect(card.locator("[data-contact-summary]")).toContainText("SMS updates: Opted in");

    await page.reload();
    const refreshed = page.locator("[data-registration-id]").filter({
      has: page.getByRole("heading", { name: "Owned Contact", exact: true }),
    });
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("owned.updated@example.test");
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("(817) 320-8888");
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("Email updates: Opted in");
    await expect(refreshed.locator("[data-contact-summary]")).toContainText("SMS updates: Opted in");

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await refreshed.getByRole("button", { name: "Edit contact details" }).click();
      await expect(refreshed.locator("[data-contact-form]")).toBeVisible();
      await expectNoDocumentOverflow(page);
      await refreshed.getByRole("button", { name: "Cancel" }).click();
    }
    expect(errors).toEqual([]);
  });

  test("unrelated and follower-only browsers never receive owned contact controls", async ({ page, browser }, testInfo) => {
    await page.context().setExtraHTTPHeaders({
      "cf-connecting-ip": `192.0.2.${180 + (testInfo.retry * 2)}`,
    });
    await page.goto("/register");
    const registration = page.locator("[data-registration-form]");
    await registration.getByLabel("First name").fill("Followable");
    await registration.getByLabel("Last name").fill("Owner");
    await registration.getByLabel(/Email/).fill("follower.must.not.see@example.test");
    await registration.getByLabel("Phone (optional)").fill("8173206666");
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
    await otherContext.setExtraHTTPHeaders({
      "cf-connecting-ip": `192.0.2.${181 + (testInfo.retry * 2)}`,
    });
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
    await expect(other.locator("main")).not.toContainText("(817) 320-6666");
    // Rendering a public followed card must not probe the private endpoint. The
    // only contact requests in this context are the explicit denied probes.
    expect(automaticContactRequests).toHaveLength(2);
    expect(await denied("GET")).toBe(404);
    expect(await denied("PATCH")).toBe(404);
    expect(automaticContactRequests).toHaveLength(4);
    await otherContext.close();

    await page.reload();
    await expect(page.locator("[data-contact-summary]")).toContainText("follower.must.not.see@example.test");
    await expect(page.locator("[data-contact-summary]")).toContainText("(817) 320-6666");
  });

  test("staff creates validates and edits both contact preferences", async ({ page }) => {
    const { accounts, client } = await bootstrap();
    const registrationStaff = accountWith(accounts, "REGISTRATION");
    const event = (await client.get("/api/v1/staff/events")).body.events[0];
    await signIn(page, registrationStaff.email, "/staff/registration");

    await page.locator("summary", { hasText: "Add walk-up participant" }).click();
    const walkUp = page.locator("[data-walkup-form]");
    await expect(walkUp).toBeVisible();
    await walkUp.getByLabel("First name").fill("Staff");
    await walkUp.getByLabel("Last name").fill("Consent");
    await walkUp.getByLabel("Email", { exact: true }).fill("staff.consent@example.test");
    await walkUp.getByLabel("Phone", { exact: true }).fill("8173206123");
    await expect(walkUp.getByLabel("Phone", { exact: true })).toHaveValue("(817) 320-6123");
    await walkUp.getByRole("checkbox", { name: "Send operational race updates by SMS" }).check();
    const createdResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/v1/staff/events/${event.id}/registrations`);
    await walkUp.getByRole("button", { name: "Create walk-up" }).click();
    const created = await (await createdResponse).json();
    expect(created.registration.phone).toBe("(817) 320-6123");
    expect(created.registration.emailNotificationsEnabled).toBe(false);
    expect(created.registration.smsNotificationsEnabled).toBe(true);

    const edit = page.locator("[data-participant-edit-form]");
    await expect(edit).toBeVisible();
    await expect(edit.getByRole("checkbox", { name: "Send operational race updates by SMS" })).toBeChecked();
    let patchRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH" && new URL(request.url()).pathname.endsWith(created.registration.registrationId)) {
        patchRequests += 1;
      }
    });
    await edit.getByLabel("Phone", { exact: true }).fill("81732");
    await edit.getByRole("button", { name: "Save participant details" }).click();
    await expect(edit.locator('[data-contact-error="phone"]')).toHaveText("Enter a valid 10-digit US phone number.");
    expect(patchRequests).toBe(0);

    await edit.getByLabel("Phone", { exact: true }).fill("8173206124");
    await edit.getByRole("checkbox", { name: "Send operational race updates by email" }).check();
    await edit.getByRole("checkbox", { name: "Send operational race updates by SMS" }).uncheck();
    const updatedResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && new URL(response.url()).pathname.endsWith(created.registration.registrationId));
    await edit.getByRole("button", { name: "Save participant details" }).click();
    expect((await updatedResponse).status()).toBe(200);
    await expect(page.locator("[data-participant-facts]")).toContainText("(817) 320-6124");
    await expect(page.locator("[data-participant-facts]")).toContainText("Email updatesOpted in");
    await expect(page.locator("[data-participant-facts]")).toContainText("SMS updatesNot opted in");

    const direct = await rawJson(`/api/v1/staff/registrations/${created.registration.registrationId}`, {
      token: registrationStaff.token,
      method: "PATCH",
      body: {
        commandId: crypto.randomUUID(),
        expectedRevision: 1,
        phone: "81732",
        smsNotificationsEnabled: false,
      },
    });
    expect(direct.status).toBe(422);
    expect(direct.body.fields.phone).toBe("Enter a valid 10-digit US phone number.");
  });
});
