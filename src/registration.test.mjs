import assert from "node:assert/strict";
import test from "node:test";

import {
  hashToken,
  isCommandId,
  isPrivateToken,
  randomLookupCode,
  randomToken,
  validateRegistration,
} from "./registration.ts";

const validForm = () => {
  const form = new FormData();
  form.set("first_name", "  Daisy  ");
  form.set("last_name", " Duck ");
  form.set("email", "DAISY@example.com");
  form.set("phone", "555-0100");
  form.set("email_notifications_enabled", "on");
  form.set("duck_keep_preference", "RETURN");
  return form;
};

test("validates and normalizes a registration", () => {
  const result = validateRegistration(validForm(), true);

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value, {
    firstName: "Daisy",
    lastName: "Duck",
    email: "daisy@example.com",
    phone: "555-0100",
    emailNotificationsEnabled: true,
    duckKeepPreference: "RETURN",
  });
});

test("enforces required names and event email policy", () => {
  const form = new FormData();
  const result = validateRegistration(form, true);

  assert.equal(result.value, undefined);
  assert.equal(result.errors.first_name, "Enter a first name.");
  assert.equal(result.errors.last_name, "Enter a last name.");
  assert.equal(result.errors.email, "Email is required for this race.");
});

test("disables notifications when email is omitted", () => {
  const form = validForm();
  form.delete("email");
  const result = validateRegistration(form, false);

  assert.equal(result.value?.email, null);
  assert.equal(result.value?.emailNotificationsEnabled, false);
});

test("creates URL-safe private tokens and deterministic hashes", async () => {
  const token = randomToken();

  assert.equal(token.length, 43);
  assert.equal(isPrivateToken(token), true);
  assert.equal(await hashToken(token), await hashToken(token));
  assert.notEqual(await hashToken(token), token);
});

test("creates non-authentication lookup codes and validates command IDs", () => {
  assert.match(randomLookupCode(), /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(isCommandId(crypto.randomUUID()), true);
  assert.equal(isCommandId("not-a-command"), false);
});
