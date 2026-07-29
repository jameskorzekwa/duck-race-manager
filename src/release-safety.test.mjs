import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkD1RolePreflight } from "../scripts/check-d1-role-preflight.mjs";
import { isLocalPreviewOrigin, isLoopbackOrigin } from "./local-preview.ts";
import { checkWorkerSecrets, requiredWorkerSecrets } from "../scripts/check-worker-secrets.mjs";
import {
  assessReleaseVersion,
  assertReleaseCommitAncestry,
  parseReleaseTag,
  selectAutomaticRelease,
} from "../scripts/release-version.mjs";

const readRepositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const releaseWorkflow = readRepositoryFile(".github/workflows/release.yml");

test("release tag parsing uses strict SemVer and exact prerelease state", () => {
  assert.deepEqual(parseReleaseTag("v1.2.3"), { tag: "v1.2.3", version: "1.2.3", prerelease: false });
  assert.deepEqual(parseReleaseTag("v1.2.3-rc.1"), {
    tag: "v1.2.3-rc.1",
    version: "1.2.3-rc.1",
    prerelease: true,
  });
  assert.deepEqual(parseReleaseTag("v1.2.3-alpha-beta"), {
    tag: "v1.2.3-alpha-beta",
    version: "1.2.3-alpha-beta",
    prerelease: true,
  });
  assert.deepEqual(parseReleaseTag("v1.2.3+build-1"), {
    tag: "v1.2.3+build-1",
    version: "1.2.3+build-1",
    prerelease: false,
  });
  assert.deepEqual(parseReleaseTag("v1.2.3-rc-1+build-2"), {
    tag: "v1.2.3-rc-1+build-2",
    version: "1.2.3-rc-1+build-2",
    prerelease: true,
  });

  for (const tag of ["1.2.3", "v01.2.3", "v1.2.3-01", "v1.2.3-alpha..1", "v1.2.3-"]) {
    assert.throws(() => parseReleaseTag(tag), /semantic version|v prefix/);
  }
});

const automaticGit = ({ tags, commits = {}, listStatus = 0, resolveStatus = 0 }) => (args) => {
  if (args[0] === "tag") {
    return { status: listStatus, stdout: `${tags.join("\n")}${tags.length > 0 ? "\n" : ""}` };
  }
  if (args[0] === "rev-parse") {
    const tag = args[2].replace(/^refs\/tags\//, "").replace(/\^\{commit\}$/, "");
    return { status: resolveStatus, stdout: commits[tag] ? `${commits[tag]}\n` : "" };
  }
  throw new Error(`Unexpected Git command: ${args.join(" ")}`);
};

const tagExistenceGit = (status) => (args) => {
  assert.deepEqual(args.slice(0, 3), ["show-ref", "--verify", "--quiet"]);
  return { status };
};

test("automatic releases increment one patch from the highest stable tag", () => {
  const previousSha = "1".repeat(40);
  const sourceSha = "2".repeat(40);
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.0.0", "v1.1.0"],
    commits: { "v1.1.0": previousSha },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
});

test("automatic release recovery reuses the highest tag at the source SHA", () => {
  const sourceSha = "2".repeat(40);
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0", "v1.1.1"],
    commits: { "v1.1.1": sourceSha },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
});

test("automatic releases ignore prereleases when selecting the stable base", () => {
  const sourceSha = "2".repeat(40);
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0", "v9.0.0-rc.1"],
    commits: { "v1.1.0": "1".repeat(40) },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
  // A prerelease tag at the source commit itself is still not a stable base.
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0", "v1.2.0-rc.1"],
    commits: { "v1.1.0": "1".repeat(40), "v1.2.0-rc.1": sourceSha },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
});

test("a deployed explicit prerelease never blocks the next automatic stable release", () => {
  const prereleaseSha = "3".repeat(40);
  const sourceSha = "4".repeat(40);
  // Derivation ignores the deployed prerelease and continues the stable train.
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.2.0", "v1.3.0-rc.1"],
    commits: { "v1.2.0": "1".repeat(40), "v1.3.0-rc.1": prereleaseSha },
  })), {
    tag: "v1.2.1",
    version: "1.2.1",
    prerelease: false,
  });
  // The stack gate accepts the lower-precedence stable release after the
  // prerelease deployment; ancestry is proven separately.
  const gitCalls = [];
  assert.equal(assessReleaseVersion({
    currentVersion: "1.3.0-rc.1",
    currentCommit: prereleaseSha,
    incomingVersion: "1.2.1",
    incomingCommit: sourceSha,
  }, (args) => { gitCalls.push(args); return { status: 0 }; }), "stable-after-prerelease");
  assert.equal(gitCalls.length, 0, "Precedence handling for prereleases must not need Git");
  // Lower stable over deployed stable and lower prerelease over deployed
  // prerelease both still fail closed.
  assert.throws(() => assessReleaseVersion({
    currentVersion: "1.2.2",
    currentCommit: prereleaseSha,
    incomingVersion: "1.2.1",
    incomingCommit: sourceSha,
  }), /must be greater/);
  assert.throws(() => assessReleaseVersion({
    currentVersion: "1.3.0-rc.2",
    currentCommit: prereleaseSha,
    incomingVersion: "1.3.0-rc.1",
    incomingCommit: sourceSha,
  }), /must be greater/);
});

