import assert from "node:assert/strict";
import test from "node:test";

import { checkD1RolePreflight } from "../scripts/check-d1-role-preflight.mjs";
import { checkWorkerSecrets, requiredWorkerSecrets } from "../scripts/check-worker-secrets.mjs";
import {
  assessReleaseVersion,
  assertReleaseCommitAncestry,
  parseReleaseTag,
} from "../scripts/release-version.mjs";

test("release tag parsing uses strict SemVer and exact prerelease state", () => {
  assert.deepEqual(parseReleaseTag("v1.2.3"), { version: "1.2.3", prerelease: false });
  assert.deepEqual(parseReleaseTag("v1.2.3-rc.1"), { version: "1.2.3-rc.1", prerelease: true });
  assert.deepEqual(parseReleaseTag("v1.2.3-alpha-beta"), { version: "1.2.3-alpha-beta", prerelease: true });
  assert.deepEqual(parseReleaseTag("v1.2.3+build-1"), { version: "1.2.3+build-1", prerelease: false });
  assert.deepEqual(parseReleaseTag("v1.2.3-rc-1+build-2"), {
    version: "1.2.3-rc-1+build-2",
    prerelease: true,
  });

  for (const tag of ["1.2.3", "v01.2.3", "v1.2.3-01", "v1.2.3-alpha..1", "v1.2.3-"]) {
    assert.throws(() => parseReleaseTag(tag), /semantic version|v prefix/);
  }
});

test("release versions are monotonic and same-version reruns require the recorded commit", () => {
  const base = { incomingVersion: "1.2.3", incomingCommit: "new-sha" };
  assert.equal(assessReleaseVersion(base), "first");
  assert.throws(
    () => assessReleaseVersion({ ...base, currentCommit: "old-sha" }),
    /Commit tag but no Version tag/,
  );
  assert.equal(assessReleaseVersion({
    ...base,
    currentVersion: "1.2.3",
    currentCommit: "new-sha",
  }), "recovery");
  assert.throws(() => assessReleaseVersion({
    ...base,
    currentVersion: "1.2.3",
    currentCommit: "other-sha",
  }), /commit already recorded/);
  assert.equal(assessReleaseVersion({
    ...base,
    currentVersion: "1.2.2",
    currentCommit: "old-sha",
  }), "upgrade");
  assert.throws(() => assessReleaseVersion({
    ...base,
    currentVersion: "1.2.2",
  }), /Version tag but no Commit tag/);
  assert.throws(() => assessReleaseVersion({
    ...base,
    currentVersion: "1.2.4",
    currentCommit: "old-sha",
  }), /must be greater/);
  assert.throws(() => assessReleaseVersion({
    incomingVersion: "1.2.3+build-2",
    incomingCommit: "new-sha",
    currentVersion: "1.2.3+build-1",
    currentCommit: "old-sha",
  }), /must be greater/);
});

test("higher releases require the recorded commit to be an available ancestor", () => {
  const oldCommit = "1".repeat(40);
  const newCommit = "2".repeat(40);
  const statuses = (mergeStatus, unavailableCommit) => (args) => ({
    status: args[0] === "cat-file"
      ? Number(args[2].startsWith(unavailableCommit ?? "-"))
      : mergeStatus,
  });

  assert.doesNotThrow(() => assertReleaseCommitAncestry({ incomingCommit: newCommit }, () => ({ status: 99 })));
  assert.doesNotThrow(() => assertReleaseCommitAncestry(
    { currentCommit: oldCommit, incomingCommit: newCommit },
    statuses(0),
  ));
  assert.throws(() => assertReleaseCommitAncestry(
    { currentCommit: oldCommit, incomingCommit: newCommit },
    statuses(1),
  ), /does not descend/);
  assert.throws(() => assertReleaseCommitAncestry(
    { currentCommit: oldCommit, incomingCommit: newCommit },
    statuses(0, oldCommit),
  ), /recorded release commit .* unavailable/);
  assert.throws(() => assertReleaseCommitAncestry(
    { currentCommit: "not-a-commit", incomingCommit: newCommit },
    statuses(0),
  ), /full lowercase Git commit SHA/);
  assert.throws(() => assertReleaseCommitAncestry(
    { currentCommit: oldCommit, incomingCommit: newCommit },
    statuses(2),
  ), /could not verify/);
});

const d1Result = (roleTableExists, activeNonAdminExists, unmappedActiveNonAdminExists) => [{
  results: [{
    role_table_exists: Number(roleTableExists),
    active_non_admin_exists: Number(activeNonAdminExists),
    unmapped_active_non_admin_exists: Number(unmappedActiveNonAdminExists),
  }],
  success: true,
}];

test("D1 role preflight blocks every active regular profile without an active role", () => {
  assert.deepEqual(checkD1RolePreflight(d1Result(false, false, false)), {
    roleTableExists: false,
    activeNonAdminExists: false,
    unmappedActiveNonAdminExists: false,
  });
  assert.deepEqual(checkD1RolePreflight(d1Result(true, false, false)), {
    roleTableExists: true,
    activeNonAdminExists: false,
    unmappedActiveNonAdminExists: false,
  });
  assert.deepEqual(checkD1RolePreflight(d1Result(true, true, false)), {
    roleTableExists: true,
    activeNonAdminExists: true,
    unmappedActiveNonAdminExists: false,
  });
  assert.throws(() => checkD1RolePreflight(d1Result(false, true, true)), /explicit reviewed role-mapping migration/);
  assert.throws(() => checkD1RolePreflight(d1Result(true, true, true)), /explicit reviewed role-mapping migration/);
});

test("Worker secret preflight requires names without inspecting values", () => {
  assert.doesNotThrow(() => checkWorkerSecrets(requiredWorkerSecrets.map((name) => ({ name }))));
  assert.throws(
    () => checkWorkerSecrets(requiredWorkerSecrets.slice(1).map((name) => ({ name }))),
    /AWS_ACCESS_KEY_ID/,
  );
});
