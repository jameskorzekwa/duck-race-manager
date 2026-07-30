import assert from "node:assert/strict";
import test from "node:test";

import { closingIssueNumbers, markerNumbers, questionAnswered, validExactCheck } from "../scripts/agent-pipeline.mjs";

test("a question resumes only on a James reply newer than the question", () => {
  const question = {
    user: { id: 41898282 },
    created_at: "2026-07-30T12:00:00Z",
    body: "<!-- agent-pipeline question=1 -->\nWhich policy applies?",
  };
  const earlierJames = { user: { id: 38769771 }, created_at: "2026-07-30T11:00:00Z", body: "context" };
  const bot = { user: { id: 41898282 }, created_at: "2026-07-30T13:00:00Z", body: "noise" };
  const answer = { user: { id: 38769771 }, created_at: "2026-07-30T14:00:00Z", body: "Use option B." };

  assert.equal(questionAnswered([earlierJames, question]), false);
  assert.equal(questionAnswered([earlierJames, question, bot]), false);
  assert.equal(questionAnswered([earlierJames, question, bot, answer]), true);
  assert.equal(questionAnswered([earlierJames, answer]), false);
});

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