test("automatic releases ignore malformed, noncanonical, and build-metadata-ambiguous tags", () => {
  const sourceSha = "2".repeat(40);
  // Malformed and noncanonical tags matching v*.*.* are ignored, not trusted.
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v01.1.0", "v1.1.0.0", "v1.2.3-01", "v1.1.0"],
    commits: { "v1.1.0": "1".repeat(40) },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
  // Equal-precedence build-metadata variants agree on the next patch and do
  // not deadlock automatic releases.
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0", "v1.1.0+build.1"],
    commits: { "v1.1.0": "1".repeat(40), "v1.1.0+build.1": "1".repeat(40) },
  })), {
    tag: "v1.1.1",
    version: "1.1.1",
    prerelease: false,
  });
  // Incrementing a highest stable tag with build metadata drops the metadata.
  assert.deepEqual(selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.0.0", "v1.2.0+hotfix-1"],
    commits: { "v1.2.0+hotfix-1": "1".repeat(40) },
  })), {
    tag: "v1.2.1",
    version: "1.2.1",
    prerelease: false,
  });
  // With no stable canonical tag at all, automatic releases fail closed.
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v01.1.0"],
  })), /at least one stable/);
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v2.0.0-rc.1"],
  })), /at least one stable/);
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: [],
  })), /at least one stable/);
});

test("automatic releases fail closed on malformed SHAs and Git errors", () => {
  let gitCalled = false;
  assert.throws(() => selectAutomaticRelease({ sourceSha: "not-a-sha" }, () => {
    gitCalled = true;
    return { status: 0, stdout: "" };
  }), /full lowercase Git commit SHA/);
  assert.equal(gitCalled, false);

  const sourceSha = "2".repeat(40);
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0"],
    listStatus: 2,
  })), /Git could not list release tags/);
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0"],
    resolveStatus: 128,
  })), /Git could not resolve highest stable release tag/);
  assert.throws(() => selectAutomaticRelease({ sourceSha }, automaticGit({
    tags: ["v1.1.0"],
  })), /full lowercase commit SHA/);
});

test("a deployed-but-untagged release completes on a rerun of the same source", () => {
  const previousSha = "1".repeat(40);
  const deployedSha = "2".repeat(40);
  // Deployment of commit A succeeded as v1.2.1 but tag creation failed. A
  // rerun of A derives the same patch because the tag was never created...
  assert.deepEqual(selectAutomaticRelease({ sourceSha: deployedSha }, automaticGit({
    tags: ["v1.2.0"],
    commits: { "v1.2.0": previousSha },
  })), {
    tag: "v1.2.1",
    version: "1.2.1",
    prerelease: false,
  });
  // ...and the stack gate treats the same version at the recorded commit as a
  // recovery rerun without consulting Git, so the release job can create the
  // missing tag and release idempotently.
  const gitCalls = [];
  assert.equal(assessReleaseVersion({
    currentVersion: "1.2.1",
    currentCommit: deployedSha,
    incomingVersion: "1.2.1",
    incomingCommit: deployedSha,
  }, (args) => { gitCalls.push(args); return { status: 0 }; }), "recovery");
  assert.equal(gitCalls.length, 0);
});

