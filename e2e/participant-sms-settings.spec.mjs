import { expect, test } from "@playwright/test";

import { bootstrap, seedState, signIn, watchBrowserErrors } from "./helpers.mjs";

test("event SMS defaults off and the administrator switch controls participant surfaces", async ({ page }) => {
  await seedState("registration", { participants: 1, heatSize: 3, smsEnabled: false });
  const { admin, client } = await bootstrap();
  await client.request("/__local/emails", { method: "DELETE", expect: [204] });
  await client.request("/__local/sms", { method: "DELETE", expect: [204] });
  const errors = watchBrowserErrors(page);

  await page.goto("/register");
  const registration = page.locator("[data-registration-form]");
  await expect(registration.getByLabel("Phone (optional)")).toHaveCount(0);
  await expect(registration.getByRole("checkbox", { name: "Send operational race updates by SMS" })).toHaveCount(0);
  await expect(registration.getByRole("checkbox", { name: "Send operational race updates by email" })).toBeVisible();

  await signIn(page, admin.email, "/staff");
  const smsSetting = page.getByRole("checkbox", { name: "Enable SMS updates for this event" });
  await expect(smsSetting).toBeVisible();
  await expect(smsSetting).not.toBeChecked();
  const expectStaffSmsControls = async (count) => {
    for (const selector of ["[data-walkup-form]", "[data-participant-edit-form]"]) {
      const staffForm = page.locator(selector);
      await expect(staffForm.locator('input[name="phone"]')).toHaveCount(count);
      await expect(staffForm.locator('input[name="smsNotificationsEnabled"]')).toHaveCount(count);
    }
  };
  await expectStaffSmsControls(0);
  await smsSetting.check();
  const enabledResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && /\/api\/v1\/staff\/events\/[^/]+\/sms-notifications$/.test(new URL(response.url()).pathname));
  await page.locator("[data-event-sms-form]").getByRole("button", { name: "Save SMS setting" }).click();
  const enabledHttpResponse = await enabledResponse;
  expect(enabledHttpResponse.status()).toBe(200);
  expect((await enabledHttpResponse.json()).event.smsNotificationsEnabled).toBe(true);
  await expect(smsSetting).toBeChecked();
  await expectStaffSmsControls(1);

  await page.goto("/register");
  const enabledForm = page.locator("[data-registration-form]");
  await enabledForm.getByLabel("First name").fill("Text");
  await enabledForm.getByLabel("Last name").fill("Racer");
  await enabledForm.getByLabel(/Email/).fill("text.racer@example.test");
  await enabledForm.getByLabel("Phone (optional)").fill("8173206199");
  await enabledForm.getByRole("checkbox", { name: "Send operational race updates by email" }).check();
  await enabledForm.getByRole("checkbox", { name: "Send operational race updates by SMS" }).check();
  await enabledForm.getByRole("button", { name: "Register participant" }).click();
  await expect(page).toHaveURL(/\/my-ducks$/);

  await expect.poll(async () => {
    const [emailResponse, smsResponse] = await Promise.all([
      client.get("/__local/emails"),
      client.get("/__local/sms"),
    ]);
    return {
      emails: emailResponse.body.emails
        .filter((email) => email.to === "text.racer@example.test").length,
      sms: smsResponse.body.messages
        .filter((message) => message.to === "+18173206199").length,
    };
  }, {
    timeout: 30_000,
  }).toEqual({ emails: 1, sms: 1 });

  await page.goto("/staff");
  await expect(smsSetting).toBeChecked();
  await smsSetting.uncheck();
  const disabledResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && /\/api\/v1\/staff\/events\/[^/]+\/sms-notifications$/.test(new URL(response.url()).pathname));
  await page.locator("[data-event-sms-form]").getByRole("button", { name: "Save SMS setting" }).click();
  const disabledHttpResponse = await disabledResponse;
  expect(disabledHttpResponse.status()).toBe(200);
  expect((await disabledHttpResponse.json()).event.smsNotificationsEnabled).toBe(false);
  await expect(smsSetting).not.toBeChecked();
  await expectStaffSmsControls(0);

  await page.goto("/register");
  await expect(page.getByLabel("Phone (optional)")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Send operational race updates by SMS" })).toHaveCount(0);
  await page.goto("/my-ducks");
  const card = page.locator("[data-registration-id]").filter({ hasText: "Text Racer" });
  await expect(card.locator("[data-contact-summary]")).toContainText("Email updates: Opted in");
  await expect(card.locator("[data-contact-summary]")).not.toContainText("Phone:");
  await expect(card.locator("[data-contact-summary]")).not.toContainText("SMS updates:");
  expect(errors).toEqual([]);
});
