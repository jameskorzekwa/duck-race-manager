import assert from "node:assert/strict";
import test from "node:test";

import { registrationScript, staffDuckScript, staffHomeScript } from "./client-scripts.ts";

test("browser clients are valid JavaScript and target protected APIs", () => {
  assert.doesNotThrow(() => new Function(registrationScript));
  assert.doesNotThrow(() => new Function(staffDuckScript));
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.match(registrationScript, /\/api\/v1\/registrations/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/ducks/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/registrations\/search/);
  assert.match(staffDuckScript, /\/dispositions/);
  assert.match(staffHomeScript, /\/api\/v1\/staff\/events\/return-review/);
  assert.match(staffHomeScript, /\/purge-ready/);
  assert.match(staffHomeScript, /\/api\/v1\/staff\/profiles/);
  assert.match(staffHomeScript, /Regular staff/);
  assert.match(staffHomeScript, /Administrator/);
});