test("a deployed-but-untagged release is claimed by the next commit instead of deadlocking", () => {
  const previousSha = "1".repeat(40);
  const deployedUntaggedSha = "2".repeat(40);
  const nextSha = "5".repeat(40);
  // Commit A deployed as v1.2.1 but was never tagged. Fix commit B derives the
  // same next patch strictly from existing tags...
  assert.deepEqual(selectAutomaticRelease({ sourceSha: nextSha }, automaticGit({
    tags: ["v1.2.0"],
    commits: { "v1.2.0": previousSha },
  })), {
    tag: "v1.2.1",
    version: "1.2.1",
    prerelease: false,
  });
  // ...and the stack gate lets B take over the deployed-but-untagged version
  // because no tag ever published v1.2.1.
  assert.equal(assessReleaseVersion({
    currentVersion: "1.2.1",
    currentCommit: deployedUntaggedSha,
    incomingVersion: "1.2.1",
    incomingCommit: nextSha,
  }, tagExistenceGit(1)), "takeover");
  // Once v1.2.1 is tagged, the same version at another commit fails closed.
  assert.throws(() => assessReleaseVersion({
    currentVersion: "1.2.1",
    currentCommit: deployedUntaggedSha,
    incomingVersion: "1.2.1",
    incomingCommit: nextSha,
  }, tagExistenceGit(0)), /already tagged/);
  // Git failures while checking the tag also fail closed.
  assert.throws(() => assessReleaseVersion({
    currentVersion: "1.2.1",
    currentCommit: deployedUntaggedSha,
    incomingVersion: "1.2.1",
    incomingCommit: nextSha,
  }, tagExistenceGit(128)), /could not determine whether release tag/);
  assert.throws(() => assessReleaseVersion({
    currentVersion: "1.2.1",
    currentCommit: deployedUntaggedSha,
    incomingVersion: "1.2.1",
    incomingCommit: nextSha,
  }, () => ({ status: 0, error: new Error("spawn failed") })), /could not determine whether release tag/);
});

