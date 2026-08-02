import assert from "node:assert/strict";
import test from "node:test";

import {
  hashToken,
  isCommandId,
  isPrivateToken,
  normalizeUsPhone,
  randomLookupCode,
  randomToken,
  validateContactPreferences,
  validateRegistration,
} from "./registration.ts";

const validForm = () => {
  const form = new FormData();
  form.set("first_name", "  Daisy  ");
  form.set("last_name", " Duck ");
  form.set("email", "DAISY@example.com");
  form.set("phone", "+1 (817) 320-6150");
  form.set("email_notifications_enabled", "on");
  form.set("sms_notifications_enabled", "on");
  form.set("duck_keep_preference", "KEEP");
  return form;
};

test("validates and normalizes a registration", () => {
  const result = validateRegistration(validForm(), true);

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value, {
    firstName: "Daisy",
    lastName: "Duck",
    email: "daisy@example.com",
    phone: "(817) 320-6150",
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: true,
  });
  assert.equal("duckKeepPreference" in result.value, false);
});

test("enforces required names and event email policy", () => {
  const form = new FormData();
  const result = validateRegistration(form, true);

  assert.equal(result.value, undefined);
  assert.equal(result.errors.first_name, "Enter a first name.");
  assert.equal(result.errors.last_name, "Enter a last name.");
  assert.equal(result.errors.email, "Email is required for this race.");
});

test("rejects notification consent when its contact channel is omitted", () => {
  const form = validForm();
  form.delete("email");
  const result = validateRegistration(form, false);

  assert.equal(result.value, undefined);
  assert.equal(result.errors.email_notifications_enabled, "Add an email address before choosing email updates.");
});

test("normalizes US phone punctuation and rejects every incomplete or malformed contact", () => {
  for (const input of ["8173206150", "817-320-6150", "+1 817 320 6150", "(817) 320-6150"]) {
    assert.equal(normalizeUsPhone(input), "(817) 320-6150", input);
  }
  for (const input of ["817320615", "81732061500", "+44 817 320 6150", "817-CALL-NOW", "8173206150 x2"]) {
    assert.equal(normalizeUsPhone(input), null, input);
  }

  const cases = [
    [{ email: "missing-domain@", phone: null, emailNotificationsEnabled: false, smsNotificationsEnabled: false }, "email"],
    [{ email: null, phone: "817320615", emailNotificationsEnabled: false, smsNotificationsEnabled: false }, "phone"],
    [{ email: null, phone: null, emailNotificationsEnabled: true, smsNotificationsEnabled: false }, "emailNotificationsEnabled"],
    [{ email: null, phone: null, emailNotificationsEnabled: false, smsNotificationsEnabled: true }, "smsNotificationsEnabled"],
  ];
  for (const [input, field] of cases) {
    const result = validateContactPreferences(input, false);
    assert.equal(result.value, undefined);
    assert.ok(result.errors[field], field);
  }
});

test("keeps optional channels and independent consent choices", () => {
  assert.deepEqual(validateContactPreferences({
    email: null,
    phone: null,
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
  }, false).value, {
    email: null,
    phone: null,
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: false,
  });
  assert.deepEqual(validateContactPreferences({
    email: " RACER@EXAMPLE.TEST ",
    phone: "817.320.6150",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: true,
  }, false).value, {
    email: "racer@example.test",
    phone: "(817) 320-6150",
    emailNotificationsEnabled: false,
    smsNotificationsEnabled: true,
  });
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
