import assert from "node:assert/strict";
import test from "node:test";

import { redactE2eOutput } from "../scripts/e2e-redaction.mjs";

const token = "a".repeat(43);

test("E2E server output redacts every credential-bearing URL path", () => {
  for (const path of [
    `/api/v1/staff/ducks/${token}/assignments`,
    `/api/v1/staff/ducks/${token}/heat-winner`,
    `/api/v1/ducks/${token}`,
    `/staff/ducks/${token}`,
    `/t/${token}`,
    `/r/${token}`,
    `/api/v1/registrations/${token}`,
  ]) {
    const redacted = redactE2eOutput(`[wrangler] GET ${path} 200 OK`);
    assert.doesNotMatch(redacted, new RegExp(token));
    assert.match(redacted, /\[redacted\]/);
  }
});

test("E2E server output keeps noncredential identifiers useful", () => {
  assert.equal(
    redactE2eOutput("GET /api/v1/ducks/number/101 200 OK"),
    "GET /api/v1/ducks/number/101 200 OK",
  );
  assert.equal(
    redactE2eOutput("GET /api/v1/staff/registrations/00000000-0000-4000-8000-000000000001 200 OK"),
    "GET /api/v1/staff/registrations/00000000-0000-4000-8000-000000000001 200 OK",
  );
});