test("release workflow safely handles main and explicit tag push sources", () => {
  const trigger = releaseWorkflow.slice(
    releaseWorkflow.indexOf("on:"),
    releaseWorkflow.indexOf("permissions: {}"),
  );
  assert.match(trigger, /push:\n\s+branches:\n\s+- main\n\s+tags:\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(releaseWorkflow, /workflow_run/);
  assert.equal(releaseWorkflow.match(/fetch-depth: 0/g)?.length, 2);
  assert.equal(releaseWorkflow.match(/fetch-tags: true/g)?.length, 2);
  assert.equal(releaseWorkflow.match(/persist-credentials: false/g)?.length, 2);
  assert.equal(releaseWorkflow.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 2);

  for (const sourceGate of [
    '[[ "$EVENT_NAME" != "push" ]]',
    '[[ ! "$EVENT_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$REF_TYPE" == "branch" ]]',
    '[[ "$REF_NAME" != "$DEFAULT_BRANCH" ]]',
    '[[ "$head_sha" != "$EVENT_SHA" ]]',
    '[[ "$head_sha" != "$default_sha" ]]',
    '[[ "$REF_TYPE" == "tag" ]]',
    'git merge-base --is-ancestor "$tagged_sha" "$default_ref"',
  ]) {
    assert.ok(releaseWorkflow.includes(sourceGate), `Release must preserve source gate: ${sourceGate}`);
  }
  assert.match(releaseWorkflow, /npm run release:validate-tag -- --automatic "\$SOURCE_SHA"/);
  assert.match(releaseWorkflow, /npm run release:validate-tag -- "\$REF_NAME"/);
});

test("release workflow publishes only the validated tag after deploy and smoke gates", () => {
  assert.match(releaseWorkflow, /tag: \$\{\{ steps\.version\.outputs\.tag \}\}/);
  assert.match(releaseWorkflow, /RELEASE_TAG: \$\{\{ needs\.validate\.outputs\.tag \}\}/);
  assert.doesNotMatch(releaseWorkflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(releaseWorkflow, /target_commitish: sha/g);
  assert.match(releaseWorkflow, /git\.getRef/);
  assert.match(releaseWorkflow, /git\.getTag/);
  assert.match(releaseWorkflow, /repos\.getBranch\(\{ owner, repo, branch: defaultBranch \}\)/);
  assert.match(releaseWorkflow, /currentDefault\.data\.commit\.sha !== sha/);
  assert.match(releaseWorkflow, /if \(error\.status === 403\)/);
  assert.match(releaseWorkflow, /taggedCommit = await resolveTagCommit\(\)/);
  assert.match(releaseWorkflow, /latestDefault\.data\.commit\.sha !== sha/);
  assert.match(releaseWorkflow, /throw error;/);
  assert.match(releaseWorkflow, /the newer queued release owns tag and GitHub Release publication/);
  // The automatic tag is a lightweight Git ref created with the job-scoped
  // GITHUB_TOKEN; a rejected creation must fail the job loudly.
  assert.match(releaseWorkflow, /git\.createRef\(\{ owner, repo, ref: `refs\/tags\/\$\{tag\}`, sha \}\)/);
  assert.doesNotMatch(releaseWorkflow, /git\.createTag/);
  assert.match(releaseWorkflow, /else if \(error\.status === 422\)/);
  // The success path trusts the authoritative createRef response instead of an
  // immediate re-read that can lag replicas; the swallowed-422 path retries the
  // re-read and then surfaces the real rejection reason.
  assert.match(releaseWorkflow, /created\.object\.sha/);
  assert.match(releaseWorkflow, /creation was rejected: \$\{creationRejection\}/);
  assert.match(releaseWorkflow, /fix the tag rule or permissions, then rerun this job/);
  assert.match(releaseWorkflow, /Explicit release tag .* refusing to recreate it/);

  const smokeIndex = releaseWorkflow.indexOf("Smoke-test apex and www redirect");
  const releaseJobIndex = releaseWorkflow.indexOf("\n  release:");
  const finalFreshnessIndex = releaseWorkflow.indexOf("repos.getBranch", releaseJobIndex);
  const tagCreationIndex = releaseWorkflow.indexOf("git.createRef");
  const releaseCreationIndex = releaseWorkflow.indexOf("repos.createRelease");
  assert.ok(smokeIndex > 0);
  assert.ok(smokeIndex < releaseJobIndex);
  assert.ok(releaseJobIndex < finalFreshnessIndex);
  assert.ok(finalFreshnessIndex < tagCreationIndex);
  assert.ok(releaseJobIndex < tagCreationIndex);
  assert.ok(tagCreationIndex < releaseCreationIndex);
  assert.equal(releaseWorkflow.match(/contents: write/g)?.length, 1);
  assert.equal(releaseWorkflow.match(/id-token: write/g)?.length, 1);
  assert.match(releaseWorkflow, /permissions: \{\}/);
  assert.match(releaseWorkflow, /queue: max/);
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
  }, tagExistenceGit(0)), /commit already recorded/);
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

// The local development harness gates every offline stand-in on
// `isLocalPreviewOrigin(APP_ORIGIN)`. That gate is only as good as the deployed
// configuration, so the release invariants are the right place to hold it.
//
// Run the real predicate rather than asserting a property that happens to imply
// it today. Asserting the scheme was enough while only http qualified; now that
// https is how the local network is served, the scheme proves nothing, and a
// future widening of the host rules would pass a scheme check unnoticed.
test("the deployed Worker configuration cannot reach the local development harness", () => {
  const production = JSON.parse(readRepositoryFile("wrangler.jsonc").replaceAll(/^\s*\/\/.*$/gm, ""));

  assert.equal(production.main, "src/index.ts");
  assert.equal(production.vars.APP_ORIGIN, "https://quickducks.com");
  assert.equal(isLocalPreviewOrigin(production.vars.APP_ORIGIN), false);
  assert.equal(isLoopbackOrigin(production.vars.APP_ORIGIN), false);
});
