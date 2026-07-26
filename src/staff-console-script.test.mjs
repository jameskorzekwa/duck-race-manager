import assert from "node:assert/strict";
import test from "node:test";

import { staffHomeScript } from "./client-scripts.ts";
import {
  renderFinishLine,
  renderInventoryIntake,
  renderStaffDuck,
  renderStaffHome,
  renderStartLine,
} from "./site.ts";

test("staff operations console script is valid, DOM-safe, and covers every operation module", () => {
  assert.doesNotThrow(() => new Function(staffHomeScript));
  assert.doesNotMatch(staffHomeScript, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(staffHomeScript, /textContent/);
  assert.match(staffHomeScript, /replaceChildren/);
  assert.match(staffHomeScript, /assignedRoles/);
  assert.match(staffHomeScript, /canRunHeat/);
  assert.match(staffHomeScript, /canTakeResults/);
  assert.match(staffHomeScript, /staffRoleLabels/);
  assert.match(staffHomeScript, /Select at least one operational role/);

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

test("every staff page signs out through an accessible POST form without JavaScript", () => {
  const pages = [
    renderStaffHome("Staff Member", false, ["REGISTRATION"]),
    renderStartLine("Staff Member"),
    renderFinishLine("Staff Member"),
    renderInventoryIntake("Staff Member", "https://quickducks.com"),
    renderStaffDuck("tag-token", "Staff Member"),
  ];

  for (const markup of pages) {
    assert.match(markup, /<form class="staff-logout" method="post" action="\/staff\/logout"><button type="submit">Sign out<\/button><\/form>/);
    assert.doesNotMatch(markup, /<a[^>]+href="\/staff\/logout"/);
    assert.doesNotMatch(markup, /<form class="staff-logout"[^>]+(?:onsubmit|data-)/);
  }
});
