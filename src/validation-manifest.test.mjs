import assert from "node:assert/strict";
import test from "node:test";

import { assertValidationManifest, buildValidationManifest } from "../scripts/validation-manifest.mjs";

const manifestInput = {
  repository: "owner/repo",
  runId: 123,
  runAttempt: 2,
  issue: 156,
  baseSha: "a".repeat(40),
  patchDigest: "b".repeat(64),
  treeSha: "c".repeat(40),
  packageLockDigest: "d".repeat(64),
  nodeVersion: "v24.1.0",
  completedAt: "2026-08-02T00:00:00.000Z",
};

test("validation manifests bind a tested tree to task provenance", () => {
  const manifest = buildValidationManifest(manifestInput);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(assertValidationManifest(manifest, {
    repository: "owner/repo",
    runId: 123,
    runAttempt: 2,
    issue: 156,
    baseSha: "a".repeat(40),
    patchDigest: "b".repeat(64),
    treeSha: "c".repeat(40),
  }).treeSha, "c".repeat(40));
});

test("validation manifests fail closed on identity drift", () => {
  const manifest = buildValidationManifest(manifestInput);
  assert.throws(
    () => assertValidationManifest(manifest, { treeSha: "e".repeat(40) }),
    /treeSha does not match/,
  );
  assert.throws(
    () => buildValidationManifest({ ...manifestInput, patchDigest: "not-a-digest" }),
    /patchDigest has an invalid format/,
  );
});
