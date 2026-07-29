import { expect, test } from "@playwright/test";

import { baseUrl, expectNoDocumentOverflow, seedState, watchBrowserErrors } from "./helpers.mjs";

test.describe("owned My Ducks contact details", () => {
  test.beforeEach(async () => {
    await seedState("registration");
  });

  test("views, edits, persists, and denies copied proof on other devices", async ({ browser, page }) => {
    const errors = watchBrowserErrors(page);
    const firstName = "Contactproof";
    const lastName = "Owner";
    const originalEmail = "contact.owner@example.test";
    const originalPhone = "+15550123456";
    const updatedEmail = "contact.updated@example.test";
    const updatedPhone = "+15550654321";

    await page.goto("/register");
    const registrationForm = page.locator("[data-registration-form]");
    await registrationForm.getByLabel("First name").fill(firstName);
    await registrationForm.getByLabel("Last name").fill(lastName);
    await registrationForm.getByLabel(/Email/).fill(originalEmail);
    await registrationForm.getByLabel("Phone (optional)").fill(originalPhone);
    await registrationForm.getByRole("button", { name: "Register participant" }).click();
    await expect(page).toHaveURL(`${baseUrl}/my-ducks`);

    const ownerCard = page.locator("article.participant-card").filter({ hasText: `${firstName} ${lastName}` });
    await expect(ownerCard).toContainText(originalEmail);
    await expect(ownerCard).toContainText(originalPhone);
    await expect(ownerCard.getByText("Not opted in", { exact: true })).toHaveCount(2);
    const edit = ownerCard.getByRole("button", { name: "Edit contact details", exact: true });
    await expect(edit).toBeVisible();

    await edit.click();
    const contactForm = ownerCard.locator("[data-contact-form]");
    await expect(contactForm).toBeVisible();
    await expect(contactForm.getByLabel("Email (optional)")).toHaveValue(originalEmail);
    await expect(contactForm.getByLabel("Phone (optional)")).toHaveValue(originalPhone);
    await contactForm.getByLabel("Email (optional)").fill("discarded@example.test");
    await contactForm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(contactForm).toBeHidden();
    await expect(ownerCard).toContainText(originalEmail);
    await expect(ownerCard).not.toContainText("discarded@example.test");

    await edit.click();
    await contactForm.getByLabel("Email (optional)").fill(updatedEmail);
    await contactForm.getByLabel("Phone (optional)").fill(updatedPhone);
    await contactForm.getByLabel("Receive operational race updates by email").check();
    await contactForm.getByLabel("Receive operational race updates by text message").check();
    await contactForm.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(ownerCard).toContainText(updatedEmail);
    await expect(ownerCard).toContainText(updatedPhone);
    await expect(ownerCard.getByText("Opted in", { exact: true })).toHaveCount(2);
    await expect(contactForm).toBeHidden();

    await page.reload();
    const persistedCard = page.locator("article.participant-card").filter({ hasText: `${firstName} ${lastName}` });
    await expect(persistedCard).toContainText(updatedEmail);
    await expect(persistedCard).toContainText(updatedPhone);
    await expect(persistedCard.getByText("Opted in", { exact: true })).toHaveCount(2);
    const ownerPrivate = await page.evaluate(async (name) => {
      const response = await fetch("/api/v1/registrations/mine", { cache: "no-store" });
      const body = await response.json();
      return body.registrations.find((registration) => registration.displayName === name);
    }, `${firstName} ${lastName}`);
    expect(ownerPrivate.ownershipProof).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.setViewportSize({ width: 320, height: 800 });
    await persistedCard.getByRole("button", { name: "Edit contact details", exact: true }).click();
    await expect(persistedCard.locator("[data-contact-form]")).toBeVisible();
    await expectNoDocumentOverflow(page);
    await persistedCard.getByRole("button", { name: "Cancel", exact: true }).click();

    const followerContext = await browser.newContext();
    const follower = await followerContext.newPage();
    await follower.goto("/my-ducks");
    const search = follower.locator("[data-status-search-section]");
    await search.getByLabel("Participant name").fill(`${firstName} ${lastName}`);
    await search.getByRole("button", { name: "Find status" }).click();
    await search.getByRole("button", { name: "Add to My Ducks" }).click();
    await expect(search.getByText("In My Ducks", { exact: true })).toBeVisible();
    await follower.reload();
    const followedCard = follower.locator("article.participant-card").filter({ hasText: `${firstName} O.` });
    await expect(followedCard).toBeVisible();
    await expect(followedCard.getByRole("button", { name: /Edit contact/i })).toHaveCount(0);
    await expect(followedCard).not.toContainText(updatedEmail);
    await expect(followedCard).not.toContainText(updatedPhone);
    await expect(followedCard).not.toContainText("Email opt-in");
    await expect(followedCard).not.toContainText("SMS opt-in");

    const followerReadStatus = await follower.evaluate(async ({ registrationId, proof }) => {
      const response = await fetch(`/api/v1/registrations/mine/${registrationId}/contact`, {
        headers: { "x-quickducks-ownership-proof": proof },
      });
      return response.status;
    }, { registrationId: ownerPrivate.registrationId, proof: ownerPrivate.ownershipProof });
    expect(followerReadStatus).toBe(404);
    const followerWriteStatus = await follower.evaluate(async ({ registrationId, proof }) => {
      const response = await fetch(`/api/v1/registrations/mine/${registrationId}/contact`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-quickducks-ownership-proof": proof,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: 1,
          email: "stolen@example.test",
          phone: null,
          emailNotificationsEnabled: false,
          smsNotificationsEnabled: false,
        }),
      });
      return response.status;
    }, { registrationId: ownerPrivate.registrationId, proof: ownerPrivate.ownershipProof });
    expect(followerWriteStatus).toBe(404);

    const unrelatedContext = await browser.newContext();
    const unrelated = await unrelatedContext.newPage();
    await unrelated.goto("/my-ducks");
    const unrelatedStatus = await unrelated.evaluate(async ({ registrationId, proof }) => {
      const response = await fetch(`/api/v1/registrations/mine/${registrationId}/contact`, {
        headers: { "x-quickducks-ownership-proof": proof },
      });
      return response.status;
    }, { registrationId: ownerPrivate.registrationId, proof: ownerPrivate.ownershipProof });
    expect(unrelatedStatus).toBe(404);

    await follower.goto("/race");
    await expect(follower.locator("body")).not.toContainText(updatedEmail);
    await expect(follower.locator("body")).not.toContainText(updatedPhone);
    await unrelatedContext.close();
    await followerContext.close();
    expect(errors).toEqual([]);
  });
});
