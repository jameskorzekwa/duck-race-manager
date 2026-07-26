import assert from "node:assert/strict";
import test from "node:test";

import { staffHomeScript } from "./client-scripts.ts";

test("staff operations console script is valid, DOM-safe, and covers every operation module", () => {
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.doesNotMatch(staffHomeScript, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(staffHomeScript, /textContent/);
  assert.match(staffHomeScript, /replaceChildren/);

  for (const endpoint of [
    "/api/v1/staff/events",
    "/api/v1/staff/registrations/",
    "/api/v1/staff/inventory/ducks",
    "/heats/round-one/plan-preview",
    "/results/",
    "/api/v1/staff/profiles/",
    "/api/v1/staff/support/events/",
    "/return-batches",
    "/purge-claim",
    "/purge",
  ]) {
    assert.ok(staffHomeScript.includes(endpoint), `missing endpoint ${endpoint}`);
  }
});
