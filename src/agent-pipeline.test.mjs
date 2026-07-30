import assert from "node:assert/strict";
import test from "node:test";

import { closingIssueNumbers, markerNumbers, validExactCheck } from "../scripts/agent-pipeline.mjs";

test("closingIssueNumbers extracts unique durable closing references", () => {
  assert.deepEqual(closingIssueNumbers("Closes #12\nFixes #12\nResolved #30"), [12, 30]);
  assert.deepEqual(closingIssueNumbers("Related to #12"), []);
});

test("markerNumbers extracts comma-separated machine state", () => {
  const comments = [
    { body: "<!-- agent-pipeline blocked-by=4,9 -->" },
    { body: "Unrelated prose" },
  ];
  assert.deepEqual(markerNumbers(comments, "blocked-by"), [4, 9]);
  assert.deepEqual(markerNumbers(comments, "canonical-issue"), []);
});

test("validExactCheck accepts trusted-default-branch workflow dispatch", async () => {
  const github = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      repos: {
        listCommitStatusesForRef: async () => ({ data: [{
          context: "Agent Review / Exact SHA",
          creator: { id: 41898282 },
          state: "success",
          description: "agent-review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:123 Exact-head review approved",
          created_at: "2026-07-28T12:00:00Z",
        }] }),
      },
      actions: {
        getWorkflowRun: async () => ({ data: {
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          path: ".github/workflows/agent-review.yml",
        } }),
      },
    },
  };
  const pr = {
    base: { ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    head: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  };

  assert.equal(await validExactCheck(github, "owner", "repo", pr), true);
  github.rest.actions.getWorkflowRun = async () => ({ data: {
    event: "workflow_dispatch",
    head_branch: "feature",
    head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    path: ".github/workflows/agent-review.yml",
  } });
  assert.equal(await validExactCheck(github, "owner", "repo", pr), false);
});
