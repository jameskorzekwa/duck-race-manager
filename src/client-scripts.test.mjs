import assert from "node:assert/strict";
import test from "node:test";

import { registrationScript, staffDuckScript } from "./client-scripts.ts";

test("browser clients are valid JavaScript and target protected APIs", () => {
  assert.doesNotThrow(() => new Function(registrationScript));
  assert.doesNotThrow(() => new Function(staffDuckScript));
  assert.match(registrationScript, /\/api\/v1\/registrations/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/ducks/);
  assert.match(staffDuckScript, /\/api\/v1\/staff\/registrations\/search/);
});
