import assert from "node:assert/strict";
import test from "node:test";

import { readBrowserRegistrations, registrationCookie } from "./browser-registrations.ts";

const first = {
  name: "Daisy Duck",
  lookupCode: "ABCD2345",
  statusPath: `/r/${"a".repeat(43)}`,
};

test("persists browser registrations in a hardened host-only cookie", () => {
  const cookie = registrationCookie(null, first);

  assert.match(cookie, /^__Host-quickducks-registrations=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.deepEqual(readBrowserRegistrations(cookie), [first]);
});

test("accumulates and deduplicates registrations from one browser", () => {
  const second = {
    name: "Donald Duck",
    lookupCode: "WXYZ6789",
    statusPath: `/r/${"b".repeat(43)}`,
  };
  const firstCookie = registrationCookie(null, first);
  const secondCookie = registrationCookie(firstCookie, second);
  const replayCookie = registrationCookie(secondCookie, first);

  assert.deepEqual(readBrowserRegistrations(replayCookie), [second, first]);
});

test("ignores malformed or attacker-controlled cookie entries", () => {
  const malformed = `__Host-quickducks-registrations=${encodeURIComponent(JSON.stringify([
    first,
    { name: "Bad", lookupCode: "NOT A CODE", statusPath: "https://example.com" },
  ]))}`;

  assert.deepEqual(readBrowserRegistrations(malformed), [first]);
  assert.deepEqual(readBrowserRegistrations("__Host-quickducks-registrations=broken"), []);
});
