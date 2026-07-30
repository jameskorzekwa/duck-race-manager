import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { attemptDigests, TASK_RETRY_LIMIT } from "../scripts/agent-pipeline.mjs";
import { seedPaths, selectSeed } from "../scripts/seed-model-workspace.mjs";

const patch = Buffer.from("diff --git a/src/api.ts b/src/api.ts\n");
const digest = createHash("sha256").update(patch).digest("hex");
const metadata = { issue: 69, runId: "30497815237", digest, savedAtMs: 1000 };

test("a fresh patch for the same issue is resumed", () => {
  const decision = selectSeed({ metadata, patchBytes: patch, issue: 69, savedAtMs: 1000, now: 2000 });

  assert.equal(decision.use, true);
  assert.equal(decision.digest, digest);
  assert.match(decision.reason, /resuming issue #69 from 30497815237/);
});

test("a patch from another issue is never resumed", () => {
  const decision = selectSeed({ metadata, patchBytes: patch, issue: 70, savedAtMs: 1000, now: 2000 });

  assert.equal(decision.use, false);
  assert.match(decision.reason, /belongs to issue #69/);
});

test("a tampered or truncated patch is rejected by digest", () => {
  const decision = selectSeed({
    metadata,
    patchBytes: Buffer.from("diff --git a/.github/workflows/ci.yml b/x\n"),
    issue: 69,
    savedAtMs: 1000,
    now: 2000,
  });

  assert.equal(decision.use, false);
  assert.match(decision.reason, /digest does not match/);
});

test("a stale patch is discarded so a retry starts clean", () => {
  const eightDays = 8 * 24 * 60 * 60 * 1000;
  const decision = selectSeed({ metadata, patchBytes: patch, issue: 69, savedAtMs: 0, now: eightDays });

  assert.equal(decision.use, false);
  assert.match(decision.reason, /stale/);
});

test("an empty patch leaves nothing to resume", () => {
  assert.equal(selectSeed({ metadata, patchBytes: Buffer.alloc(0), issue: 69 }).use, false);
  assert.equal(selectSeed({ metadata: null, patchBytes: patch, issue: 69 }).use, false);
});

test("seed paths are scoped per issue inside the runner state root", () => {
  const paths = seedPaths("/state", 69);

  assert.equal(paths.patch, "/state/patches/issue-69.patch");
  assert.equal(paths.metadata, "/state/patches/issue-69.json");
});

test("reconciliation reads attempt digests and stops only on repeats", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const comments = [
    { body: `<!-- agent-pipeline run-failed=1 --> <!-- agent-pipeline attempt-digest=${first} -->` },
    { body: `<!-- agent-pipeline run-failed=2 --> <!-- agent-pipeline attempt-digest=${second} -->` },
  ];

  assert.deepEqual(attemptDigests(comments), [first, second]);
  assert.notEqual(attemptDigests(comments).at(-1), attemptDigests(comments).at(-2));

  const repeated = [...comments, { body: `<!-- agent-pipeline attempt-digest=${second} -->` }];
  assert.equal(attemptDigests(repeated).at(-1), attemptDigests(repeated).at(-2));
});

test("automatic retries iterate well past the old three-attempt ceiling", () => {
  assert.ok(TASK_RETRY_LIMIT >= 10, `expected room to iterate, got ${TASK_RETRY_LIMIT}`);
});
